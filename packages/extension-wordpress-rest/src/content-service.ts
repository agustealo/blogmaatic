import type { CompiledProjection, JsonValue } from "@blogmaatic/core";
import { inspectImageBytes } from "@blogmaatic/media";
import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import { WordPressRestClient } from "./client.js";
import {
  documentWithMarker,
  parseMarker,
  sha256,
  stableJson,
  stripMarker,
} from "./fingerprint.js";
import { parsePayload } from "./payload.js";
import { WORDPRESS_REST_EXTENSION_ID, parseSettings } from "./settings.js";
import { findOrCreateTerm } from "./taxonomy.js";
import type {
  WordPressContentTypeRecord,
  WordPressContentTypeView,
  WordPressImportSnapshot,
  WordPressMediaPage,
  WordPressMediaQuery,
  WordPressMediaRecord,
  WordPressMediaView,
  WordPressPostPage,
  WordPressPostQuery,
  WordPressPostRecord,
  WordPressPostView,
  WordPressRevisionRecord,
  WordPressRevisionView,
  WordPressRestMetaFieldDefinition,
  WordPressRestMetaSnapshot,
  WordPressRestMetaType,
  WordPressTaxonomyRecord,
  WordPressTaxonomyView,
  WordPressTermPage,
  WordPressTermQuery,
  WordPressTermRecord,
  WordPressUserPage,
  WordPressUserQuery,
  WordPressUserRecord,
  WordPressUserView,
} from "./types.js";

const ALL_POST_STATUSES = "publish,future,draft,pending,private,trash";

function rawValue(field: { readonly raw?: string; readonly rendered?: string } | undefined): string {
  return field?.raw ?? field?.rendered ?? "";
}

function requireRemoteId(value: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`Invalid WordPress remote post id: ${value}`);
  return normalized;
}

function requireRestBase(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error("WordPress content type REST base must contain only lowercase letters, numbers, underscores, or hyphens");
  }
  return normalized;
}

function requirePage(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("WordPress page must be a positive integer");
  return value;
}

function requirePerPage(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("WordPress perPage must be an integer from 1 through 100");
  }
  return value;
}

const REST_META_TYPES = new Set<WordPressRestMetaType>([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
]);

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Readonly<Record<string, unknown>>).every(isJsonValue);
}

function secretLikeMetaKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /(^|_)(password|passwd|secret|token|credential|credentials|api_key|apikey|access_key|private_key|auth_token)($|_)/.test(normalized);
}

function metaType(schema: Readonly<Record<string, unknown>>): {
  readonly type?: WordPressRestMetaType;
  readonly nullable: boolean;
} {
  const raw = schema.type;
  if (typeof raw === "string") {
    const supported = REST_META_TYPES.has(raw as WordPressRestMetaType)
      ? raw as WordPressRestMetaType
      : undefined;
    return {
      ...(supported ? { type: supported } : {}),
      nullable: raw === "null",
    };
  }
  if (!Array.isArray(raw)) return { nullable: false };
  const nullable = raw.includes("null");
  const supported = raw.find((value): value is WordPressRestMetaType =>
    typeof value === "string" && REST_META_TYPES.has(value as WordPressRestMetaType));
  return { ...(supported ? { type: supported } : {}), nullable };
}

function restMetaField(
  key: string,
  value: unknown,
): WordPressRestMetaFieldDefinition | undefined {
  if (secretLikeMetaKey(key) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const schema = value as Readonly<Record<string, unknown>>;
  if (schema.readOnly === true || schema.readonly === true) return undefined;
  const parsed = metaType(schema);
  if (!parsed.type) return undefined;
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter(isJsonValue)
    : undefined;
  const defaultValue = isJsonValue(schema.default) ? schema.default : undefined;
  return {
    key,
    type: parsed.type,
    nullable: parsed.nullable,
    ...(typeof schema.title === "string" && schema.title.trim() ? { title: schema.title.trim() } : {}),
    ...(typeof schema.description === "string" && schema.description.trim()
      ? { description: schema.description.trim() }
      : {}),
    ...(enumValues && enumValues.length > 0 ? { enum: enumValues } : {}),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  };
}

function ownership(post: WordPressPostRecord): WordPressPostView["ownership"] {
  const marker = parseMarker(rawValue(post.content));
  if (!marker) return { managed: false };
  return {
    managed: true,
    publicationId: marker.publicationId,
    routeId: marker.routeId,
    projectionFingerprint: marker.projectionFingerprint,
  };
}

function postView(
  post: WordPressPostRecord,
  taxonomies: readonly WordPressTaxonomyView[] = [],
): WordPressPostView {
  const customTaxonomyIds: Record<string, readonly number[]> = {};
  for (const taxonomy of taxonomies) {
    if (taxonomy.key === "category" || taxonomy.key === "post_tag") continue;
    const value = post[taxonomy.restBase];
    if (!Array.isArray(value)) continue;
    const ids = value.filter(
      (entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0,
    );
    customTaxonomyIds[taxonomy.key] = [...ids];
  }
  return {
    id: post.id,
    ...(typeof post.author === "number" ? { author: post.author } : {}),
    title: rawValue(post.title),
    excerpt: rawValue(post.excerpt),
    contentHtml: stripMarker(rawValue(post.content)),
    slug: post.slug,
    status: post.status,
    link: post.link,
    ...(post.date_gmt === undefined ? {} : { dateGmt: post.date_gmt }),
    ...(post.modified_gmt ? { modifiedGmt: post.modified_gmt } : {}),
    categoryIds: [...(post.categories ?? [])],
    tagIds: [...(post.tags ?? [])],
    ...(typeof post.featured_media === "number" && post.featured_media > 0
      ? { featuredMediaId: post.featured_media }
      : {}),
    ...(typeof post.parent === "number" && post.parent > 0 ? { parentId: post.parent } : {}),
    ...(typeof post.template === "string" && post.template.trim() ? { template: post.template.trim() } : {}),
    ...(typeof post.menu_order === "number" && Number.isSafeInteger(post.menu_order) && post.menu_order >= 0
      ? { menuOrder: post.menu_order }
      : {}),
    ...(typeof post.password === "string" ? { password: post.password } : {}),
    ...(post.comment_status === "open" || post.comment_status === "closed"
      ? { commentStatus: post.comment_status }
      : {}),
    ...(post.ping_status === "open" || post.ping_status === "closed"
      ? { pingStatus: post.ping_status }
      : {}),
    ...(typeof post.sticky === "boolean" ? { sticky: post.sticky } : {}),
    ...(typeof post.format === "string" && post.format.trim() ? { format: post.format.trim() } : {}),
    customTaxonomyIds,
    ownership: ownership(post),
  };
}

function mediaView(media: WordPressMediaRecord): WordPressMediaView {
  return {
    id: media.id,
    sourceUrl: media.source_url,
    slug: media.slug,
    ...(media.mime_type ? { mediaType: media.mime_type } : {}),
    ...(media.media_type ? { mediaKind: media.media_type } : {}),
    alt: media.alt_text ?? "",
    title: rawValue(media.title),
    ...(typeof media.media_details?.width === "number" ? { width: media.media_details.width } : {}),
    ...(typeof media.media_details?.height === "number" ? { height: media.media_details.height } : {}),
    ...(media.modified_gmt ? { modifiedGmt: media.modified_gmt } : {}),
  };
}

function userView(user: WordPressUserRecord): WordPressUserView {
  const avatars = user.avatar_urls ?? {};
  const avatarUrl = avatars["96"] ?? avatars["48"] ?? avatars["24"] ?? Object.values(avatars)[0];
  return {
    id: user.id,
    name: user.name,
    slug: user.slug,
    ...(user.link ? { link: user.link } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function contentTypeView(
  slug: string,
  type: WordPressContentTypeRecord,
): WordPressContentTypeView | undefined {
  const restBase = type.rest_base?.trim();
  if (!restBase || !/^[a-z0-9_-]+$/.test(restBase)) return undefined;
  if (type.viewable === false) return undefined;
  return {
    slug: type.slug?.trim() || slug,
    name: type.name?.trim() || slug,
    restBase,
    ...(type.description?.trim() ? { description: type.description.trim() } : {}),
    hierarchical: type.hierarchical === true,
    viewable: true,
    ...(type.rest_namespace?.trim() ? { restNamespace: type.rest_namespace.trim() } : {}),
    taxonomies: [...(type.taxonomies ?? [])],
    supports: Object.entries(type.supports ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name)
      .sort(),
  };
}

function taxonomyView(
  key: string,
  taxonomy: WordPressTaxonomyRecord,
): WordPressTaxonomyView | undefined {
  const restBase = taxonomy.rest_base?.trim();
  if (!restBase || !/^[a-zA-Z0-9._-]+$/.test(restBase)) return undefined;
  const contentTypes = [...(taxonomy.types ?? [])].map((value) => value.trim()).filter(Boolean);
  if (contentTypes.length === 0) return undefined;
  return {
    key: taxonomy.slug?.trim() || key,
    label: taxonomy.name?.trim() || key,
    restBase,
    hierarchical: taxonomy.hierarchical === true,
    contentTypes,
    ...(taxonomy.rest_namespace?.trim() ? { restNamespace: taxonomy.rest_namespace.trim() } : {}),
    ...(taxonomy.description?.trim() ? { description: taxonomy.description.trim() } : {}),
  };
}

function revisionView(revision: WordPressRevisionRecord): WordPressRevisionView {
  return {
    id: revision.id,
    ...(typeof revision.parent === "number" ? { parent: revision.parent } : {}),
    ...(typeof revision.author === "number" ? { author: revision.author } : {}),
    ...(revision.date_gmt === undefined ? {} : { dateGmt: revision.date_gmt }),
    ...(revision.modified_gmt ? { modifiedGmt: revision.modified_gmt } : {}),
    title: rawValue(revision.title),
    excerpt: rawValue(revision.excerpt),
    contentHtml: stripMarker(rawValue(revision.content)),
  };
}

function remoteStateHash(
  post: WordPressPostRecord,
  bodyWithoutMarker: string,
  customTaxonomies: Readonly<Record<string, { readonly restBase: string }>> = {},
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

export class WordPressContentService {
  readonly #connections: ConnectionAuthority;
  readonly #secrets: SecretAuthority;

  constructor(connections: ConnectionAuthority, secrets: SecretAuthority) {
    this.#connections = connections;
    this.#secrets = secrets;
  }

  #client(
    connectionId: string,
    contentType?: string,
  ): {
    readonly client: WordPressRestClient;
    readonly restBase: string;
    readonly defaultRestBase: string;
  } {
    const connection = this.#connections.requireActive(WORDPRESS_REST_EXTENSION_ID, connectionId);
    const settings = parseSettings(connection);
    return {
      client: new WordPressRestClient(connection, settings, this.#secrets),
      restBase: contentType === undefined ? settings.postTypeRestBase : requireRestBase(contentType),
      defaultRestBase: settings.postTypeRestBase,
    };
  }

  defaultContentType(connectionId: string): string {
    return this.#client(connectionId).defaultRestBase;
  }

  async listContentTypes(connectionId: string): Promise<readonly WordPressContentTypeView[]> {
    const { client } = this.#client(connectionId);
    const records = await client.requestJson<Readonly<Record<string, WordPressContentTypeRecord>>>(
      "/types?context=edit",
    );
    return Object.entries(records)
      .map(([slug, record]) => contentTypeView(slug, record))
      .filter((record): record is WordPressContentTypeView => record !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listRestMetaFields(
    connectionId: string,
    contentType: string,
  ): Promise<readonly WordPressRestMetaFieldDefinition[]> {
    const types = await this.listContentTypes(connectionId);
    const type = types.find((candidate) => candidate.restBase === contentType);
    if (!type) throw new Error(`WordPress content type is not available: ${contentType}`);

    const { client } = this.#client(connectionId);
    const options = type.restNamespace && type.restNamespace !== "wp/v2"
      ? await client.requestNamespaceJson<unknown>(type.restNamespace, `/${type.restBase}`, { method: "OPTIONS" })
      : await client.requestJson<unknown>(`/${type.restBase}`, { method: "OPTIONS" });
    if (options === null || typeof options !== "object" || Array.isArray(options)) return [];
    const schema = (options as Readonly<Record<string, unknown>>).schema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
    const properties = (schema as Readonly<Record<string, unknown>>).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return [];
    const meta = (properties as Readonly<Record<string, unknown>>).meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return [];
    const metaProperties = (meta as Readonly<Record<string, unknown>>).properties;
    if (metaProperties === null || typeof metaProperties !== "object" || Array.isArray(metaProperties)) return [];

    return Object.entries(metaProperties as Readonly<Record<string, unknown>>)
      .map(([key, value]) => restMetaField(key, value))
      .filter((field): field is WordPressRestMetaFieldDefinition => field !== undefined)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async restMetaSnapshot(
    connectionId: string,
    post: WordPressPostRecord,
    contentType: string,
  ): Promise<WordPressRestMetaSnapshot> {
    const fields = await this.listRestMetaFields(connectionId, contentType);
    const raw = post.meta ?? {};
    const values: Record<string, JsonValue> = {};
    for (const field of fields) {
      const value = raw[field.key];
      if (isJsonValue(value)) values[field.key] = value;
    }
    return { fields, values };
  }

  async listTaxonomies(
    connectionId: string,
    contentType?: string,
  ): Promise<readonly WordPressTaxonomyView[]> {
    const types = await this.listContentTypes(connectionId);
    const requestedRestBase = contentType ?? this.defaultContentType(connectionId);
    const type = types.find((candidate) => candidate.restBase === requestedRestBase);
    if (!type) throw new Error(`WordPress content type is not available: ${requestedRestBase}`);
    const { client } = this.#client(connectionId);
    const records = await client.requestJson<Readonly<Record<string, WordPressTaxonomyRecord>>>(
      "/taxonomies?context=edit",
    );
    const allowed = new Set(type.taxonomies);
    return Object.entries(records)
      .map(([key, record]) => taxonomyView(key, record))
      .filter((record): record is WordPressTaxonomyView =>
        record !== undefined &&
        (allowed.has(record.key) || record.contentTypes.includes(type.slug)))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async listTermsForTaxonomy(
    connectionId: string,
    taxonomyKey: string,
    contentType: string,
    query: WordPressTermQuery = {},
  ): Promise<WordPressTermPage> {
    const taxonomy = (await this.listTaxonomies(connectionId, contentType))
      .find((candidate) => candidate.key === taxonomyKey);
    if (!taxonomy) {
      throw new Error(`WordPress taxonomy ${taxonomyKey} is not attached to content type ${contentType}`);
    }
    const { client } = this.#client(connectionId);
    const page = requirePage(query.page);
    const perPage = requirePerPage(query.perPage);
    const params = new URLSearchParams({
      context: "edit",
      page: String(page),
      per_page: String(perPage),
      orderby: "name",
      order: "asc",
    });
    if (query.search?.trim()) params.set("search", query.search.trim());
    const path = `/${taxonomy.restBase}?${params.toString()}`;
    const records = taxonomy.restNamespace && taxonomy.restNamespace !== "wp/v2"
      ? await client.requestNamespaceJson<readonly WordPressTermRecord[]>(taxonomy.restNamespace, path)
      : await client.requestJson<readonly WordPressTermRecord[]>(path);
    return { items: records, page, perPage, hasMore: records.length === perPage };
  }

  async createTermForTaxonomy(
    connectionId: string,
    taxonomyKey: string,
    contentType: string,
    input: {
      readonly name: string;
      readonly slug?: string;
      readonly description?: string;
    },
  ): Promise<WordPressTermRecord> {
    const taxonomy = (await this.listTaxonomies(connectionId, contentType))
      .find((candidate) => candidate.key === taxonomyKey);
    if (!taxonomy) {
      throw new Error(`WordPress taxonomy ${taxonomyKey} is not attached to content type ${contentType}`);
    }
    const { client } = this.#client(connectionId);
    return findOrCreateTerm(
      client,
      taxonomy.restBase,
      input,
      taxonomy.restNamespace,
    );
  }

  async list(connectionId: string, query: WordPressPostQuery = {}): Promise<WordPressPostPage> {
    const { client, restBase } = this.#client(connectionId, query.contentType);
    const page = requirePage(query.page);
    const perPage = requirePerPage(query.perPage);
    const params = new URLSearchParams({
      context: "edit",
      page: String(page),
      per_page: String(perPage),
      orderby: "modified",
      order: "desc",
      status: query.status?.trim() || ALL_POST_STATUSES,
    });
    if (query.search?.trim()) params.set("search", query.search.trim());
    const records = await client.requestJson<readonly WordPressPostRecord[]>(
      `/${restBase}?${params.toString()}`,
    );
    const taxonomies = await this.listTaxonomies(connectionId, restBase);
    return {
      items: records.map((record) => postView(record, taxonomies)),
      page,
      perPage,
      hasMore: records.length === perPage,
    };
  }

  async get(connectionId: string, remoteId: string, contentType?: string): Promise<WordPressPostView> {
    const restBase = contentType ?? this.defaultContentType(connectionId);
    const [record, taxonomies] = await Promise.all([
      this.#getRecord(connectionId, remoteId, contentType),
      this.listTaxonomies(connectionId, restBase),
    ]);
    return postView(record, taxonomies);
  }

  async importSnapshot(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<WordPressImportSnapshot> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const post = await this.#getRecord(connectionId, remoteId, contentType);
    const taxonomies = await this.listTaxonomies(connectionId, restBase);
    const categoryNames = await Promise.all((post.categories ?? []).map(async (id) => {
      const term = await client.requestJson<WordPressTermRecord>(`/categories/${id}?context=edit`);
      return term.name;
    }));
    const tagNames = await Promise.all((post.tags ?? []).map(async (id) => {
      const term = await client.requestJson<WordPressTermRecord>(`/tags/${id}?context=edit`);
      return term.name;
    }));
    let featuredMedia: WordPressMediaRecord | undefined;
    if (post.featured_media && post.featured_media > 0) {
      featuredMedia = await client.requestJson<WordPressMediaRecord>(
        `/media/${post.featured_media}?context=edit`,
      );
    }
    const restMeta = await this.restMetaSnapshot(connectionId, post, restBase);
    const customTaxonomies = await Promise.all(
      taxonomies
        .filter((taxonomy) => taxonomy.key !== "category" && taxonomy.key !== "post_tag")
        .map(async (taxonomy) => {
          const value = post[taxonomy.restBase];
          const ids = Array.isArray(value)
            ? value.filter((entry): entry is number =>
                typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
            : [];
          const names = await Promise.all(ids.map(async (id) => {
            const path = `/${taxonomy.restBase}/${id}?context=edit`;
            const term = taxonomy.restNamespace && taxonomy.restNamespace !== "wp/v2"
              ? await client.requestNamespaceJson<WordPressTermRecord>(taxonomy.restNamespace, path)
              : await client.requestJson<WordPressTermRecord>(path);
            return term.name;
          }));
          return {
            taxonomyKey: taxonomy.key,
            restBase: taxonomy.restBase,
            ...(taxonomy.restNamespace ? { restNamespace: taxonomy.restNamespace } : {}),
            names,
          };
        }),
    );
    return {
      post: postView(post, taxonomies),
      categoryNames,
      tagNames,
      customTaxonomies,
      restMeta,
      ...(featuredMedia ? { featuredMedia } : {}),
    };
  }

  async listAuthors(
    connectionId: string,
    query: WordPressUserQuery = {},
  ): Promise<WordPressUserPage> {
    const { client } = this.#client(connectionId);
    const page = requirePage(query.page);
    const perPage = requirePerPage(query.perPage);
    const params = new URLSearchParams({
      context: "edit",
      who: "authors",
      page: String(page),
      per_page: String(perPage),
      orderby: "name",
      order: "asc",
    });
    if (query.search?.trim()) params.set("search", query.search.trim());
    const records = await client.requestJson<readonly WordPressUserRecord[]>(
      `/users?${params.toString()}`,
    );
    return {
      items: records.map(userView),
      page,
      perPage,
      hasMore: records.length === perPage,
    };
  }

  async getAuthor(connectionId: string, remoteId: string): Promise<WordPressUserView> {
    const { client } = this.#client(connectionId);
    const id = requireRemoteId(remoteId);
    return userView(await client.requestJson<WordPressUserRecord>(`/users/${id}?context=edit`));
  }

  async createTerm(
    connectionId: string,
    kind: "category" | "tag",
    input: {
      readonly name: string;
      readonly slug?: string;
      readonly description?: string;
    },
  ): Promise<WordPressTermRecord> {
    const { client } = this.#client(connectionId);
    const endpoint = kind === "category" ? "categories" : "tags";
    return findOrCreateTerm(client, endpoint, input);
  }

  async listTerms(
    connectionId: string,
    kind: "category" | "tag",
    query: WordPressTermQuery = {},
  ): Promise<WordPressTermPage> {
    const { client } = this.#client(connectionId);
    const page = requirePage(query.page);
    const perPage = requirePerPage(query.perPage);
    const endpoint = kind === "category" ? "categories" : "tags";
    const params = new URLSearchParams({
      context: "edit",
      page: String(page),
      per_page: String(perPage),
      orderby: "name",
      order: "asc",
    });
    if (query.search?.trim()) params.set("search", query.search.trim());
    const records = await client.requestJson<readonly WordPressTermRecord[]>(
      `/${endpoint}?${params.toString()}`,
    );
    return {
      items: records,
      page,
      perPage,
      hasMore: records.length === perPage,
    };
  }

  async listMedia(connectionId: string, query: WordPressMediaQuery = {}): Promise<WordPressMediaPage> {
    const { client } = this.#client(connectionId);
    const page = requirePage(query.page);
    const perPage = requirePerPage(query.perPage);
    const params = new URLSearchParams({
      context: "edit",
      media_type: "image",
      page: String(page),
      per_page: String(perPage),
      orderby: "modified",
      order: "desc",
    });
    if (query.search?.trim()) params.set("search", query.search.trim());
    const records = await client.requestJson<readonly WordPressMediaRecord[]>(
      `/media?${params.toString()}`,
    );
    return {
      items: records.map(mediaView),
      page,
      perPage,
      hasMore: records.length === perPage,
    };
  }

  async uploadMedia(
    connectionId: string,
    input: {
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly filename: string;
      readonly alt?: string;
      readonly title?: string;
    },
  ): Promise<WordPressMediaView> {
    const { client } = this.#client(connectionId);
    const inspected = inspectImageBytes(input.bytes);
    if (!["image/jpeg", "image/png", "image/webp"].includes(inspected.mediaType)) {
      throw new Error(`Unsupported WordPress image media type: ${inspected.mediaType}`);
    }
    if (input.mediaType !== inspected.mediaType) {
      throw new Error(
        `Uploaded image Content-Type ${input.mediaType} does not match detected bytes ${inspected.mediaType}`,
      );
    }
    const rawName = input.filename.trim();
    if (!rawName || /[\\/\u0000-\u001f\u007f]/u.test(rawName) || rawName === "." || rawName === "..") {
      throw new Error("WordPress upload filename must be a simple file name");
    }
    const extension = inspected.mediaType === "image/png" ? "png" : inspected.mediaType === "image/webp" ? "webp" : "jpg";
    const stem = rawName.replace(/\.[^.]+$/u, "").trim() || "image";
    const filename = `${stem}.${extension}`;
    const created = await client.requestBytes<WordPressMediaRecord>(
      "/media",
      input.bytes,
      inspected.mediaType,
      filename,
    );
    let current = created;
    if (input.alt !== undefined || input.title !== undefined) {
      current = await client.requestJson<WordPressMediaRecord>(`/media/${created.id}`, {
        method: "POST",
        body: JSON.stringify({
          ...(input.alt === undefined ? {} : { alt_text: input.alt }),
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      });
    }
    return mediaView(current);
  }

  async deleteMediaPermanent(connectionId: string, remoteId: string): Promise<void> {
    const { client } = this.#client(connectionId);
    const id = requireRemoteId(remoteId);
    await client.requestJson<unknown>(`/media/${id}?force=true`, { method: "DELETE" });
  }

  async getMedia(connectionId: string, remoteId: string): Promise<WordPressMediaView> {
    const { client } = this.#client(connectionId);
    const id = requireRemoteId(remoteId);
    const record = await client.requestJson<WordPressMediaRecord>(`/media/${id}?context=edit`);
    if (
      (record.media_type && record.media_type !== "image") ||
      (record.mime_type && !record.mime_type.toLowerCase().startsWith("image/"))
    ) {
      throw new Error(`WordPress media ${id} is not an image`);
    }
    return mediaView(record);
  }

  async getRevision(
    connectionId: string,
    remoteId: string,
    remoteRevisionId: string,
    contentType?: string,
  ): Promise<WordPressRevisionView> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const postId = requireRemoteId(remoteId);
    const revisionId = requireRemoteId(remoteRevisionId);
    const revision = await client.requestJson<WordPressRevisionRecord>(
      `/${restBase}/${postId}/revisions/${revisionId}?context=edit`,
    );
    if (revision.parent !== undefined && String(revision.parent) !== postId) {
      throw new Error(`WordPress revision ${revisionId} does not belong to post ${postId}`);
    }
    return revisionView(revision);
  }

  async revisions(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<readonly WordPressRevisionView[]> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const id = requireRemoteId(remoteId);
    const revisions = await client.requestJson<readonly WordPressRevisionRecord[]>(
      `/${restBase}/${id}/revisions?context=edit&per_page=100`,
    );
    return revisions.map(revisionView);
  }

  async trash(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const current = await this.#getRecord(connectionId, remoteId, contentType);
    this.#assertManaged(current);
    const saved = await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ status: "trash" }) },
    );
    return postView(saved);
  }

  async restore(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const current = await this.#getRecord(connectionId, remoteId, contentType);
    this.#assertManaged(current);
    if (current.status !== "trash") throw new Error("Only trashed WordPress posts can be restored");
    const saved = await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ status: "draft" }) },
    );
    return postView(saved);
  }

  async deletePermanent(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const current = await this.#getRecord(connectionId, remoteId, contentType);
    this.#assertManaged(current);
    if (current.status !== "trash") {
      throw new Error("WordPress post must be moved to trash before permanent deletion");
    }
    await client.requestJson<unknown>(
      `/${restBase}/${requireRemoteId(remoteId)}?force=true`,
      { method: "DELETE" },
    );
    return postView(current);
  }

  async adopt(
    connectionId: string,
    remoteId: string,
    projection: CompiledProjection,
    contentType?: string,
  ): Promise<WordPressPostView> {
    if (projection.destination.extensionId !== WORDPRESS_REST_EXTENSION_ID) {
      throw new Error("WordPress adoption requires a WordPress projection");
    }
    if (projection.destination.connectionId !== connectionId) {
      throw new Error("WordPress adoption projection belongs to a different connection");
    }
    const { client, restBase } = this.#client(connectionId, contentType);
    const current = await this.#getRecord(connectionId, remoteId, contentType);
    const currentMarker = parseMarker(rawValue(current.content));
    if (
      currentMarker &&
      (currentMarker.publicationId !== projection.publicationId ||
        currentMarker.routeId !== projection.routeId)
    ) {
      throw new Error("WordPress post is already owned by a different Blogmaatic publication or route");
    }
    const raw = stripMarker(rawValue(current.content));
    const payload = parsePayload(projection);
    const marked = documentWithMarker(raw, {
      version: 1,
      publicationId: projection.publicationId,
      routeId: projection.routeId,
      projectionFingerprint: projection.fingerprint,
      renderedHash: remoteStateHash(current, raw, payload.customTaxonomies, payload.restMeta),
    });
    const saved = await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ content: marked }) },
    );
    return postView(saved);
  }

  async releaseAdoption(
    connectionId: string,
    remoteId: string,
    publicationId: string,
    routeId: string,
    contentHtml: string,
    contentType?: string,
  ): Promise<void> {
    const { client, restBase } = this.#client(connectionId, contentType);
    const current = await this.#getRecord(connectionId, remoteId, contentType);
    const marker = parseMarker(rawValue(current.content));
    if (!marker) return;
    if (marker.publicationId !== publicationId || marker.routeId !== routeId) {
      throw new Error("Cannot roll back WordPress adoption owned by another publication or route");
    }
    await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ content: contentHtml }) },
    );
  }

  async #getRecord(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<WordPressPostRecord> {
    const { client, restBase } = this.#client(connectionId, contentType);
    return client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}?context=edit`,
    );
  }

  #assertManaged(post: WordPressPostRecord): void {
    if (!parseMarker(rawValue(post.content))) {
      throw new Error("WordPress object is not owned by Blogmaatic; refusing destructive mutation");
    }
  }
}
