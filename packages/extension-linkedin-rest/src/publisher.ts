import type {
  CompiledProjection,
  DeliveryRequest,
  DeliveryResult,
  InspectProjectionInput,
  JsonValue,
  ObservedProjection,
  Publication,
  PublicationRoute,
  RemoteIdentity,
} from "@blogmaatic/core";
import {
  ConnectionAuthority,
  type ConnectionRecord,
  type ConnectionValidation,
  type ExtensionHealth,
  type ManagedPublisherExtension,
} from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";
import { adaptPublicationForSocial } from "@blogmaatic/variants";

import { LinkedInHttpError, LinkedInRestClient } from "./client.js";
import { fingerprint } from "./fingerprint.js";
import { parsePayload } from "./payload.js";
import { LINKEDIN_REST_EXTENSION_ID, parseSettings } from "./settings.js";
import type {
  LinkedInPostRecord,
  LinkedInProjectionMode,
  LinkedInProjectionPayload,
  LinkedInSettings,
} from "./types.js";

function variant(route: PublicationRoute): Readonly<Record<string, JsonValue>> {
  return route.variant ?? {};
}

function stringValue(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function booleanValue(record: Readonly<Record<string, JsonValue>>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(record: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectionMode(route: PublicationRoute): LinkedInProjectionMode {
  const mode = stringValue(variant(route), "mode") ?? "text";
  if (mode !== "text" && mode !== "article") {
    throw new Error(`Unsupported LinkedIn route.variant.mode: ${mode}`);
  }
  return mode;
}

function desiredSemantic(
  settings: LinkedInSettings,
  payload: Pick<LinkedInProjectionPayload, "commentary" | "article">,
): unknown {
  return {
    author: settings.authorUrn,
    commentary: payload.commentary,
    visibility: "PUBLIC",
    lifecycleState: "PUBLISHED",
    feedDistribution: "MAIN_FEED",
    article: payload.article
      ? {
          source: payload.article.source,
          title: payload.article.title,
          description: payload.article.description ?? null,
        }
      : null,
  };
}

function remoteSemantic(post: LinkedInPostRecord): unknown {
  const article = post.content?.article;
  return {
    author: post.author,
    commentary: post.commentary,
    visibility: post.visibility ?? null,
    lifecycleState: post.lifecycleState ?? null,
    feedDistribution: post.distribution?.feedDistribution ?? null,
    article: article
      ? {
          source: article.source ?? null,
          title: article.title ?? null,
          description: article.description ?? null,
        }
      : null,
  };
}

function remoteIdentity(post: LinkedInPostRecord): RemoteIdentity {
  return {
    id: post.id,
    url: `https://www.linkedin.com/feed/update/${post.id}`,
    ...(typeof post.lastModifiedAt === "number" ? { version: String(post.lastModifiedAt) } : {}),
  };
}

function postPath(id: string): string {
  if (!/^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid LinkedIn remote post id: ${id}`);
  }
  return `/posts/${encodeURIComponent(id)}?viewContext=AUTHOR`;
}

function creationBody(settings: LinkedInSettings, payload: LinkedInProjectionPayload): Readonly<Record<string, unknown>> {
  return {
    author: settings.authorUrn,
    commentary: payload.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    ...(payload.article
      ? {
          content: {
            article: {
              source: payload.article.source,
              title: payload.article.title,
              ...(payload.article.description ? { description: payload.article.description } : {}),
            },
          },
        }
      : {}),
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}

async function fetchPost(client: LinkedInRestClient, id: string): Promise<LinkedInPostRecord> {
  const response = await client.request<LinkedInPostRecord>(postPath(id));
  return response.body;
}

function articleStructureMatches(post: LinkedInPostRecord, payload: LinkedInProjectionPayload): boolean {
  const actual = post.content?.article;
  if (!payload.article) return actual === undefined;
  return Boolean(
    actual &&
      actual.source === payload.article.source &&
      actual.title === payload.article.title &&
      (actual.description ?? "") === (payload.article.description ?? ""),
  );
}

export class LinkedInRestPublisher implements ManagedPublisherExtension {
  readonly manifest = {
    apiVersion: 1,
    kind: "publisher",
    connectionSchemaVersion: 1,
    id: LINKEDIN_REST_EXTENSION_ID,
    displayName: "LinkedIn REST",
    version: "0.1.0",
    capabilities: [
      "article.create",
      "article.update",
      "article.inspect",
      "canonical.publish",
    ],
  } as const;

  readonly #connections: ConnectionAuthority;
  readonly #secrets: SecretAuthority;

  constructor(connections: ConnectionAuthority, secrets: SecretAuthority) {
    this.#connections = connections;
    this.#secrets = secrets;
  }

  async validateConnection(connection: ConnectionRecord): Promise<ConnectionValidation> {
    const errors: string[] = [];
    try {
      const settings = parseSettings(connection);
      this.#secrets.validateReference(settings.accessTokenRef);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { valid: errors.length === 0, errors };
  }

  async checkHealth(connection: ConnectionRecord): Promise<ExtensionHealth> {
    const checkedAt = new Date().toISOString();
    const validation = await this.validateConnection(connection);
    if (!validation.valid) {
      return { state: "unhealthy", checkedAt, detail: validation.errors.join("; ") };
    }
    try {
      const settings = parseSettings(connection);
      const client = new LinkedInRestClient(connection, settings, this.#secrets);
      await client.request<{ readonly elements?: readonly LinkedInPostRecord[] }>(
        `/posts?author=${encodeURIComponent(settings.authorUrn)}&q=author&count=1&sortBy=LAST_MODIFIED`,
      );
      return {
        state: "healthy",
        checkedAt,
        detail: "LinkedIn organization post read/write surface is reachable",
        evidence: {
          authorUrn: settings.authorUrn,
          apiVersion: settings.apiVersion,
        },
      };
    } catch (error) {
      return {
        state: "unhealthy",
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compile({
    publication,
    route,
  }: {
    publication: Publication;
    route: PublicationRoute;
  }): Promise<CompiledProjection> {
    if (route.destination.channel !== "posts") {
      throw new Error(`LinkedIn v0.1 supports only the posts channel, got: ${route.destination.channel}`);
    }
    const connection = this.#connections.requireActive(
      LINKEDIN_REST_EXTENSION_ID,
      route.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const routeVariant = variant(route);
    const mode = projectionMode(route);
    const adapted = adaptPublicationForSocial(
      publication,
      {
        id: LINKEDIN_REST_EXTENSION_ID,
        maxCommentaryChars: 3000,
        maxImages: 0,
        supportsArticleCard: mode === "article",
        supportedBlockKinds: ["paragraph"],
      },
      {
        mode,
        includeTitle: booleanValue(routeVariant, "includeTitle") ?? true,
        includeSummary: booleanValue(routeVariant, "includeSummary") ?? false,
        includeCanonicalUrl:
          booleanValue(routeVariant, "includeCanonicalUrl") ?? (mode === "text"),
        includeHashtags: booleanValue(routeVariant, "includeHashtags") ?? true,
        maxHashtags: Math.max(0, Math.trunc(numberValue(routeVariant, "maxHashtags") ?? 5)),
        overflow: stringValue(routeVariant, "overflow") === "error" ? "error" : "truncate",
      },
    );
    const minFidelity = numberValue(routeVariant, "minFidelity") ?? 0;
    if (minFidelity < 0 || minFidelity > 100) {
      throw new Error("LinkedIn route.variant.minFidelity must be between 0 and 100");
    }
    if (adapted.fidelity.score < minFidelity) {
      throw new Error(
        `LinkedIn projection fidelity ${adapted.fidelity.score} is below required minimum ${minFidelity}`,
      );
    }
    if (mode === "article" && !adapted.article) {
      throw new Error("LinkedIn article mode requires a canonical publication URL");
    }

    const payload: LinkedInProjectionPayload = {
      mode,
      commentary: adapted.commentary,
      ...(adapted.article ? { article: adapted.article } : {}),
      fidelity: adapted.fidelity,
    };
    const hash = fingerprint(desiredSemantic(settings, payload));
    return {
      projectionId: `${publication.id}:${route.id}`,
      publicationId: publication.id,
      sourceRevisionId: publication.current.id,
      routeId: route.id,
      destination: route.destination,
      payload: payload as unknown as JsonValue,
      fingerprint: hash,
    };
  }

  async inspect(input: InspectProjectionInput): Promise<ObservedProjection> {
    const observedAt = new Date().toISOString();
    const connection = this.#connections.requireActive(
      LINKEDIN_REST_EXTENSION_ID,
      input.projection.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const payload = parsePayload(input.projection);

    if (!input.remote) {
      return {
        state: "missing",
        observedAt,
        detail: "No stored LinkedIn remote identity exists for this projection",
      };
    }

    const client = new LinkedInRestClient(connection, settings, this.#secrets);
    try {
      const post = await fetchPost(client, input.remote.id);
      const remote = remoteIdentity(post);
      if (post.author !== settings.authorUrn) {
        return {
          state: "unreachable",
          remote,
          observedAt,
          detail: "Stored LinkedIn post belongs to a different author; refusing mutation",
        };
      }
      if (payload.article && post.content?.article?.source !== payload.article.source) {
        return {
          state: "unreachable",
          remote,
          observedAt,
          detail: "Stored LinkedIn article source no longer matches this publication",
        };
      }
      const actual = fingerprint(remoteSemantic(post));
      const synchronized = actual === input.projection.fingerprint;
      return {
        state: synchronized ? "synchronized" : "drifted",
        remote,
        fingerprint: actual,
        observedAt,
        detail: synchronized
          ? "LinkedIn projection matches the desired publication"
          : "LinkedIn projection differs from the desired publication",
      };
    } catch (error) {
      if (error instanceof LinkedInHttpError && error.status === 404) {
        return { state: "missing", observedAt, detail: "Stored LinkedIn post no longer exists" };
      }
      return {
        state: "unreachable",
        remote: input.remote,
        observedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const connection = this.#connections.requireActive(
      LINKEDIN_REST_EXTENSION_ID,
      request.projection.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const payload = parsePayload(request.projection);
    const client = new LinkedInRestClient(connection, settings, this.#secrets);

    if (!request.existingRemote) {
      const response = await client.request<unknown>("/posts", {
        method: "POST",
        body: JSON.stringify(creationBody(settings, payload)),
      });
      const id = response.headers.get("x-restli-id");
      if (!id) throw new Error("LinkedIn create response did not include x-restli-id");
      const remote: RemoteIdentity = {
        id,
        url: `https://www.linkedin.com/feed/update/${id}`,
      };
      return {
        remote,
        acceptedAt: new Date().toISOString(),
        evidence: {
          operation: "create",
          apiVersion: settings.apiVersion,
          fidelityScore: payload.fidelity.score,
          fidelityExact: payload.fidelity.exact,
          idempotencyKey: request.idempotencyKey,
        },
      };
    }

    const current = await fetchPost(client, request.existingRemote.id);
    if (current.author !== settings.authorUrn) {
      throw new Error("Stored LinkedIn post belongs to a different author; refusing update");
    }
    if (!articleStructureMatches(current, payload)) {
      throw new Error(
        "LinkedIn structural post content drift cannot be updated safely in place; create a new publication route or repair the remote post explicitly",
      );
    }
    const currentSemantic = remoteSemantic(current) as Readonly<Record<string, unknown>>;
    const desired = desiredSemantic(settings, payload) as Readonly<Record<string, unknown>>;
    const structuralCurrent = { ...currentSemantic, commentary: payload.commentary };
    if (fingerprint(structuralCurrent) !== fingerprint(desired)) {
      throw new Error(
        "LinkedIn remote state differs in fields that the Posts API does not safely update in place",
      );
    }
    if (current.commentary !== payload.commentary) {
      await client.request<unknown>(`/posts/${encodeURIComponent(request.existingRemote.id)}`, {
        method: "POST",
        headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
        body: JSON.stringify({ patch: { $set: { commentary: payload.commentary } } }),
      });
    }
    return {
      remote: request.existingRemote,
      acceptedAt: new Date().toISOString(),
      evidence: {
        operation: current.commentary === payload.commentary ? "noop-update" : "commentary-update",
        apiVersion: settings.apiVersion,
        fidelityScore: payload.fidelity.score,
        fidelityExact: payload.fidelity.exact,
        idempotencyKey: request.idempotencyKey,
      },
    };
  }
}
