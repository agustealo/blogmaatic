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

import { compileAssets } from "./assets.js";
import { WordPressHttpError, WordPressRestClient } from "./client.js";
import {
  documentWithMarker,
  parseMarker,
  projectionFingerprint,
  sha256,
  stableJson,
  stripMarker,
} from "./fingerprint.js";
import { htmlBody, injectAssetUrls } from "./html.js";
import { getString, isRecord, stringArray } from "./json.js";
import { publishMedia, type PublishedMedia } from "./media.js";
import { parsePayload } from "./payload.js";
import { WORDPRESS_REST_EXTENSION_ID, parseSettings } from "./settings.js";
import { resolveTerms, termSlug } from "./taxonomy.js";
import type {
  WordPressPostRecord,
  WordPressProjectionPayload,
  WordPressRevisionRecord,
  WordPressSettings,
} from "./types.js";

const POST_STATUSES = ["publish", "draft", "pending", "private", "future"] as const;
type PostStatus = (typeof POST_STATUSES)[number];

function variant(route: PublicationRoute): Readonly<Record<string, JsonValue>> {
  return route.variant ?? {};
}

function sourcePublishingState(
  publication: Publication,
  route: PublicationRoute,
): { readonly status: PostStatus; readonly scheduledAt?: string } | undefined {
  const source = publication.current.content.attributes.sourcePublishing;
  if (!isRecord(source)) return undefined;
  if (
    source.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    source.connectionId !== route.destination.connectionId
  ) {
    return undefined;
  }
  const status = source.status;
  if (typeof status !== "string" || !POST_STATUSES.includes(status as PostStatus)) {
    throw new Error(`Unsupported canonical WordPress publishing status: ${String(status)}`);
  }
  const scheduledAt = source.scheduledAt;
  if (status === "future") {
    if (typeof scheduledAt !== "string" || !scheduledAt.trim()) {
      throw new Error("Canonical WordPress future publishing state requires scheduledAt");
    }
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid canonical WordPress scheduledAt: ${scheduledAt}`);
    return { status: "future", scheduledAt: parsed.toISOString() };
  }
  if (scheduledAt !== undefined) {
    throw new Error("Canonical WordPress scheduledAt is only allowed when status is future");
  }
  return { status: status as PostStatus };
}

function desiredStatus(publication: Publication, route: PublicationRoute): PostStatus {
  const source = sourcePublishingState(publication, route);
  if (source) return source.status;
  const fromVariant = getString(variant(route), "status");
  const candidate = fromVariant ?? (route.destination.channel === "posts" ? "publish" : route.destination.channel);
  if (!POST_STATUSES.includes(candidate as PostStatus)) {
    throw new Error(`Unsupported WordPress destination channel/status: ${candidate}`);
  }
  return candidate as PostStatus;
}

function desiredSchedule(
  publication: Publication,
  route: PublicationRoute,
  status: PostStatus,
): string | undefined {
  const source = sourcePublishingState(publication, route);
  if (source) return source.scheduledAt;
  const value = getString(variant(route), "scheduledAt");
  if (status !== "future") return undefined;
  if (!value) throw new Error("WordPress future publications require route.variant.scheduledAt");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid WordPress scheduledAt: ${value}`);
  return date.toISOString();
}

function categoryNames(publication: Publication, route: PublicationRoute): readonly string[] {
  const base = stringArray(publication.current.content.attributes.categories);
  const extra = stringArray(variant(route).categories);
  return [...new Set([...base, ...extra].map((value) => value.trim()).filter(Boolean))].sort();
}

function tagNames(publication: Publication, route: PublicationRoute): readonly string[] {
  const extra = stringArray(variant(route).tags);
  return [...new Set([...publication.current.content.tags, ...extra].map((value) => value.trim()).filter(Boolean))].sort();
}

function sourceAuthorId(publication: Publication, route: PublicationRoute): number | undefined {
  const sourceAuthor = publication.current.content.attributes.sourceAuthor;
  if (!isRecord(sourceAuthor)) return undefined;
  if (
    sourceAuthor.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    sourceAuthor.connectionId !== route.destination.connectionId
  ) {
    return undefined;
  }
  const remoteId = sourceAuthor.remoteId;
  if (typeof remoteId !== "string" || !/^\d+$/.test(remoteId)) {
    throw new Error("Canonical WordPress source author remoteId must be a positive integer string");
  }
  const parsed = Number(remoteId);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Canonical WordPress source author remoteId must be a positive integer string");
  }
  return parsed;
}

function featuredAssetId(publication: Publication, route: PublicationRoute): string | undefined {
  const explicit = getString(variant(route), "featuredAssetId");
  if (explicit) return explicit;
  return publication.current.content.assets.find(
    (asset) => isRecord(asset.attributes) && asset.attributes.featured === true,
  )?.id;
}

function semanticPayload(
  payload: WordPressProjectionPayload,
  parsedAssets: ReturnType<typeof parsePayload>["assetsParsed"],
): unknown {
  return {
    title: payload.title,
    excerpt: payload.excerpt,
    slug: payload.slug,
    status: payload.status,
    scheduledAt: payload.scheduledAt ?? null,
    bodyTemplate: payload.bodyTemplate,
    tags: [...payload.tags].sort(),
    categories: [...payload.categories].sort(),
    featuredAssetId: payload.featuredAssetId ?? null,
    authorId: payload.authorId ?? null,
    assets: parsedAssets.map((asset) => ({
      assetId: asset.assetId,
      source: asset.localPath ? "managed-local" : asset.source,
      mediaType: asset.mediaType ?? null,
      alt: asset.alt ?? null,
      fingerprint: asset.fingerprint ?? null,
      wordpressMediaId: asset.wordpressMediaId ?? null,
      transformFingerprint: asset.transform?.transformationFingerprint ?? null,
      outputWidth: asset.transform?.output.width ?? null,
      outputHeight: asset.transform?.output.height ?? null,
      outputMediaType: asset.transform?.output.mediaType ?? null,
    })),
  };
}

function rawValue(field: { readonly raw?: string; readonly rendered?: string } | undefined): string {
  return field?.raw ?? field?.rendered ?? "";
}

function remoteStateHash(post: WordPressPostRecord, bodyWithoutMarker: string): string {
  return sha256(
    stableJson({
      title: rawValue(post.title),
      excerpt: rawValue(post.excerpt),
      slug: post.slug,
      status: post.status,
      dateGmt: post.date_gmt ?? null,
      content: bodyWithoutMarker,
      categories: [...(post.categories ?? [])].sort((left, right) => left - right),
      tags: [...(post.tags ?? [])].sort((left, right) => left - right),
      featuredMedia: post.featured_media ?? 0,
      author: post.author ?? null,
    }),
  );
}

function remoteIdentity(post: WordPressPostRecord): RemoteIdentity {
  return {
    id: String(post.id),
    url: post.link,
    ...(post.modified_gmt ? { version: post.modified_gmt } : {}),
  };
}

async function latestNativeRevision(
  client: WordPressRestClient,
  settings: WordPressSettings,
  postId: number,
): Promise<WordPressRevisionRecord | undefined> {
  try {
    const revisions = await client.requestJson<readonly WordPressRevisionRecord[]>(
      `/${settings.postTypeRestBase}/${postId}/revisions?context=edit&per_page=1&orderby=modified&order=desc`,
    );
    return revisions[0];
  } catch (error) {
    if (error instanceof WordPressHttpError && (error.status === 404 || error.status === 400)) {
      return undefined;
    }
    throw error;
  }
}

async function findPostBySlug(
  client: WordPressRestClient,
  settings: WordPressSettings,
  slug: string,
): Promise<readonly WordPressPostRecord[]> {
  return client.requestJson<readonly WordPressPostRecord[]>(
    `/${settings.postTypeRestBase}?context=edit&slug=${encodeURIComponent(slug)}&per_page=100&status=${POST_STATUSES.join(",")}`,
  );
}

async function fetchPost(
  client: WordPressRestClient,
  settings: WordPressSettings,
  id: string,
): Promise<WordPressPostRecord> {
  if (!/^\d+$/.test(id)) throw new Error(`Invalid WordPress remote post id: ${id}`);
  return client.requestJson<WordPressPostRecord>(
    `/${settings.postTypeRestBase}/${id}?context=edit`,
  );
}

function sourceBody(post: WordPressPostRecord): string {
  return rawValue(post.content);
}

function inspectRecord(
  post: WordPressPostRecord,
  projection: CompiledProjection,
  observedAt: string,
): ObservedProjection {
  const raw = sourceBody(post);
  const marker = parseMarker(raw);
  const remote = remoteIdentity(post);
  if (!marker) {
    return {
      state: "unreachable",
      remote,
      observedAt,
      detail: "WordPress object is not owned by Blogmaatic; refusing to overwrite it",
    };
  }
  if (
    marker.publicationId !== projection.publicationId ||
    marker.routeId !== projection.routeId
  ) {
    return {
      state: "unreachable",
      remote,
      observedAt,
      detail: "WordPress object ownership marker belongs to a different publication or route",
    };
  }
  const actualRemoteHash = remoteStateHash(post, stripMarker(raw));
  const synchronized =
    marker.projectionFingerprint === projection.fingerprint &&
    marker.renderedHash === actualRemoteHash;
  return {
    state: synchronized ? "synchronized" : "drifted",
    remote,
    fingerprint: synchronized ? projection.fingerprint : marker.projectionFingerprint,
    observedAt,
    detail: synchronized
      ? "WordPress projection matches the desired publication"
      : "WordPress projection differs from the desired or last verified remote state",
  };
}

function postRequestBody(
  payload: ReturnType<typeof parsePayload>,
  content: string,
  categories: readonly number[],
  tags: readonly number[],
  featuredMedia: number,
): Readonly<Record<string, unknown>> {
  return {
    title: payload.title,
    content,
    excerpt: payload.excerpt,
    slug: payload.slug,
    status: payload.status,
    categories,
    tags,
    featured_media: featuredMedia,
    ...(payload.authorId === undefined ? {} : { author: payload.authorId }),
    ...(payload.status === "future" && payload.scheduledAt
      ? { date_gmt: payload.scheduledAt.replace(/\.\d{3}Z$/, "") }
      : {}),
  };
}

export class WordPressRestPublisher implements ManagedPublisherExtension {
  readonly manifest = {
    apiVersion: 1,
    kind: "publisher",
    connectionSchemaVersion: 1,
    id: WORDPRESS_REST_EXTENSION_ID,
    displayName: "WordPress REST",
    version: "0.1.0",
    capabilities: [
      "article.create",
      "article.update",
      "article.delete",
      "article.inspect",
      "article.draft",
      "article.schedule",
      "asset.publish",
      "taxonomy.publish",
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
      this.#secrets.validateReference(settings.applicationPasswordRef);
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
      const client = new WordPressRestClient(connection, settings, this.#secrets);
      const user = await client.requestJson<{ readonly id: number; readonly name?: string }>(
        "/users/me?context=edit",
      );
      await client.requestJson<readonly unknown[]>(
        `/${settings.postTypeRestBase}?context=edit&per_page=1`,
      );
      return {
        state: "healthy",
        checkedAt,
        detail: "WordPress REST authentication and editable post endpoint are ready",
        evidence: {
          siteUrl: settings.siteUrl,
          userId: user.id,
          postTypeRestBase: settings.postTypeRestBase,
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
    const connection = this.#connections.requireActive(
      WORDPRESS_REST_EXTENSION_ID,
      route.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const status = desiredStatus(publication, route);
    const scheduledAt = desiredSchedule(publication, route, status);
    const imageTransform = variant(route).imageTransform === undefined
      ? undefined
      : imageTransformSpecFromJson(variant(route).imageTransform);
    const assets = await compileAssets(publication, settings, imageTransform);
    const featured = featuredAssetId(publication, route);
    const authorId = sourceAuthorId(publication, route);
    const payload: WordPressProjectionPayload = {
      title: publication.current.content.title,
      excerpt: publication.current.content.summary ?? "",
      slug: termSlug(getString(variant(route), "slug") ?? publication.slug ?? publication.id),
      status,
      bodyTemplate: htmlBody(publication),
      tags: tagNames(publication, route),
      categories: categoryNames(publication, route),
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        source: asset.source,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.alt ? { alt: asset.alt } : {}),
        ...(asset.fingerprint ? { fingerprint: asset.fingerprint } : {}),
        ...(asset.localPath ? { localPath: asset.localPath } : {}),
        ...(asset.wordpressMediaId === undefined ? {} : { wordpressMediaId: asset.wordpressMediaId }),
        ...(asset.transform ? { transform: asset.transform as unknown as JsonValue } : {}),
      })),
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(featured ? { featuredAssetId: featured } : {}),
      ...(authorId === undefined ? {} : { authorId }),
    };
    const fingerprint = projectionFingerprint(semanticPayload(payload, assets));
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

  async inspect(input: InspectProjectionInput): Promise<ObservedProjection> {
    const observedAt = new Date().toISOString();
    try {
      const connection = this.#connections.requireActive(
        WORDPRESS_REST_EXTENSION_ID,
        input.projection.destination.connectionId,
      );
      const settings = parseSettings(connection);
      const client = new WordPressRestClient(connection, settings, this.#secrets);
      const payload = parsePayload(input.projection);
      if (input.remote) {
        return inspectRecord(
          await fetchPost(client, settings, input.remote.id),
          input.projection,
          observedAt,
        );
      }
      const candidates = await findPostBySlug(client, settings, payload.slug);
      if (candidates.length === 0) return { state: "missing", observedAt };
      const owned = candidates.filter((candidate) => {
        const marker = parseMarker(sourceBody(candidate));
        return marker?.publicationId === input.projection.publicationId && marker.routeId === input.projection.routeId;
      });
      if (owned.length === 0) {
        return {
          state: "unreachable",
          observedAt,
          detail: `WordPress slug is already occupied by unmanaged content: ${payload.slug}`,
        };
      }
      if (owned.length > 1) {
        return {
          state: "unreachable",
          observedAt,
          detail: `Multiple WordPress objects claim the same Blogmaatic publication route: ${payload.slug}`,
        };
      }
      return inspectRecord(owned[0]!, input.projection, observedAt);
    } catch (error) {
      return {
        state: "unreachable",
        observedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const connection = this.#connections.requireActive(
      WORDPRESS_REST_EXTENSION_ID,
      request.projection.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const client = new WordPressRestClient(connection, settings, this.#secrets);
    const payload = parsePayload(request.projection);

    const publishedMedia: PublishedMedia[] = [];
    for (const asset of payload.assetsParsed) {
      publishedMedia.push(await publishMedia(client, request.projection.publicationId, asset));
    }
    const mediaUrls = new Map(publishedMedia.map((media) => [media.assetId, media.sourceUrl] as const));
    const body = injectAssetUrls(payload.bodyTemplate, mediaUrls);
    const categories = await resolveTerms(
      client,
      "categories",
      payload.categories,
      settings.createMissingTerms,
    );
    const tags = await resolveTerms(client, "tags", payload.tags, settings.createMissingTerms);
    let featuredMedia = 0;
    if (payload.featuredAssetId) {
      const media = publishedMedia.find((candidate) => candidate.assetId === payload.featuredAssetId);
      if (!media?.mediaId) {
        throw new Error(`Featured WordPress asset must be a managed uploaded media item: ${payload.featuredAssetId}`);
      }
      featuredMedia = media.mediaId;
    }

    const preliminaryHash = sha256(
      stableJson({
        title: payload.title,
        excerpt: payload.excerpt,
        slug: payload.slug,
        status: payload.status,
        dateGmt: payload.scheduledAt ?? null,
        content: body,
        categories: [...categories].sort((left, right) => left - right),
        tags: [...tags].sort((left, right) => left - right),
        featuredMedia,
        author: payload.authorId ?? null,
      }),
    );
    const markedContent = documentWithMarker(body, {
      version: 1,
      publicationId: request.projection.publicationId,
      routeId: request.projection.routeId,
      projectionFingerprint: request.projection.fingerprint,
      renderedHash: preliminaryHash,
    });
    const postBody = postRequestBody(payload, markedContent, categories, tags, featuredMedia);
    const endpoint = request.existingRemote
      ? `/${settings.postTypeRestBase}/${request.existingRemote.id}`
      : `/${settings.postTypeRestBase}`;
    const saved = await client.requestJson<WordPressPostRecord>(endpoint, {
      method: "POST",
      body: JSON.stringify(postBody),
    });

    let current = await fetchPost(client, settings, String(saved.id));
    const currentBody = stripMarker(sourceBody(current));
    const actualHash = remoteStateHash(current, currentBody);
    const currentMarker = parseMarker(sourceBody(current));
    if (
      currentMarker?.projectionFingerprint !== request.projection.fingerprint ||
      currentMarker.renderedHash !== actualHash
    ) {
      const normalized = documentWithMarker(currentBody, {
        version: 1,
        publicationId: request.projection.publicationId,
        routeId: request.projection.routeId,
        projectionFingerprint: request.projection.fingerprint,
        renderedHash: actualHash,
      });
      current = await client.requestJson<WordPressPostRecord>(
        `/${settings.postTypeRestBase}/${saved.id}?context=edit`,
        { method: "POST", body: JSON.stringify({ content: normalized }) },
      );
      current = await fetchPost(client, settings, String(saved.id));
    }

    const nativeRevision = await latestNativeRevision(client, settings, current.id);

    return {
      remote: remoteIdentity(current),
      acceptedAt: new Date().toISOString(),
      evidence: {
        siteUrl: settings.siteUrl,
        postId: current.id,
        postStatus: current.status,
        mediaIds: publishedMedia
          .filter((media) => media.mediaId !== undefined)
          .map((media) => media.mediaId!),
        mediaTransforms: publishedMedia
          .filter((media) => media.transformationFingerprint)
          .map((media) => ({
            assetId: media.assetId,
            transformationFingerprint: media.transformationFingerprint!,
            ...(media.derivedAssetId ? { derivedAssetId: media.derivedAssetId } : {}),
            ...(media.outputFingerprint ? { outputFingerprint: media.outputFingerprint } : {}),
            ...(media.mediaType ? { mediaType: media.mediaType } : {}),
            ...(media.width === undefined ? {} : { width: media.width }),
            ...(media.height === undefined ? {} : { height: media.height }),
            ...(media.cacheHit === undefined ? {} : { cacheHit: media.cacheHit }),
          })) as unknown as JsonValue,
        categoryIds: [...categories],
        tagIds: [...tags],
        idempotencyKey: request.idempotencyKey,
        serverNormalized: actualHash !== preliminaryHash,
        wordpressRevisionId: nativeRevision?.id ?? null,
        wordpressRevisionModifiedGmt: nativeRevision?.modified_gmt ?? null,
      },
    };
  }
}
