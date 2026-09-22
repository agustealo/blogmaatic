import type {
  CompiledProjection,
  DeliveryRequest,
  DeliveryResult,
  InspectProjectionInput,
  JsonValue,
  ObservedProjection,
  Publication,
  PublicationBlockKind,
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

import { compileFacebookAssets, localAssetBlob } from "./assets.js";
import { FacebookGraphClient, FacebookGraphError } from "./client.js";
import {
  encodeRemoteVersion,
  parseRemoteVersion,
  remoteStateHash,
  sha256,
  stableJson,
} from "./fingerprint.js";
import {
  DEFAULT_FACEBOOK_GRAPH_VERSION,
  FACEBOOK_PAGES_EXTENSION_ID,
  parseSettings,
} from "./settings.js";
import type {
  FacebookAssetSpec,
  FacebookPostRecord,
  FacebookProjectionMode,
  FacebookProjectionPayload,
  FacebookSettings,
} from "./types.js";

const SOCIAL_BLOCKS: readonly PublicationBlockKind[] = [
  "heading", "paragraph", "image", "gallery", "quote", "code", "embed", "table", "callout",
];

function variant(route: PublicationRoute): Readonly<Record<string, JsonValue>> {
  return route.variant ?? {};
}

function getString(record: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getBoolean(record: Readonly<Record<string, JsonValue>>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getNumber(record: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function desiredMode(publication: Publication, route: PublicationRoute): FacebookProjectionMode {
  const explicit = getString(variant(route), "mode");
  if (explicit) {
    if (explicit !== "text" && explicit !== "link" && explicit !== "image") {
      throw new Error(`Unsupported Facebook projection mode: ${explicit}`);
    }
    return explicit;
  }
  if (publication.canonicalUrl) return "link";
  if (publication.current.content.assets.some((asset) => asset.kind === "image")) return "image";
  return "text";
}

function scheduledAt(route: PublicationRoute): string | undefined {
  const value = getString(variant(route), "scheduledAt");
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid Facebook scheduledAt: ${value}`);
  return parsed.toISOString();
}

function semanticPayload(payload: FacebookProjectionPayload): unknown {
  return {
    mode: payload.mode,
    message: payload.message,
    link: payload.link ?? null,
    scheduledAt: payload.scheduledAt ?? null,
    images: payload.images.map((asset) => ({
      assetId: asset.assetId,
      source: asset.localPath ? "managed-local" : asset.source,
      mediaType: asset.mediaType ?? null,
      alt: asset.alt ?? null,
      fingerprint: asset.fingerprint ?? null,
    })),
  };
}

function payloadFromProjection(projection: CompiledProjection): FacebookProjectionPayload {
  const value = projection.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Facebook projection payload must be an object");
  }
  return value as unknown as FacebookProjectionPayload;
}

function remoteIdentity(post: FacebookPostRecord, version?: string): RemoteIdentity {
  return {
    id: post.id,
    ...(post.permalink_url ? { url: post.permalink_url } : {}),
    ...(version ? { version } : {}),
  };
}

function postFields(): string {
  return "id,message,permalink_url,created_time,updated_time,link,is_published,scheduled_publish_time,attachments{media_type,url,target,subattachments}";
}

async function fetchPost(
  client: FacebookGraphClient,
  remoteId: string,
): Promise<FacebookPostRecord> {
  return client.getJson<FacebookPostRecord>(remoteId, { fields: postFields() });
}

async function uploadImage(
  client: FacebookGraphClient,
  settings: FacebookSettings,
  asset: FacebookAssetSpec,
  scheduled: boolean,
): Promise<string> {
  const common: Record<string, string> = { published: "false" };
  if (scheduled) common.temporary = "true";
  if (asset.localPath) {
    const form = new FormData();
    for (const [key, value] of Object.entries(common)) form.set(key, value);
    form.set("source", await localAssetBlob(asset), `${asset.assetId}.${asset.mediaType === "image/png" ? "png" : "jpg"}`);
    const uploaded = await client.postMultipart<{ readonly id: string }>(`${settings.pageId}/photos`, form);
    return uploaded.id;
  }
  const uploaded = await client.postForm<{ readonly id: string }>(`${settings.pageId}/photos`, {
    ...common,
    url: asset.source,
  });
  return uploaded.id;
}

export class FacebookPagesPublisher implements ManagedPublisherExtension {
  readonly manifest = {
    apiVersion: 1,
    kind: "publisher",
    connectionSchemaVersion: 1,
    id: FACEBOOK_PAGES_EXTENSION_ID,
    displayName: "Facebook Pages",
    version: "0.1.0",
    capabilities: [
      "article.create",
      "article.inspect",
      "article.schedule",
      "asset.publish",
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
      this.#secrets.validateReference(settings.pageAccessTokenRef);
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
      const client = new FacebookGraphClient(connection, settings, this.#secrets);
      const page = await client.getJson<{ readonly id: string; readonly name?: string }>(settings.pageId, {
        fields: "id,name",
      });
      await client.getJson<{ readonly data?: readonly unknown[] }>(`${settings.pageId}/feed`, {
        fields: "id",
        limit: "1",
      });
      if (page.id !== settings.pageId) throw new Error("Facebook Page token resolved to an unexpected Page");
      return {
        state: "healthy",
        checkedAt,
        detail: "Facebook Page identity and readable feed are available",
        evidence: {
          pageId: page.id,
          pageName: page.name ?? "",
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

  async compile({ publication, route }: { publication: Publication; route: PublicationRoute }): Promise<CompiledProjection> {
    const connection = this.#connections.requireActive(FACEBOOK_PAGES_EXTENSION_ID, route.destination.connectionId);
    const settings = parseSettings(connection);
    const mode = desiredMode(publication, route);
    if (mode === "link" && !publication.canonicalUrl) {
      throw new Error("Facebook link mode requires publication.canonicalUrl");
    }
    const maxImages = Math.max(0, Math.min(10, Math.trunc(getNumber(variant(route), "maxImages") ?? 10)));
    const profile = {
      id: "facebook-pages",
      maxCommentaryChars: 63000,
      maxImages: mode === "image" ? maxImages : 0,
      supportsArticleCard: true,
      supportedBlockKinds: SOCIAL_BLOCKS,
    } as const;
    const adapted = adaptPublicationForSocial(publication, profile, {
      mode: mode === "link" ? "article" : "text",
      includeTitle: getBoolean(variant(route), "includeTitle") ?? true,
      includeSummary: getBoolean(variant(route), "includeSummary") ?? false,
      includeCanonicalUrl: mode === "link" ? false : (getBoolean(variant(route), "includeCanonicalUrl") ?? true),
      includeHashtags: getBoolean(variant(route), "includeHashtags") ?? false,
      maxHashtags: Math.trunc(getNumber(variant(route), "maxHashtags") ?? 5),
      overflow: getString(variant(route), "overflow") === "error" ? "error" : "truncate",
    });
    const minimumFidelity = getNumber(variant(route), "minimumFidelity") ?? 0;
    if (minimumFidelity < 0 || minimumFidelity > 100) {
      throw new Error("Facebook minimumFidelity must be between 0 and 100");
    }
    if (adapted.fidelity.score < minimumFidelity) {
      throw new Error(`Facebook projection fidelity ${adapted.fidelity.score} is below required ${minimumFidelity}`);
    }
    const images = mode === "image"
      ? await compileFacebookAssets(adapted.imageAssets, settings)
      : [];
    if (mode === "image" && images.length === 0) {
      throw new Error("Facebook image mode requires at least one image in the publication projection");
    }
    const schedule = scheduledAt(route);
    const payload: FacebookProjectionPayload = {
      mode,
      message: adapted.commentary,
      ...(mode === "link" && adapted.article ? { link: adapted.article.source } : {}),
      images,
      fidelity: adapted.fidelity,
      ...(schedule ? { scheduledAt: schedule } : {}),
    };
    const fingerprint = sha256(stableJson(semanticPayload(payload)));
    return {
      projectionId: `${publication.id}:${route.id}`,
      publicationId: publication.id,
      sourceRevisionId: publication.current.id,
      routeId: route.id,
      destination: route.destination,
      payload: payload as unknown as JsonValue,
      fingerprint,
    };
  }

  async inspect({ projection, remote }: InspectProjectionInput): Promise<ObservedProjection> {
    const observedAt = new Date().toISOString();
    if (!remote) return { state: "missing", observedAt, detail: "No Facebook remote identity is recorded" };
    const connection = this.#connections.requireActive(FACEBOOK_PAGES_EXTENSION_ID, projection.destination.connectionId);
    const settings = parseSettings(connection);
    const client = new FacebookGraphClient(connection, settings, this.#secrets);
    try {
      const post = await fetchPost(client, remote.id);
      const currentHash = remoteStateHash(post);
      const baseline = parseRemoteVersion(remote.version);
      if (!baseline) {
        return {
          state: "drifted",
          remote: remoteIdentity(post, remote.version),
          fingerprint: "unknown-baseline",
          observedAt,
          detail: "Facebook remote identity lacks a Blogmaatic verification baseline",
        };
      }
      const synchronized = baseline.desired === projection.fingerprint && baseline.remote === currentHash;
      return {
        state: synchronized ? "synchronized" : "drifted",
        remote: remoteIdentity(post, remote.version),
        fingerprint: synchronized ? projection.fingerprint : baseline.desired,
        observedAt,
        detail: synchronized
          ? "Facebook Page post matches its verified Blogmaatic projection"
          : "Facebook Page post or desired projection changed after the last verified delivery",
      };
    } catch (error) {
      if (error instanceof FacebookGraphError && error.status === 404) {
        return { state: "missing", observedAt, detail: "Recorded Facebook Page post no longer exists" };
      }
      return {
        state: "unreachable",
        remote,
        observedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  planDriftReconciliation(): { action: "blocked"; reason: string } {
    return {
      action: "blocked",
      reason: "Facebook Graph API v26.0 does not expose a safe general in-place update contract for Page Post projections; manual replacement policy is required",
    };
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    if (request.existingRemote) {
      throw new Error("Facebook Pages publisher refuses automatic replacement of an existing drifted post");
    }
    const payload = payloadFromProjection(request.projection);
    const connection = this.#connections.requireActive(FACEBOOK_PAGES_EXTENSION_ID, request.projection.destination.connectionId);
    const settings = parseSettings(connection);
    const client = new FacebookGraphClient(connection, settings, this.#secrets);
    const isScheduled = Boolean(payload.scheduledAt);
    const photoIds: string[] = [];
    if (payload.mode === "image") {
      for (const asset of payload.images) {
        photoIds.push(await uploadImage(client, settings, asset, isScheduled));
      }
    }
    const params: Record<string, string> = { message: payload.message };
    if (payload.mode === "link" && payload.link) params.link = payload.link;
    photoIds.forEach((id, index) => {
      params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
    });
    if (payload.scheduledAt) {
      params.published = "false";
      params.scheduled_publish_time = String(Math.floor(new Date(payload.scheduledAt).getTime() / 1000));
      params.unpublished_content_type = "SCHEDULED";
    }
    const created = await client.postForm<{ readonly id: string }>(`${settings.pageId}/feed`, params);
    const post = await fetchPost(client, created.id);
    const currentHash = remoteStateHash(post);
    const remote = remoteIdentity(post, encodeRemoteVersion(request.projection.fingerprint, currentHash));
    return {
      remote,
      acceptedAt: new Date().toISOString(),
      evidence: {
        mode: payload.mode,
        apiVersion: settings.apiVersion,
        imageCount: photoIds.length,
        scheduled: isScheduled,
        fidelityScore: payload.fidelity.score,
        fidelityIssues: payload.fidelity.issues as unknown as JsonValue,
      },
    };
  }
}

export { DEFAULT_FACEBOOK_GRAPH_VERSION, FACEBOOK_PAGES_EXTENSION_ID };
