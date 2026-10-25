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
  type OwnershipMarker,
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

function publicationTargetGroupIds(publication: Publication): readonly string[] {
  const value = publication.current.content.attributes.publishingTargets;
  if (!isRecord(value) || !Array.isArray(value.groupIds)) return [];
  return [...new Set(value.groupIds.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
  ).map((entry) => entry.trim()))].sort();
}

function markerOwnsProjection(
  marker: OwnershipMarker,
  projection: CompiledProjection,
  legacyOwnershipAllowed: boolean,
): boolean {
  if (
    marker.publicationId !== projection.publicationId ||
    marker.routeId !== projection.routeId
  ) return false;
  if (!projection.groupId) return true;
  if (marker.version === 2) return marker.groupId === projection.groupId;
  return legacyOwnershipAllowed;
}

function markerForProjection(
  projection: CompiledProjection,
  projectionFingerprintValue: string,
  renderedHash: string,
): OwnershipMarker {
  return projection.groupId
    ? {
      version: 2,
      publicationId: projection.publicationId,
      groupId: projection.groupId,
      routeId: projection.routeId,
      projectionFingerprint: projectionFingerprintValue,
      renderedHash,
    }
    : {
      version: 1,
      publicationId: projection.publicationId,
      routeId: projection.routeId,
      projectionFingerprint: projectionFingerprintValue,
      renderedHash,
    };
}

function variant(route: PublicationRoute): Readonly<Record<string, JsonValue>> {
  return route.variant ?? {};
}

function requireRestBase(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error("WordPress content type REST base must contain only lowercase letters, numbers, underscores, or hyphens");
  }
  return normalized;
}

function routeRestBase(
  channel: string,
  settings: WordPressSettings,
): string {
  const normalized = requireRestBase(channel);
  if (normalized === "posts" && settings.postTypeRestBase !== "posts") {
    return settings.postTypeRestBase;
  }
  return normalized;
}

function destinationOverride(
  publication: Publication,
  route: PublicationRoute,
  groupId?: string,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!groupId) return undefined;
  const root = publication.current.content.attributes.destinationOverrides;
  if (!isRecord(root)) return undefined;
  if (root.schemaVersion !== 1) {
    throw new Error("Unsupported destinationOverrides schemaVersion");
  }
  const groups = root.groups;
  if (!isRecord(groups)) return undefined;
  const group = groups[groupId];
  if (!isRecord(group)) return undefined;
  const routes = group.routes;
  if (!isRecord(routes)) return undefined;
  const override = routes[route.id];
  if (!isRecord(override)) return undefined;

  if (
    override.extensionId !== route.destination.extensionId ||
    override.connectionId !== route.destination.connectionId ||
    override.channel !== route.destination.channel
  ) {
    throw new Error(`Canonical destination override identity no longer matches route ${groupId}/${route.id}`);
  }
  return override;
}

function sourcePublishingState(
  publication: Publication,
  route: PublicationRoute,
  groupId?: string,
): { readonly status: PostStatus; readonly scheduledAt?: string } | undefined {
  const scoped = destinationOverride(publication, route, groupId);
  const scopedPublishing = scoped?.publishing;
  const source = isRecord(scopedPublishing)
    ? scopedPublishing
    : publication.current.content.attributes.sourcePublishing;
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

function desiredStatus(publication: Publication, route: PublicationRoute, groupId?: string): PostStatus {
  const source = sourcePublishingState(publication, route, groupId);
  if (source) return source.status;
  const candidate = getString(variant(route), "status") ?? "publish";
  if (!POST_STATUSES.includes(candidate as PostStatus)) {
    throw new Error(`Unsupported WordPress post status: ${candidate}`);
  }
  return candidate as PostStatus;
}

function desiredSchedule(
  publication: Publication,
  route: PublicationRoute,
  status: PostStatus,
  groupId?: string,
): string | undefined {
  const source = sourcePublishingState(publication, route, groupId);
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

function sourceCustomTaxonomies(
  publication: Publication,
  route: PublicationRoute,
  contentType: string,
): Readonly<Record<string, {
  readonly restBase: string;
  readonly restNamespace?: string;
  readonly names: readonly string[];
}>> {
  const source = publication.current.content.attributes.sourceTaxonomies;
  if (!isRecord(source)) return {};
  if (
    source.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    source.connectionId !== route.destination.connectionId ||
    source.contentType !== contentType
  ) {
    return {};
  }
  if (!isRecord(source.taxonomies)) {
    throw new Error("Canonical WordPress source taxonomies must be an object");
  }
  const reserved = new Set([
    "title", "content", "excerpt", "slug", "status", "categories", "tags",
    "featured_media", "author", "parent", "template", "menu_order", "password",
    "comment_status", "ping_status", "sticky", "format", "date_gmt",
  ]);
  const result: Record<string, {
    readonly restBase: string;
    readonly restNamespace?: string;
    readonly names: readonly string[];
  }> = {};
  for (const [rawKey, rawValue] of Object.entries(source.taxonomies)) {
    const taxonomyKey = rawKey.trim();
    if (!taxonomyKey || taxonomyKey === "category" || taxonomyKey === "post_tag") {
      throw new Error("Canonical custom taxonomy key must not overlap categories or tags");
    }
    if (!isRecord(rawValue)) throw new Error(`Canonical custom taxonomy ${taxonomyKey} must be an object`);
    const restBase = rawValue.restBase;
    if (typeof restBase !== "string" || !/^[a-zA-Z0-9._-]+$/.test(restBase) || reserved.has(restBase)) {
      throw new Error(`Canonical custom taxonomy ${taxonomyKey} has invalid or reserved restBase`);
    }
    const restNamespace = rawValue.restNamespace;
    if (restNamespace !== undefined && typeof restNamespace !== "string") {
      throw new Error(`Canonical custom taxonomy ${taxonomyKey} restNamespace must be a string`);
    }
    const names = stringArray(rawValue.names);
    result[taxonomyKey] = {
      restBase,
      ...(typeof restNamespace === "string" && restNamespace.trim() ? { restNamespace: restNamespace.trim() } : {}),
      names: [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(),
    };
  }
  return result;
}

function sourceAuthorId(
  publication: Publication,
  route: PublicationRoute,
  groupId?: string,
): number | undefined {
  const scoped = destinationOverride(publication, route, groupId);
  const sourceAuthor = isRecord(scoped?.author)
    ? scoped!.author
    : publication.current.content.attributes.sourceAuthor;
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

function sourcePageStructure(
  publication: Publication,
  route: PublicationRoute,
  contentType: string,
): { readonly parentId: number; readonly template: string; readonly menuOrder: number } | undefined {
  const sourcePage = publication.current.content.attributes.sourcePage;
  if (!isRecord(sourcePage)) return undefined;
  if (
    sourcePage.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    sourcePage.connectionId !== route.destination.connectionId ||
    sourcePage.contentType !== contentType
  ) {
    return undefined;
  }

  let parentId = 0;
  if (sourcePage.parentRemoteId !== null && sourcePage.parentRemoteId !== undefined) {
    if (typeof sourcePage.parentRemoteId !== "string" || !/^\d+$/.test(sourcePage.parentRemoteId)) {
      throw new Error("Canonical WordPress page parentRemoteId must be null or a positive integer string");
    }
    parentId = Number(sourcePage.parentRemoteId);
    if (!Number.isSafeInteger(parentId) || parentId < 1) {
      throw new Error("Canonical WordPress page parentRemoteId must be null or a positive integer string");
    }
  }

  const templateValue = sourcePage.template;
  if (templateValue !== null && templateValue !== undefined && typeof templateValue !== "string") {
    throw new Error("Canonical WordPress page template must be null or a string");
  }
  const template = typeof templateValue === "string" ? templateValue.trim() : "";

  const menuOrderValue = sourcePage.menuOrder;
  if (
    typeof menuOrderValue !== "number" ||
    !Number.isSafeInteger(menuOrderValue) ||
    menuOrderValue < 0
  ) {
    throw new Error("Canonical WordPress page menuOrder must be a non-negative integer");
  }

  return { parentId, template, menuOrder: menuOrderValue };
}

function sourceRestMeta(
  publication: Publication,
  route: PublicationRoute,
  contentType: string,
): Readonly<Record<string, JsonValue>> {
  const source = publication.current.content.attributes.sourceMeta;
  if (!isRecord(source)) return {};
  if (
    source.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    source.connectionId !== route.destination.connectionId ||
    source.contentType !== contentType
  ) {
    return {};
  }
  if (!isRecord(source.values)) throw new Error("Canonical WordPress sourceMeta values must be an object");
  const result: Record<string, JsonValue> = {};
  for (const [rawKey, value] of Object.entries(source.values)) {
    const key = rawKey.trim();
    if (!key) throw new Error("Canonical WordPress REST meta key must be non-empty");
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (/(^|_)(password|passwd|secret|token|credential|credentials|api_key|apikey|access_key|private_key|auth_token)($|_)/.test(normalized)) {
      throw new Error(`Canonical WordPress REST meta key is not allowed: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function sourceEditorialOptions(
  publication: Publication,
  route: PublicationRoute,
  contentType: string,
): {
  readonly password: string;
  readonly commentStatus?: "open" | "closed";
  readonly pingStatus?: "open" | "closed";
  readonly sticky?: boolean;
  readonly format?: string;
} | undefined {
  const source = publication.current.content.attributes.sourceEditorial;
  if (!isRecord(source)) return undefined;
  if (
    source.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    source.connectionId !== route.destination.connectionId ||
    source.contentType !== contentType
  ) {
    return undefined;
  }
  if (typeof source.password !== "string") throw new Error("Canonical WordPress editorial password must be a string");
  const commentStatus = source.commentStatus;
  if (commentStatus !== undefined && commentStatus !== "open" && commentStatus !== "closed") {
    throw new Error("Canonical WordPress editorial commentStatus must be open or closed");
  }
  const pingStatus = source.pingStatus;
  if (pingStatus !== undefined && pingStatus !== "open" && pingStatus !== "closed") {
    throw new Error("Canonical WordPress editorial pingStatus must be open or closed");
  }
  const sticky = source.sticky;
  if (sticky !== undefined && typeof sticky !== "boolean") {
    throw new Error("Canonical WordPress editorial sticky must be a boolean");
  }
  const format = source.format;
  const formats = new Set(["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"]);
  if (format !== undefined && (typeof format !== "string" || !formats.has(format))) {
    throw new Error("Unsupported canonical WordPress post format");
  }
  if (sticky === true && source.password.length > 0) {
    throw new Error("WordPress sticky posts cannot be password protected");
  }
  return {
    password: source.password,
    ...(commentStatus === undefined ? {} : { commentStatus }),
    ...(pingStatus === undefined ? {} : { pingStatus }),
    ...(sticky === undefined ? {} : { sticky }),
    ...(format === undefined ? {} : { format }),
  };
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
    contentType: payload.contentType,
    title: payload.title,
    excerpt: payload.excerpt,
    slug: payload.slug,
    status: payload.status,
    scheduledAt: payload.scheduledAt ?? null,
    bodyTemplate: payload.bodyTemplate,
    tags: [...payload.tags].sort(),
    categories: [...payload.categories].sort(),
    customTaxonomies: Object.fromEntries(
      Object.entries(payload.customTaxonomies ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, {
          restBase: value.restBase,
          restNamespace: value.restNamespace ?? null,
          names: [...value.names].sort(),
        }]),
    ),
    featuredAssetId: payload.featuredAssetId ?? null,
    authorId: payload.authorId ?? null,
    parentId: payload.parentId ?? null,
    template: payload.template ?? null,
    menuOrder: payload.menuOrder ?? null,
    password: payload.password ?? null,
    commentStatus: payload.commentStatus ?? null,
    pingStatus: payload.pingStatus ?? null,
    sticky: payload.sticky ?? null,
    format: payload.format ?? null,
    restMeta: Object.fromEntries(Object.entries(payload.restMeta ?? {}).sort(([left], [right]) => left.localeCompare(right))),
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

function remoteStateHash(
  post: WordPressPostRecord,
  bodyWithoutMarker: string,
  customTaxonomies: Readonly<Record<string, {
    readonly restBase: string;
    readonly names: readonly string[];
  }>> = {},
  restMeta: Readonly<Record<string, JsonValue>> = {},
): string {
  const customState = Object.fromEntries(
    Object.entries(customTaxonomies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taxonomyKey, definition]) => {
        const raw = post[definition.restBase];
        const ids = Array.isArray(raw)
          ? raw.filter((value): value is number =>
              typeof value === "number" && Number.isSafeInteger(value) && value > 0)
          : [];
        return [taxonomyKey, [...ids].sort((left, right) => left - right)];
      }),
  );
  const managedMeta = Object.fromEntries(
    Object.keys(restMeta)
      .sort()
      .map((key) => [key, post.meta?.[key] ?? null]),
  );
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
      customTaxonomies: customState,
      featuredMedia: post.featured_media ?? 0,
      author: post.author ?? null,
      parent: post.parent ?? 0,
      template: post.template ?? "",
      menuOrder: post.menu_order ?? 0,
      password: post.password ?? "",
      commentStatus: post.comment_status ?? null,
      pingStatus: post.ping_status ?? null,
      sticky: post.sticky ?? null,
      format: post.format ?? null,
      restMeta: managedMeta,
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
  restBase: string,
  postId: number,
): Promise<WordPressRevisionRecord | undefined> {
  try {
    const revisions = await client.requestJson<readonly WordPressRevisionRecord[]>(
      `/${restBase}/${postId}/revisions?context=edit&per_page=1&orderby=modified&order=desc`,
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
  restBase: string,
  slug: string,
): Promise<readonly WordPressPostRecord[]> {
  return client.requestJson<readonly WordPressPostRecord[]>(
    `/${restBase}?context=edit&slug=${encodeURIComponent(slug)}&per_page=100&status=${POST_STATUSES.join(",")}`,
  );
}

async function fetchPost(
  client: WordPressRestClient,
  restBase: string,
  id: string,
): Promise<WordPressPostRecord> {
  if (!/^\d+$/.test(id)) throw new Error(`Invalid WordPress remote post id: ${id}`);
  return client.requestJson<WordPressPostRecord>(
    `/${restBase}/${id}?context=edit`,
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
  const payload = parsePayload(projection);
  if (!markerOwnsProjection(marker, projection, payload.legacyOwnershipAllowed === true)) {
    return {
      state: "unreachable",
      remote,
      observedAt,
      detail: "WordPress object ownership marker belongs to a different publication or route",
    };
  }
  const actualRemoteHash = remoteStateHash(post, stripMarker(raw), payload.customTaxonomies, payload.restMeta);
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
  customTaxonomyIds: Readonly<Record<string, readonly number[]>>,
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
    ...customTaxonomyIds,
    featured_media: featuredMedia,
    ...(payload.authorId === undefined ? {} : { author: payload.authorId }),
    ...(payload.parentId === undefined ? {} : { parent: payload.parentId }),
    ...(payload.template === undefined ? {} : { template: payload.template }),
    ...(payload.menuOrder === undefined ? {} : { menu_order: payload.menuOrder }),
    ...(payload.password === undefined ? {} : { password: payload.password }),
    ...(payload.commentStatus === undefined ? {} : { comment_status: payload.commentStatus }),
    ...(payload.pingStatus === undefined ? {} : { ping_status: payload.pingStatus }),
    ...(payload.sticky === undefined ? {} : { sticky: payload.sticky }),
    ...(payload.format === undefined ? {} : { format: payload.format }),
    ...(Object.keys(payload.restMeta).length === 0 ? {} : { meta: payload.restMeta }),
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
      const types = await client.requestJson<Readonly<Record<string, unknown>>>(
        "/types?context=edit",
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
          discoveredTypeCount: Object.keys(types).length,
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
    const connection = this.#connections.requireActive(
      WORDPRESS_REST_EXTENSION_ID,
      route.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const contentType = routeRestBase(route.destination.channel, settings);
    const status = desiredStatus(publication, route, groupId);
    const scheduledAt = desiredSchedule(publication, route, status, groupId);
    const imageTransform = variant(route).imageTransform === undefined
      ? undefined
      : imageTransformSpecFromJson(variant(route).imageTransform);
    const assets = await compileAssets(
      publication,
      settings,
      imageTransform,
      route.destination.connectionId,
    );
    const featured = featuredAssetId(publication, route);
    const authorId = sourceAuthorId(publication, route, groupId);
    const pageStructure = sourcePageStructure(publication, route, contentType);
    const editorial = sourceEditorialOptions(publication, route, contentType);
    const customTaxonomies = sourceCustomTaxonomies(publication, route, contentType);
    const restMeta = sourceRestMeta(publication, route, contentType);
    const payload: WordPressProjectionPayload = {
      contentType,
      title: publication.current.content.title,
      excerpt: publication.current.content.summary ?? "",
      slug: termSlug(getString(variant(route), "slug") ?? publication.slug ?? publication.id),
      status,
      bodyTemplate: htmlBody(publication),
      tags: tagNames(publication, route),
      categories: categoryNames(publication, route),
      ...(Object.keys(customTaxonomies).length === 0 ? {} : { customTaxonomies }),
      ...(Object.keys(restMeta).length === 0 ? {} : { restMeta }),
      ...(groupId && publicationTargetGroupIds(publication).length === 1 &&
        publicationTargetGroupIds(publication)[0] === groupId
        ? { legacyOwnershipAllowed: true }
        : {}),
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
      ...(pageStructure === undefined ? {} : {
        parentId: pageStructure.parentId,
        template: pageStructure.template,
        menuOrder: pageStructure.menuOrder,
      }),
      ...(editorial === undefined ? {} : editorial),
    };
    const fingerprint = projectionFingerprint(semanticPayload(payload, assets));
    return {
      projectionId: `${publication.id}:${groupId ?? "legacy"}:${route.id}`,
      ...(groupId ? { groupId } : {}),
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
      const restBase = routeRestBase(input.projection.destination.channel, settings);
      if (payload.contentType !== restBase) {
        throw new Error("WordPress projection content type does not match its destination channel");
      }
      if (input.remote) {
        return inspectRecord(
          await fetchPost(client, restBase, input.remote.id),
          input.projection,
          observedAt,
        );
      }
      const candidates = await findPostBySlug(client, restBase, payload.slug);
      if (candidates.length === 0) return { state: "missing", observedAt };
      const owned = candidates.filter((candidate) => {
        const marker = parseMarker(sourceBody(candidate));
        if (!marker) return false;
        return markerOwnsProjection(
          marker,
          input.projection,
          payload.legacyOwnershipAllowed === true,
        );
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
    const restBase = routeRestBase(request.projection.destination.channel, settings);
    if (payload.contentType !== restBase) {
      throw new Error("WordPress projection content type does not match its destination channel");
    }

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
    const customTaxonomyIds: Record<string, readonly number[]> = {};
    for (const [taxonomyKey, definition] of Object.entries(payload.customTaxonomies)) {
      if (customTaxonomyIds[definition.restBase] !== undefined) {
        throw new Error(`Multiple WordPress taxonomies resolve to the same REST base: ${definition.restBase}`);
      }
      customTaxonomyIds[definition.restBase] = await resolveTerms(
        client,
        definition.restBase,
        definition.names,
        settings.createMissingTerms,
        definition.restNamespace,
      );
    }
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
        customTaxonomies: Object.fromEntries(
          Object.entries(payload.customTaxonomies)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, definition]) => [
              key,
              [...(customTaxonomyIds[definition.restBase] ?? [])].sort((left, right) => left - right),
            ]),
        ),
        featuredMedia,
        author: payload.authorId ?? null,
        parent: payload.parentId ?? 0,
        template: payload.template ?? "",
        menuOrder: payload.menuOrder ?? 0,
      }),
    );
    const markedContent = documentWithMarker(
      body,
      markerForProjection(
        request.projection,
        request.projection.fingerprint,
        preliminaryHash,
      ),
    );
    const postBody = postRequestBody(payload, markedContent, categories, tags, customTaxonomyIds, featuredMedia);
    const endpoint = request.existingRemote
      ? `/${restBase}/${request.existingRemote.id}`
      : `/${restBase}`;
    const saved = await client.requestJson<WordPressPostRecord>(endpoint, {
      method: "POST",
      body: JSON.stringify(postBody),
    });

    let current = await fetchPost(client, restBase, String(saved.id));
    const currentBody = stripMarker(sourceBody(current));
    const actualHash = remoteStateHash(current, currentBody, payload.customTaxonomies, payload.restMeta);
    const currentMarker = parseMarker(sourceBody(current));
    if (
      !currentMarker ||
      !markerOwnsProjection(
        currentMarker,
        request.projection,
        payload.legacyOwnershipAllowed === true,
      ) ||
      currentMarker.projectionFingerprint !== request.projection.fingerprint ||
      currentMarker.renderedHash !== actualHash
    ) {
      const normalized = documentWithMarker(
        currentBody,
        markerForProjection(
          request.projection,
          request.projection.fingerprint,
          actualHash,
        ),
      );
      current = await client.requestJson<WordPressPostRecord>(
        `/${restBase}/${saved.id}?context=edit`,
        { method: "POST", body: JSON.stringify({ content: normalized }) },
      );
      current = await fetchPost(client, restBase, String(saved.id));
    }

    const nativeRevision = await latestNativeRevision(client, restBase, current.id);

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
        customTaxonomyIds: customTaxonomyIds as unknown as JsonValue,
        idempotencyKey: request.idempotencyKey,
        serverNormalized: actualHash !== preliminaryHash,
        wordpressRevisionId: nativeRevision?.id ?? null,
        wordpressRevisionModifiedGmt: nativeRevision?.modified_gmt ?? null,
      },
    };
  }
}
