import type {
  CompiledProjection,
  DeliveryRequest,
  DeliveryResult,
  InspectProjectionInput,
  JsonValue,
  ObservedProjection,
  Publication,
  PublicationAsset,
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
import {
  imageTransformSpecFromJson,
  type ImageTransformSpec,
} from "@blogmaatic/media";
import { SecretAuthority } from "@blogmaatic/secrets";
import { adaptPublicationForSocial } from "@blogmaatic/variants";

import { compileLinkedInImage, renderLinkedInImage } from "./assets.js";
import { LinkedInHttpError, LinkedInRestClient } from "./client.js";
import { fingerprint } from "./fingerprint.js";
import { parsePayload } from "./payload.js";
import { LINKEDIN_REST_EXTENSION_ID, parseSettings } from "./settings.js";
import type {
  LinkedInImageInitializeResponse,
  LinkedInImageRecord,
  LinkedInImageSpec,
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

function imageTransformSpec(route: PublicationRoute): ImageTransformSpec {
  const spec = imageTransformSpecFromJson(variant(route).imageTransform);
  if (spec.format === "webp") {
    throw new Error("LinkedIn imageTransform.format cannot be webp");
  }
  return spec;
}

function selectedImageAssets(
  publication: Publication,
  social: Readonly<Record<string, JsonValue>>,
): readonly PublicationAsset[] {
  const raw = social.imageAssetIds;
  if (!Array.isArray(raw)) {
    throw new Error("LinkedIn selected social media requires imageAssetIds");
  }
  const ids = raw.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
  if (ids.length === 0) throw new Error("LinkedIn selected social media requires at least one image");
  if (ids.length > 20) throw new Error("LinkedIn selected social media supports at most 20 images");
  if (new Set(ids).size !== ids.length) {
    throw new Error("LinkedIn selected social media cannot contain duplicate image asset ids");
  }
  return ids.map((id) => {
    const asset = publication.current.content.assets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error(`LinkedIn social image asset does not exist: ${id}`);
    if (asset.kind !== "image") throw new Error(`LinkedIn social selected asset must be an image: ${id}`);
    return asset;
  });
}

function imageSemantic(image: LinkedInImageSpec): Readonly<Record<string, unknown>> {
  return {
    assetId: image.assetId,
    fingerprint: image.fingerprint,
    transformationFingerprint: image.transform.transformationFingerprint,
    derivedAssetId: image.transform.derivedAssetId,
    outputWidth: image.transform.output.width,
    outputHeight: image.transform.output.height,
    outputMediaType: image.transform.output.mediaType,
    alt: image.alt ?? null,
  };
}

function projectedImages(payload: LinkedInProjectionPayload): readonly LinkedInImageSpec[] {
  if (payload.image) return [payload.image];
  return payload.images ?? [];
}

function desiredSemantic(
  settings: LinkedInSettings,
  payload: LinkedInProjectionPayload,
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
    ...(payload.image ? { image: imageSemantic(payload.image) } : {}),
    ...(payload.images ? { images: payload.images.map(imageSemantic) } : {}),
  };
}

function remoteSemantic(post: LinkedInPostRecord, payload: LinkedInProjectionPayload): unknown {
  const article = post.content?.article;
  const multi = post.content?.multiImage?.images ?? [];
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
    ...(payload.image ? {
      image: {
        ...imageSemantic(payload.image),
        alt: post.content?.media?.altText ?? null,
      },
    } : {}),
    ...(payload.images ? {
      images: payload.images.map((image, index) => ({
        ...imageSemantic(image),
        alt: multi[index]?.altText ?? null,
      })),
    } : {}),
  };
}

interface LinkedInImageRemoteItem {
  readonly imageUrn: string;
  readonly imageFingerprint: string;
}

interface LinkedInImageRemoteBaseline {
  readonly schemaVersion: 2;
  readonly images: readonly LinkedInImageRemoteItem[];
}

function encodeImageRemoteVersion(imageUrns: readonly string[], images: readonly LinkedInImageSpec[]): string {
  if (imageUrns.length !== images.length || images.length === 0) {
    throw new Error("LinkedIn remote image baseline requires matching non-empty image arrays");
  }
  const baseline: LinkedInImageRemoteBaseline = {
    schemaVersion: 2,
    images: images.map((image, index) => ({
      imageUrn: imageUrns[index]!,
      imageFingerprint: fingerprint(imageSemantic(image)),
    })),
  };
  return Buffer.from(JSON.stringify(baseline), "utf8").toString("base64url");
}

function parseImageRemoteVersion(value: string | undefined): LinkedInImageRemoteBaseline | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Readonly<Record<string, unknown>>;

    if (record.schemaVersion === 1) {
      if (
        typeof record.imageUrn !== "string" ||
        !/^urn:li:image:[A-Za-z0-9_-]+$/.test(record.imageUrn) ||
        typeof record.imageFingerprint !== "string" ||
        !record.imageFingerprint
      ) {
        return undefined;
      }
      return {
        schemaVersion: 2,
        images: [{
          imageUrn: record.imageUrn,
          imageFingerprint: record.imageFingerprint,
        }],
      };
    }

    if (record.schemaVersion !== 2 || !Array.isArray(record.images) || record.images.length === 0) {
      return undefined;
    }
    const images: LinkedInImageRemoteItem[] = [];
    for (const value of record.images) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const item = value as Readonly<Record<string, unknown>>;
      if (
        typeof item.imageUrn !== "string" ||
        !/^urn:li:image:[A-Za-z0-9_-]+$/.test(item.imageUrn) ||
        typeof item.imageFingerprint !== "string" ||
        !item.imageFingerprint
      ) {
        return undefined;
      }
      images.push({
        imageUrn: item.imageUrn,
        imageFingerprint: item.imageFingerprint,
      });
    }
    return { schemaVersion: 2, images };
  } catch {
    return undefined;
  }
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
  imageUrns: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const images = projectedImages(payload);
  if (images.length !== imageUrns.length) {
    throw new Error("LinkedIn post creation requires one remote Image URN per projected image");
  }
  return {
    author: settings.authorUrn,
    commentary: payload.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    ...(payload.images
      ? {
          content: {
            multiImage: {
              images: payload.images.map((image, index) => ({
                id: imageUrns[index]!,
                ...(image.alt ? { altText: image.alt.slice(0, 4086) } : {}),
              })),
            },
          },
        }
      : payload.image
        ? {
            content: {
              media: {
                id: imageUrns[0]!,
                ...(payload.image.alt ? { altText: payload.image.alt.slice(0, 4086) } : {}),
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

async function fetchPost(client: LinkedInRestClient, id: string): Promise<LinkedInPostRecord> {
  const response = await client.request<LinkedInPostRecord>(postPath(id));
  return response.body;
}

function structuralContentMatches(
  post: LinkedInPostRecord,
  payload: LinkedInProjectionPayload,
  remoteVersion?: string,
): boolean {
  const images = projectedImages(payload);
  if (images.length > 0) {
    const baseline = parseImageRemoteVersion(remoteVersion);
    if (!baseline || baseline.images.length !== images.length) return false;
    for (let index = 0; index < images.length; index += 1) {
      if (baseline.images[index]!.imageFingerprint !== fingerprint(imageSemantic(images[index]!))) {
        return false;
      }
    }
    if (payload.image) {
      return (
        post.content?.media?.id === baseline.images[0]!.imageUrn &&
        post.content?.multiImage === undefined &&
        post.content?.article === undefined
      );
    }
    const remoteImages = post.content?.multiImage?.images ?? [];
    return (
      remoteImages.length === baseline.images.length &&
      remoteImages.every((item, index) => item.id === baseline.images[index]!.imageUrn) &&
      post.content?.media === undefined &&
      post.content?.article === undefined
    );
  }
  if (post.content?.media !== undefined || post.content?.multiImage !== undefined) return false;
  const actual = post.content?.article;
  if (!payload.article) return actual === undefined;
  return Boolean(
    actual &&
      actual.source === payload.article.source &&
      actual.title === payload.article.title &&
      (actual.description ?? "") === (payload.article.description ?? ""),
  );
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
  const uploadUrl = response.body.value?.uploadUrl?.trim();
  const imageUrn = response.body.value?.image?.trim();
  if (!uploadUrl) throw new Error("LinkedIn image initialize response did not include uploadUrl");
  if (!imageUrn || !/^urn:li:image:[A-Za-z0-9_-]+$/.test(imageUrn)) {
    throw new Error("LinkedIn image initialize response did not include a valid image URN");
  }
  const expiresAt = response.body.value?.uploadUrlExpiresAt;
  if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
    throw new Error("LinkedIn image initialize response returned an expired upload URL");
  }
  return { uploadUrl, imageUrn };
}

async function waitForImageAvailable(
  client: LinkedInRestClient,
  imageUrn: string,
): Promise<LinkedInImageRecord> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await client.request<LinkedInImageRecord>(
      `/images/${encodeURIComponent(imageUrn)}`,
    );
    const status = response.body.status;
    if (status === "AVAILABLE") return response.body;
    if (status === "PROCESSING_FAILED") {
      throw new Error(`LinkedIn image processing failed: ${imageUrn}`);
    }
    if (status !== "WAITING_UPLOAD" && status !== "PROCESSING") {
      throw new Error(`LinkedIn image returned unsupported status: ${String(status ?? "missing")}`);
    }
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`LinkedIn image did not become available before delivery: ${imageUrn}`);
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
    const routeMode = projectionMode(route);
    const mediaMode = social ? stringValue(social, "mediaMode") : undefined;
    if (mediaMode !== undefined && !["inherit", "none", "select"].includes(mediaMode)) {
      throw new Error(`Unsupported LinkedIn social media mode: ${mediaMode}`);
    }

    const wantsImage = mediaMode === "select" || (mediaMode !== "none" && routeMode === "image");
    const adapted = adaptPublicationForSocial(
      publication,
      {
        id: LINKEDIN_REST_EXTENSION_ID,
        maxCommentaryChars: 3000,
        maxImages: wantsImage ? 1 : 0,
        supportsArticleCard: routeMode === "article",
        supportedBlockKinds: wantsImage ? ["paragraph", "image", "gallery"] : ["paragraph"],
      },
      {
        mode: routeMode === "article" ? "article" : "text",
        includeTitle: booleanValue(routeVariant, "includeTitle") ?? true,
        includeSummary: booleanValue(routeVariant, "includeSummary") ?? false,
        includeCanonicalUrl:
          booleanValue(routeVariant, "includeCanonicalUrl") ?? (routeMode === "text"),
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

    const commentaryMode = social ? stringValue(social, "commentaryMode") : undefined;
    if (commentaryMode !== undefined && commentaryMode !== "inherit" && commentaryMode !== "override") {
      throw new Error(`Unsupported LinkedIn social commentary mode: ${commentaryMode}`);
    }
    const commentary = commentaryMode === "override"
      ? stringValue(social!, "commentary")?.trim()
      : adapted.commentary;
    if (!commentary) throw new Error("LinkedIn commentary override is missing commentary");
    if (commentary.length > 3000) throw new Error("LinkedIn commentary override exceeds 3000 characters");

    let imageAsset: PublicationAsset | undefined;
    if (mediaMode === "select") {
      imageAsset = selectedImageAsset(publication, social!);
    } else if (mediaMode !== "none" && routeMode === "image") {
      imageAsset = adapted.imageAssets[0];
      if (!imageAsset) throw new Error("LinkedIn image mode requires one canonical image");
    }

    const mode: LinkedInProjectionMode = imageAsset
      ? "image"
      : routeMode === "article"
        ? "article"
        : "text";
    if (mode === "article" && !adapted.article) {
      throw new Error("LinkedIn article mode requires a canonical publication URL");
    }

    const image = imageAsset
      ? await compileLinkedInImage(imageAsset, settings, imageTransformSpec(route))
      : undefined;
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
      const remote = remoteIdentity(post, payload.image ? input.remote.version : undefined);
      if (post.author !== settings.authorUrn) {
        return {
          state: "unreachable",
          remote,
          observedAt,
          detail: "Stored LinkedIn post belongs to a different author; refusing mutation",
        };
      }

      if (payload.image) {
        const baseline = parseImageRemoteVersion(input.remote.version);
        if (!baseline) {
          return {
            state: "drifted",
            remote,
            observedAt,
            detail: "LinkedIn image post lacks a Blogmaatic image ownership baseline",
          };
        }
        if (baseline.imageFingerprint !== fingerprint(imageSemantic(payload.image))) {
          return {
            state: "drifted",
            remote,
            observedAt,
            detail: "LinkedIn desired image identity changed after delivery",
          };
        }
        if (post.content?.media?.id !== baseline.imageUrn || post.content?.article !== undefined) {
          return {
            state: "drifted",
            remote,
            observedAt,
            detail: "LinkedIn remote media no longer matches the uploaded Blogmaatic image",
          };
        }
      } else if (payload.article && post.content?.article?.source !== payload.article.source) {
        return {
          state: "unreachable",
          remote,
          observedAt,
          detail: "Stored LinkedIn article source no longer matches this publication",
        };
      } else if (post.content?.media !== undefined) {
        return {
          state: "drifted",
          remote,
          observedAt,
          detail: "LinkedIn remote post unexpectedly contains media",
        };
      }

      const actual = fingerprint(remoteSemantic(post, payload.image));
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
        await client.uploadBytes(initialized.uploadUrl, rendered.bytes, rendered.mediaType);
        await waitForImageAvailable(client, initialized.imageUrn);
        imageUrn = initialized.imageUrn;
        mediaEvidence = {
          linkedInImageUrn: imageUrn,
          assetId: payload.image.assetId,
          transformationFingerprint: rendered.transformationFingerprint,
          derivedAssetId: rendered.derivedAssetId,
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
      const remote: RemoteIdentity = {
        id,
        url: `https://www.linkedin.com/feed/update/${id}`,
        ...(payload.image && imageUrn
          ? { version: encodeImageRemoteVersion(imageUrn, payload.image) }
          : {}),
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
          ...(mediaEvidence ? { media: mediaEvidence as JsonValue } : {}),
        },
      };
    }

    const current = await fetchPost(client, request.existingRemote.id);
    if (current.author !== settings.authorUrn) {
      throw new Error("Stored LinkedIn post belongs to a different author; refusing update");
    }
    if (!structuralContentMatches(current, payload, request.existingRemote.version)) {
      throw new Error(
        "LinkedIn structural post content drift cannot be updated safely in place; create a new publication route or repair the remote post explicitly",
      );
    }

    const currentSemantic = remoteSemantic(current, payload.image) as Readonly<Record<string, unknown>>;
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
        ...(payload.image ? {
          media: {
            linkedInImageUrn: parseImageRemoteVersion(request.existingRemote.version)?.imageUrn ?? null,
            assetId: payload.image.assetId,
            reused: true,
          },
        } : {}),
      },
    };
  }
}
