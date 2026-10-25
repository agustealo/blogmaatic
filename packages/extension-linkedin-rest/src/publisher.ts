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
import { imageTransformSpecFromJson } from "@blogmaatic/media";
import { SecretAuthority } from "@blogmaatic/secrets";
import { adaptPublicationForSocial } from "@blogmaatic/variants";

import { compileLinkedInImage, renderLinkedInImage } from "./assets.js";
import { LinkedInHttpError, LinkedInRestClient } from "./client.js";
import {
  encodeRemoteVersion,
  fingerprint,
  parseRemoteVersion,
  remoteStateHash,
} from "./fingerprint.js";
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

function recordValue(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): Readonly<Record<string, JsonValue>> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

function destinationSocialVariant(
  publication: Publication,
  route: PublicationRoute,
  groupId: string | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!groupId) return undefined;
  const root = recordValue(publication.current.content.attributes, "destinationOverrides");
  const groups = root ? recordValue(root, "groups") : undefined;
  const group = groups ? recordValue(groups, groupId) : undefined;
  const routes = group ? recordValue(group, "routes") : undefined;
  const override = routes ? recordValue(routes, route.id) : undefined;
  const social = override ? recordValue(override, "socialVariant") : undefined;
  if (!social) return undefined;

  if (
    stringValue(override!, "extensionId") !== route.destination.extensionId ||
    stringValue(override!, "connectionId") !== route.destination.connectionId ||
    stringValue(override!, "channel") !== route.destination.channel ||
    stringValue(social, "extensionId") !== route.destination.extensionId ||
    stringValue(social, "connectionId") !== route.destination.connectionId ||
    stringValue(social, "channel") !== route.destination.channel
  ) {
    throw new Error("LinkedIn social variant identity does not match the compiled destination");
  }
  return social;
}

function projectionMode(route: PublicationRoute): LinkedInProjectionMode {
  const mode = stringValue(variant(route), "mode") ?? "text";
  if (mode !== "text" && mode !== "article" && mode !== "image") {
    throw new Error(`Unsupported LinkedIn route.variant.mode: ${mode}`);
  }
  return mode;
}

function desiredSemantic(
  settings: LinkedInSettings,
  payload: Pick<LinkedInProjectionPayload, "commentary" | "article" | "image">,
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
    image: payload.image
      ? {
          assetId: payload.image.assetId,
          mediaType: payload.image.mediaType,
          alt: payload.image.alt ?? null,
          fingerprint: payload.image.fingerprint,
          transformFingerprint: payload.image.transform?.transformationFingerprint ?? null,
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
    image: post.content?.media
      ? {
          id: post.content.media.id ?? null,
          title: post.content.media.title ?? null,
          altText: post.content.media.altText ?? null,
        }
      : null,
  };
}

function remoteIdentity(post: LinkedInPostRecord, version?: string): RemoteIdentity {
  return {
    id: post.id,
    url: `https://www.linkedin.com/feed/update/${post.id}`,
    ...(version
      ? { version }
      : typeof post.lastModifiedAt === "number"
        ? { version: String(post.lastModifiedAt) }
        : {}),
  };
}

function postPath(id: string): string {
  if (!/^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid LinkedIn remote post id: ${id}`);
  }
  return `/posts/${encodeURIComponent(id)}?viewContext=AUTHOR`;
}

function creationBody(
  settings: LinkedInSettings,
  payload: LinkedInProjectionPayload,
  imageUrn?: string,
): Readonly<Record<string, unknown>> {
  return {
    author: settings.authorUrn,
    commentary: payload.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    ...(imageUrn && payload.image
      ? {
          content: {
            media: {
              id: imageUrn,
              ...(payload.image.alt ? { altText: payload.image.alt } : {}),
            },
          },
        }
      : payload.article
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

interface LinkedInImageInitializeResponse {
  readonly value?: {
    readonly uploadUrl?: string;
    readonly image?: string;
  };
}

interface LinkedInImageStatusResponse {
  readonly id?: string;
  readonly status?: string;
  readonly owner?: string;
}

async function initializeImage(
  client: LinkedInRestClient,
  settings: LinkedInSettings,
): Promise<{ readonly uploadUrl: string; readonly imageUrn: string }> {
  const response = await client.request<LinkedInImageInitializeResponse>("/images?action=initializeUpload", {
    method: "POST",
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: settings.authorUrn,
      },
    }),
  });
  const uploadUrl = response.body.value?.uploadUrl;
  const imageUrn = response.body.value?.image;
  if (!uploadUrl || !imageUrn || !/^urn:li:image:[A-Za-z0-9_-]+$/.test(imageUrn)) {
    throw new Error("LinkedIn image initialize response is missing a valid uploadUrl/image URN");
  }
  return { uploadUrl, imageUrn };
}

async function waitForImageAvailable(
  client: LinkedInRestClient,
  settings: LinkedInSettings,
  imageUrn: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await client.request<LinkedInImageStatusResponse>(
      `/images/${encodeURIComponent(imageUrn)}`,
    );
    if (response.body.owner && response.body.owner !== settings.authorUrn) {
      throw new Error("LinkedIn uploaded image belongs to a different owner");
    }
    if (response.body.status === "AVAILABLE") return;
    if (response.body.status === "PROCESSING_FAILED") {
      throw new Error("LinkedIn image processing failed");
    }
    if (!["WAITING_UPLOAD", "PROCESSING"].includes(response.body.status ?? "")) {
      throw new Error(`LinkedIn image returned unexpected status: ${String(response.body.status ?? "missing")}`);
    }
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("LinkedIn image did not become AVAILABLE before the verification deadline");
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
      "asset.publish",
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
    groupId,
  }: {
    publication: Publication;
    route: PublicationRoute;
    groupId?: string;
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
    const social = destinationSocialVariant(publication, route, groupId);
    const inheritedMode = projectionMode(route);
    const mediaMode = social ? stringValue(social, "mediaMode") : undefined;
    if (mediaMode !== undefined && !["inherit", "none", "select"].includes(mediaMode)) {
      throw new Error(`Unsupported LinkedIn social media mode: ${mediaMode}`);
    }
    const mode: LinkedInProjectionMode = mediaMode === "select"
      ? "image"
      : mediaMode === "none" && inheritedMode === "image"
        ? "text"
        : inheritedMode;
    const adapted = adaptPublicationForSocial(
      publication,
      {
        id: LINKEDIN_REST_EXTENSION_ID,
        maxCommentaryChars: 3000,
        maxImages: mode === "image" ? 1 : 0,
        supportsArticleCard: mode === "article",
        supportedBlockKinds: ["paragraph"],
      },
      {
        mode: mode === "article" ? "article" : "text",
        includeTitle: booleanValue(routeVariant, "includeTitle") ?? true,
        includeSummary: booleanValue(routeVariant, "includeSummary") ?? false,
        includeCanonicalUrl:
          booleanValue(routeVariant, "includeCanonicalUrl") ?? (mode !== "article"),
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

    const commentaryMode = social ? stringValue(social, "commentaryMode") : undefined;
    if (commentaryMode !== undefined && commentaryMode !== "inherit" && commentaryMode !== "override") {
      throw new Error(`Unsupported LinkedIn social commentary mode: ${commentaryMode}`);
    }
    const commentary = commentaryMode === "override"
      ? stringValue(social!, "commentary")?.trim()
      : adapted.commentary;
    if (!commentary) throw new Error("LinkedIn commentary override is missing commentary");
    if (commentary.length > 3000) throw new Error("LinkedIn commentary override exceeds 3000 characters");

    let image: LinkedInProjectionPayload["image"];
    if (mode === "image") {
      let selected = adapted.imageAssets;
      if (mediaMode === "select") {
        const rawIds = social?.imageAssetIds;
        if (!Array.isArray(rawIds) || rawIds.length !== 1 || typeof rawIds[0] !== "string" || !rawIds[0].trim()) {
          throw new Error("LinkedIn single-image social selection requires exactly one imageAssetId");
        }
        const id = rawIds[0].trim();
        const asset = publication.current.content.assets.find((candidate) => candidate.id === id);
        if (!asset) throw new Error(`LinkedIn selected image asset does not exist: ${id}`);
        selected = [asset];
      }
      if (selected.length !== 1) {
        throw new Error("LinkedIn image mode requires exactly one canonical image");
      }
      image = await compileLinkedInImage(
        selected[0]!,
        settings,
        imageTransformSpecFromJson(routeVariant.imageTransform),
      );
    }

    const payload: LinkedInProjectionPayload = {
      mode,
      commentary,
      ...(mode === "article" && adapted.article ? { article: adapted.article } : {}),
      ...(image ? { image } : {}),
      fidelity: adapted.fidelity,
    };
    const hash = fingerprint(desiredSemantic(settings, payload));
    return {
      projectionId: `${publication.id}:${groupId ?? "legacy"}:${route.id}`,
      ...(groupId ? { groupId } : {}),
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
      const baseline = parseRemoteVersion(input.remote.version);
      const remoteHash = remoteStateHash(post);
      const remote = remoteIdentity(post, input.remote.version);
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
      if (payload.image && !baseline) {
        return {
          state: "drifted",
          remote,
          fingerprint: remoteHash,
          observedAt,
          detail: "LinkedIn image projection lacks a verified Blogmaatic media baseline",
        };
      }
      if (baseline) {
        const mediaMatches = payload.image
          ? baseline.mediaFingerprint === payload.image.fingerprint &&
            baseline.mediaUrn === post.content?.media?.id
          : baseline.mediaFingerprint === undefined && post.content?.media === undefined;
        const synchronized =
          baseline.desired === input.projection.fingerprint &&
          baseline.remote === remoteHash &&
          mediaMatches;
        return {
          state: synchronized ? "synchronized" : "drifted",
          remote,
          fingerprint: synchronized ? input.projection.fingerprint : baseline.desired,
          observedAt,
          detail: synchronized
            ? "LinkedIn projection matches its verified Blogmaatic baseline"
            : "LinkedIn post, media, or desired projection changed after verified delivery",
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
      let imageUrn: string | undefined;
      let mediaEvidence: Readonly<Record<string, JsonValue>> | undefined;
      if (payload.image) {
        const rendered = await renderLinkedInImage(payload.image);
        const initialized = await initializeImage(client, settings);
        await client.uploadImageBytes(initialized.uploadUrl, rendered.bytes, rendered.mediaType);
        await waitForImageAvailable(client, settings, initialized.imageUrn);
        imageUrn = initialized.imageUrn;
        mediaEvidence = {
          assetId: payload.image.assetId,
          imageUrn,
          transformationFingerprint: payload.image.transform?.transformationFingerprint ?? null,
          derivedAssetId: payload.image.transform?.derivedAssetId ?? null,
          outputFingerprint: rendered.outputFingerprint,
          mediaType: rendered.mediaType,
          width: rendered.width,
          height: rendered.height,
          cacheHit: rendered.cacheHit,
        };
      }

      const response = await client.request<unknown>("/posts", {
        method: "POST",
        body: JSON.stringify(creationBody(settings, payload, imageUrn)),
      });
      const id = response.headers.get("x-restli-id");
      if (!id) throw new Error("LinkedIn create response did not include x-restli-id");
      const created = await fetchPost(client, id);
      const remoteHash = remoteStateHash(created);
      const version = encodeRemoteVersion(
        request.projection.fingerprint,
        remoteHash,
        payload.image?.fingerprint,
        imageUrn,
      );
      const remote = remoteIdentity(created, version);
      return {
        remote,
        acceptedAt: new Date().toISOString(),
        evidence: {
          operation: "create",
          apiVersion: settings.apiVersion,
          fidelityScore: payload.fidelity.score,
          fidelityExact: payload.fidelity.exact,
          ...(mediaEvidence ? { media: mediaEvidence as JsonValue } : {}),
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

    const baseline = parseRemoteVersion(request.existingRemote.version);
    if (baseline && baseline.remote !== remoteStateHash(current)) {
      throw new Error("LinkedIn remote state changed after the last verified delivery");
    }
    if (payload.image) {
      if (
        !baseline ||
        baseline.mediaFingerprint !== payload.image.fingerprint ||
        !baseline.mediaUrn ||
        current.content?.media?.id !== baseline.mediaUrn
      ) {
        throw new Error(
          "LinkedIn image content changed and cannot be updated safely in place; create a new publication route or restore the prior media selection",
        );
      }
    } else if (current.content?.media) {
      throw new Error(
        "LinkedIn remote post contains media that is absent from the desired projection",
      );
    }

    if (!baseline) {
      const currentSemantic = remoteSemantic(current) as Readonly<Record<string, unknown>>;
      const desired = desiredSemantic(settings, payload) as Readonly<Record<string, unknown>>;
      const structuralCurrent = { ...currentSemantic, commentary: payload.commentary };
      if (fingerprint(structuralCurrent) !== fingerprint(desired)) {
        throw new Error(
          "LinkedIn remote state differs in fields that the Posts API does not safely update in place",
        );
      }
    }

    const commentaryChanged = current.commentary !== payload.commentary;
    if (commentaryChanged) {
      await client.request<unknown>(`/posts/${encodeURIComponent(request.existingRemote.id)}`, {
        method: "POST",
        headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
        body: JSON.stringify({ patch: { $set: { commentary: payload.commentary } } }),
      });
    }

    const verified = commentaryChanged
      ? await fetchPost(client, request.existingRemote.id)
      : current;
    const mediaUrn = payload.image ? baseline?.mediaUrn : undefined;
    const version = encodeRemoteVersion(
      request.projection.fingerprint,
      remoteStateHash(verified),
      payload.image?.fingerprint,
      mediaUrn,
    );
    return {
      remote: remoteIdentity(verified, version),
      acceptedAt: new Date().toISOString(),
      evidence: {
        operation: commentaryChanged ? "commentary-update" : "noop-update",
        apiVersion: settings.apiVersion,
        fidelityScore: payload.fidelity.score,
        fidelityExact: payload.fidelity.exact,
        ...(mediaUrn ? { imageUrn: mediaUrn } : {}),
        idempotencyKey: request.idempotencyKey,
      },
    };
  }
}
