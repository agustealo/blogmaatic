import { randomUUID } from "node:crypto";

import type {
  DistributionHistoryStore,
  JsonValue,
  ProjectionStateStore,
  Publication,
  PublicationAsset,
  PublicationBlock,
  PublicationRoute,
  RemoteIdentity,
} from "@blogmaatic/core";
import {
  WORDPRESS_REST_EXTENSION_ID,
  WordPressContentService,
  WordPressRestPublisher,
  discoverSeoFields,
  type WordPressContentTypeView,
  type WordPressMediaView,
  type WordPressPostView,
  type WordPressTaxonomyView,
  type WordPressUserView,
  type WordPressRevisionView,
  type WordPressRestMetaFieldDefinition,
} from "@blogmaatic/extension-wordpress-rest";
import type {
  OperatorSourceContentManager,
  SourceAssetAttachBody,
  SourceAssetAttachResult,
  SourceAssetPage,
  SourceAssetQuery,
  SourceAssetRecord,
  SourceAssetUploadInput,
  SourceFeaturedMediaBody,
  SourceFeaturedMediaResult,
  SourceAuthorAssignBody,
  SourceAuthorAssignResult,
  SourceAuthorPage,
  SourceAuthorQuery,
  SourceAuthorRecord,
  SourceContentImportBody,
  SourceContentImportResult,
  SourceContentTypeRecord,
  SourceContentPage,
  SourceContentQuery,
  SourceContentRecord,
  SourceContentRevision,
  SourceEditorialOptionsBody,
  SourceEditorialOptionsResult,
  SourceMetaFieldDefinition,
  SourceMetaValuesBody,
  SourceMetaValuesResult,
  SourceRevisionRestoreBody,
  SourceRevisionRestoreResult,
  SourcePublishingStateBody,
  SourcePublishingStateResult,
  SourceSeoFieldDefinition,
  SourceSeoSemantic,
  SourceSeoValuesBody,
  SourceSeoValuesResult,
  SourcePageStructureBody,
  SourcePageStructureResult,
  SourceTaxonomyCreateBody,
  SourceTaxonomyDefinitionRecord,
  SourceTaxonomyPage,
  SourceTaxonomyQuery,
  SourceTaxonomyRecord,
  SourceStandardTaxonomyBody,
  SourceStandardTaxonomyResult,
  SourceTaxonomySelectionBody,
  SourceTaxonomySelectionResult,
} from "@blogmaatic/operator-api";

import type { PublicationGroupManager } from "./publication-group-manager.js";
import {
  publicationTargetGroupIds,
  type PublicationWorkspaceManager,
} from "./publication-workspace-manager.js";

export interface WordPressSourceManagerOptions {
  readonly content: WordPressContentService;
  readonly publisher: WordPressRestPublisher;
  readonly publicationGroups: PublicationGroupManager;
  readonly publications: PublicationWorkspaceManager;
  readonly projectionState: ProjectionStateStore;
  readonly distributionHistory: DistributionHistoryStore;
  readonly now?: () => string;
  readonly id?: () => string;
}

async function assertTargetWordPressRoute(
  publicationGroups: PublicationGroupManager,
  publication: Publication,
  connectionId: string,
  groupId: string,
  routeId: string,
): Promise<PublicationRoute> {
  const normalizedGroupId = groupId.trim();
  const normalizedRouteId = routeId.trim();
  if (!normalizedGroupId || !normalizedRouteId) {
    throw new Error("Route-scoped WordPress settings require non-empty groupId and routeId");
  }
  if (!publicationTargetGroupIds(publication).includes(normalizedGroupId)) {
    throw new Error(`Publication does not target Publication Group: ${normalizedGroupId}`);
  }
  const groupEntry = await publicationGroups.get(normalizedGroupId);
  if (!groupEntry) throw new Error(`Publishing target is not registered: ${normalizedGroupId}`);
  if (!groupEntry.enabled) throw new Error(`Publishing target is disabled: ${normalizedGroupId}`);
  const route = groupEntry.group.routes.find((candidate) => candidate.id === normalizedRouteId);
  if (!route) {
    throw new Error(`Publishing target ${normalizedGroupId} does not contain route ${normalizedRouteId}`);
  }
  if (!route.enabled) {
    throw new Error(`Publishing target route is disabled: ${normalizedGroupId}/${normalizedRouteId}`);
  }
  if (
    route.destination.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
    route.destination.connectionId !== connectionId
  ) {
    throw new Error("WordPress route context does not match the requested connection");
  }
  return route;
}

function sourceRecord(
  connectionId: string,
  contentType: string,
  post: WordPressPostView,
): SourceContentRecord {
  const metadata: Record<string, JsonValue> = {
    authorId: post.author ?? null,
    categoryIds: [...post.categoryIds],
    tagIds: [...post.tagIds],
    customTaxonomyIds: Object.fromEntries(
      Object.entries(post.customTaxonomyIds ?? {}).map(([key, ids]) => [key, [...ids]]),
    ),
    featuredMediaId: post.featuredMediaId ?? null,
    parentRemoteId: post.parentId === undefined ? null : String(post.parentId),
    template: post.template ?? null,
    menuOrder: post.menuOrder ?? 0,
    passwordProtected: Boolean(post.password),
    commentStatus: post.commentStatus ?? null,
    pingStatus: post.pingStatus ?? null,
    sticky: post.sticky ?? null,
    format: post.format ?? null,
  };
  return {
    connectionId,
    contentType,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    remoteId: String(post.id),
    remoteUrl: post.link,
    title: post.title,
    excerpt: post.excerpt,
    contentHtml: post.contentHtml,
    slug: post.slug,
    status: post.status,
    ...(post.dateGmt === undefined ? {} : { publishedAt: post.dateGmt }),
    ...(post.modifiedGmt ? { modifiedAt: post.modifiedGmt } : {}),
    managed: post.ownership.managed,
    ...(post.ownership.publicationId ? { publicationId: post.ownership.publicationId } : {}),
    ...(post.ownership.groupId ? { groupId: post.ownership.groupId } : {}),
    ...(post.ownership.routeId ? { routeId: post.ownership.routeId } : {}),
    metadata,
  };
}

function sourceContentTypeRecord(
  connectionId: string,
  type: WordPressContentTypeView,
): SourceContentTypeRecord {
  return {
    connectionId,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    key: type.restBase,
    label: type.name,
    hierarchical: type.hierarchical,
    metadata: {
      wordpressTypeSlug: type.slug,
      restNamespace: type.restNamespace ?? null,
      taxonomies: [...type.taxonomies],
      ...(type.supports === undefined ? {} : { supports: [...type.supports] }),
    },
  };
}

function taxonomyKind(taxonomyKey: string): "category" | "tag" | "custom" {
  return taxonomyKey === "category" ? "category" : taxonomyKey === "post_tag" ? "tag" : "custom";
}

function sourceTaxonomyDefinitionRecord(
  connectionId: string,
  taxonomy: WordPressTaxonomyView,
): SourceTaxonomyDefinitionRecord {
  return {
    connectionId,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    taxonomyKey: taxonomy.key,
    label: taxonomy.label,
    kind: taxonomyKind(taxonomy.key),
    hierarchical: taxonomy.hierarchical,
    contentTypes: [...taxonomy.contentTypes],
    metadata: {
      restBase: taxonomy.restBase,
      restNamespace: taxonomy.restNamespace ?? null,
    },
  };
}

function sourceTaxonomyRecord(
  connectionId: string,
  taxonomyKey: string,
  term: { readonly id: number; readonly name: string; readonly slug: string; readonly description?: string; readonly count?: number },
  taxonomy?: WordPressTaxonomyView,
): SourceTaxonomyRecord {
  const kind = taxonomyKind(taxonomyKey);
  return {
    connectionId,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    ...(kind === "custom" ? { taxonomyKey } : {}),
    kind,
    remoteId: String(term.id),
    name: term.name,
    slug: term.slug,
    ...(term.description ? { description: term.description } : {}),
    ...(term.count === undefined ? {} : { count: term.count }),
    metadata: {
      wordpressTermId: term.id,
      ...(taxonomy ? {
        restBase: taxonomy.restBase,
        restNamespace: taxonomy.restNamespace ?? null,
      } : {}),
    },
  };
}

function sourceMetaFieldDefinition(
  connectionId: string,
  contentType: string,
  field: WordPressRestMetaFieldDefinition,
): SourceMetaFieldDefinition {
  return {
    key: field.key,
    type: field.type,
    nullable: field.nullable,
    ...(field.title ? { title: field.title } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.enum ? { enum: field.enum } : {}),
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    metadata: {
      extensionId: WORDPRESS_REST_EXTENSION_ID,
      connectionId,
      contentType,
      source: "wordpress-rest-meta",
    },
  };
}

function validMetaValue(field: WordPressRestMetaFieldDefinition, value: JsonValue): boolean {
  if (value === null) return field.nullable;
  if (field.enum && !field.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return false;
  }
  switch (field.type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function sourceAuthorRecord(connectionId: string, author: WordPressUserView): SourceAuthorRecord {
  return {
    connectionId,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    remoteId: String(author.id),
    displayName: author.name,
    slug: author.slug,
    ...(author.link ? { link: author.link } : {}),
    ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
    metadata: { wordpressUserId: author.id },
  };
}

function canonicalWordPressAssetId(
  connectionId: string,
  mediaId: number,
  routeScoped: boolean,
): string {
  return routeScoped
    ? `wordpress-media-${encodeURIComponent(connectionId)}-${mediaId}`
    : `wordpress-media-${mediaId}`;
}

function sourceAssetRecord(connectionId: string, media: WordPressMediaView): SourceAssetRecord {
  return {
    connectionId,
    extensionId: WORDPRESS_REST_EXTENSION_ID,
    remoteId: String(media.id),
    sourceUrl: media.sourceUrl,
    kind: "image",
    ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    ...(media.title ? { title: media.title } : {}),
    ...(media.alt ? { alt: media.alt } : {}),
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
    ...(media.modifiedGmt ? { modifiedAt: media.modifiedGmt } : {}),
    metadata: {
      wordpressMediaId: media.id,
      slug: media.slug,
    },
  };
}

function sourceRevision(revision: WordPressRevisionView): SourceContentRevision {
  return {
    remoteRevisionId: String(revision.id),
    title: revision.title,
    excerpt: revision.excerpt,
    contentHtml: revision.contentHtml,
    ...(revision.dateGmt === undefined ? {} : { createdAt: revision.dateGmt }),
    ...(revision.modifiedGmt ? { modifiedAt: revision.modifiedGmt } : {}),
    metadata: {
      parentId: revision.parent ?? null,
      authorId: revision.author ?? null,
    },
  };
}

function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function destinationOverride(
  publication: Publication,
  groupId: string | undefined,
  routeId: string | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!groupId || !routeId) return undefined;
  const root = publication.current.content.attributes.destinationOverrides;
  if (!isRecord(root) || !isRecord(root.groups)) return undefined;
  const group = root.groups[groupId];
  if (!isRecord(group) || !isRecord(group.routes)) return undefined;
  const route = group.routes[routeId];
  return isRecord(route) ? route : undefined;
}

function plainText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function remoteIdentity(post: WordPressPostView): RemoteIdentity {
  return {
    id: String(post.id),
    url: post.link,
    ...(post.modifiedGmt ? { version: post.modifiedGmt } : {}),
  };
}

function routeForImport(
  groupId: string,
  routeId: string,
  connectionId: string,
  group: { readonly routes: readonly PublicationRoute[] },
): PublicationRoute {
  const route = group.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`Publication group ${groupId} does not contain route ${routeId}`);
  if (route.destination.extensionId !== WORDPRESS_REST_EXTENSION_ID) {
    throw new Error(`Publication route ${routeId} is not a WordPress route`);
  }
  if (route.destination.connectionId !== connectionId) {
    throw new Error(`Publication route ${routeId} belongs to a different connection`);
  }
  if (!route.enabled) throw new Error(`Publication route ${routeId} is disabled`);
  return route;
}

function wordpressGmtInstant(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("WordPress GMT date is empty");
  const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid WordPress GMT date: ${value}`);
  return parsed.toISOString();
}

function importProjectionRoute(route: PublicationRoute, post: WordPressPostView): PublicationRoute {
  const supported = new Set(["publish", "draft", "pending", "private", "future"]);
  if (!supported.has(post.status)) {
    throw new Error(`WordPress post status ${post.status} cannot be imported into an active publication route`);
  }
  return {
    ...route,
    variant: {
      status: post.status,
      slug: post.slug,
      ...(post.status === "future" && post.dateGmt ? { scheduledAt: wordpressGmtInstant(post.dateGmt) } : {}),
    },
  };
}

export class WordPressSourceManager implements OperatorSourceContentManager {
  readonly #content: WordPressContentService;
  readonly #publisher: WordPressRestPublisher;
  readonly #publicationGroups: PublicationGroupManager;
  readonly #publications: PublicationWorkspaceManager;
  readonly #projectionState: ProjectionStateStore;
  readonly #distributionHistory: DistributionHistoryStore;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(options: WordPressSourceManagerOptions) {
    this.#content = options.content;
    this.#publisher = options.publisher;
    this.#publicationGroups = options.publicationGroups;
    this.#publications = options.publications;
    this.#projectionState = options.projectionState;
    this.#distributionHistory = options.distributionHistory;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  async listContentTypes(connectionId: string): Promise<readonly SourceContentTypeRecord[]> {
    return (await this.#content.listContentTypes(connectionId))
      .map((type) => sourceContentTypeRecord(connectionId, type));
  }

  async list(connectionId: string, query: SourceContentQuery = {}): Promise<SourceContentPage> {
    const contentType = query.contentType ?? this.#content.defaultContentType(connectionId);
    const page = await this.#content.list(connectionId, {
      contentType,
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { perPage: query.limit }),
    });
    return {
      items: page.items.map((post) => sourceRecord(connectionId, contentType, post)),
      page: page.page,
      limit: page.perPage,
      hasMore: page.hasMore,
    };
  }

  async listTaxonomyDefinitions(
    connectionId: string,
    contentType: string,
  ): Promise<readonly SourceTaxonomyDefinitionRecord[]> {
    return (await this.#content.listTaxonomies(connectionId, contentType))
      .map((taxonomy) => sourceTaxonomyDefinitionRecord(connectionId, taxonomy));
  }

  async createTaxonomy(
    connectionId: string,
    body: SourceTaxonomyCreateBody,
  ): Promise<SourceTaxonomyRecord> {
    if (body.taxonomyKey) {
      if (!body.contentType) throw new Error("Custom taxonomy creation requires contentType");
      const taxonomy = (await this.#content.listTaxonomies(connectionId, body.contentType))
        .find((candidate) => candidate.key === body.taxonomyKey);
      if (!taxonomy) {
        throw new Error(`WordPress taxonomy ${body.taxonomyKey} is not attached to content type ${body.contentType}`);
      }
      const term = await this.#content.createTermForTaxonomy(connectionId, taxonomy.key, body.contentType, {
        name: body.name,
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.description === undefined ? {} : { description: body.description }),
      });
      return sourceTaxonomyRecord(connectionId, taxonomy.key, term, taxonomy);
    }
    if (body.kind !== "category" && body.kind !== "tag") {
      throw new Error("Legacy taxonomy creation requires category or tag kind");
    }
    const term = await this.#content.createTerm(connectionId, body.kind, {
      name: body.name,
      ...(body.slug === undefined ? {} : { slug: body.slug }),
      ...(body.description === undefined ? {} : { description: body.description }),
    });
    return sourceTaxonomyRecord(connectionId, body.kind === "category" ? "category" : "post_tag", term);
  }

  async listTaxonomy(connectionId: string, query: SourceTaxonomyQuery): Promise<SourceTaxonomyPage> {
    if (query.taxonomyKey) {
      if (!query.contentType) throw new Error("Custom taxonomy lookup requires contentType");
      const taxonomy = (await this.#content.listTaxonomies(connectionId, query.contentType))
        .find((candidate) => candidate.key === query.taxonomyKey);
      if (!taxonomy) {
        throw new Error(`WordPress taxonomy ${query.taxonomyKey} is not attached to content type ${query.contentType}`);
      }
      const page = await this.#content.listTermsForTaxonomy(
        connectionId,
        taxonomy.key,
        query.contentType,
        {
          ...(query.search ? { search: query.search } : {}),
          ...(query.page === undefined ? {} : { page: query.page }),
          ...(query.limit === undefined ? {} : { perPage: query.limit }),
        },
      );
      return {
        items: page.items.map((term) => sourceTaxonomyRecord(connectionId, taxonomy.key, term, taxonomy)),
        page: page.page,
        limit: page.perPage,
        hasMore: page.hasMore,
      };
    }
    if (query.kind !== "category" && query.kind !== "tag") {
      throw new Error("Legacy taxonomy lookup requires category or tag kind");
    }
    const page = await this.#content.listTerms(connectionId, query.kind, {
      ...(query.search ? { search: query.search } : {}),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { perPage: query.limit }),
    });
    const taxonomyKey = query.kind === "category" ? "category" : "post_tag";
    return {
      items: page.items.map((term) => sourceTaxonomyRecord(connectionId, taxonomyKey, term)),
      page: page.page,
      limit: page.perPage,
      hasMore: page.hasMore,
    };
  }

  async listSeoFields(
    connectionId: string,
    contentType: string,
  ): Promise<readonly SourceSeoFieldDefinition[]> {
    const normalized = contentType.trim();
    if (!normalized) throw new Error("Source SEO content type is required");
    const fields = discoverSeoFields(await this.#content.listRestMetaFields(connectionId, normalized));
    return fields.map((field) => ({
      semantic: field.semantic,
      key: field.key,
      label: field.label,
      provider: field.provider,
      ...(field.description ? { description: field.description } : {}),
      metadata: {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType: normalized,
        source: "wordpress-rest-meta",
      },
    }));
  }

  async setSeoValues(
    connectionId: string,
    body: SourceSeoValuesBody,
  ): Promise<SourceSeoValuesResult> {
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("Source SEO content type is required");
    const fields = await this.listSeoFields(connectionId, contentType);
    const bySemantic = new Map(fields.map((field) => [field.semantic, field] as const));
    const normalized: Partial<Record<SourceSeoSemantic, string>> = {};
    const metaValues: Record<string, JsonValue> = {};

    for (const [rawSemantic, rawValue] of Object.entries(body.values)) {
      const semantic = rawSemantic as SourceSeoSemantic;
      if (!["title", "description", "canonical", "focus_keyphrase"].includes(semantic)) {
        throw new Error(`Unsupported source SEO semantic: ${rawSemantic}`);
      }
      const field = bySemantic.get(semantic);
      if (!field) {
        throw new Error(`WordPress SEO field is not writable for ${contentType}: ${semantic}`);
      }
      if (typeof rawValue !== "string") {
        throw new Error(`WordPress SEO value must be a string: ${semantic}`);
      }
      const value = rawValue.trim();
      const maxLength = semantic === "canonical" ? 2048 : semantic === "description" ? 1000 : 500;
      if (value.length > maxLength) {
        throw new Error(`WordPress SEO value is too long: ${semantic}`);
      }
      if (semantic === "canonical" && value) {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error("WordPress SEO canonical must be an absolute URL");
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("WordPress SEO canonical must use http or https");
        }
      }
      normalized[semantic] = value;
      metaValues[field.key] = value;
    }

    const result = await this.setMetaValues(connectionId, {
      publicationId: body.publicationId,
      expectedVersion: body.expectedVersion,
      contentType,
      values: metaValues,
      ...(body.groupId ? { groupId: body.groupId } : {}),
      ...(body.routeId ? { routeId: body.routeId } : {}),
    });
    return {
      publication: result.publication,
      contentType,
      values: normalized,
    };
  }

  async listMetaFields(
    connectionId: string,
    contentType: string,
  ): Promise<readonly SourceMetaFieldDefinition[]> {
    const normalized = contentType.trim();
    if (!normalized) throw new Error("Source meta content type is required");
    return (await this.#content.listRestMetaFields(connectionId, normalized))
      .map((field) => sourceMetaFieldDefinition(connectionId, normalized, field));
  }

  async setMetaValues(
    connectionId: string,
    body: SourceMetaValuesBody,
  ): Promise<SourceMetaValuesResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(`Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`);
    }
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("Source meta content type is required");

    if (body.groupId !== undefined || body.routeId !== undefined) {
      if (!body.groupId || !body.routeId) throw new Error("Route-scoped WordPress settings require both groupId and routeId");
      const route = await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
      if (route.destination.channel !== contentType) throw new Error("WordPress route content type does not match REST meta content type");
    } else {
      if (
        current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
        current.publication.provenance.connectionId !== connectionId
      ) {
        throw new Error("Source meta connection does not match the publication source");
      }
      const wordpress = current.publication.current.content.attributes.wordpress;
      if (!isRecord(wordpress) || wordpress.contentType !== contentType) {
        throw new Error("Source meta content type does not match the publication source");
      }
    }

    const fields = await this.#content.listRestMetaFields(connectionId, contentType);
    const byKey = new Map(fields.map((field) => [field.key, field] as const));
    const values: Record<string, JsonValue> = {};
    for (const [rawKey, value] of Object.entries(body.values)) {
      const key = rawKey.trim();
      const field = byKey.get(key);
      if (!field) throw new Error(`WordPress REST meta field is not exposed for ${contentType}: ${key}`);
      if (!validMetaValue(field, value)) throw new Error(`WordPress REST meta value does not match schema: ${key}`);
      values[key] = value;
    }

    const publication = await this.#publications.setSourceMetaValues(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType,
        values,
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    return { publication, contentType, values };
  }

  async setStandardTaxonomy(
    connectionId: string,
    body: SourceStandardTaxonomyBody,
  ): Promise<SourceStandardTaxonomyResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(`Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`);
    }
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("WordPress taxonomy content type is required");
    const route = await assertTargetWordPressRoute(
      this.#publicationGroups,
      current.publication,
      connectionId,
      body.groupId,
      body.routeId,
    );
    if (route.destination.channel !== contentType) {
      throw new Error("WordPress route content type does not match standard taxonomy content type");
    }

    const publication = await this.#publications.setSourceStandardTaxonomy(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType,
        groupId: body.groupId,
        routeId: body.routeId,
        categories: body.categories,
        tags: body.tags,
      },
    );
    const scoped = destinationOverride(publication.publication, body.groupId, body.routeId);
    const source = scoped?.standardTaxonomy;
    if (!isRecord(source)) throw new Error("Canonical route-scoped standard taxonomy was not persisted");
    const categories = Array.isArray(source.categories)
      ? source.categories.filter((value): value is string => typeof value === "string")
      : [];
    const tags = Array.isArray(source.tags)
      ? source.tags.filter((value): value is string => typeof value === "string")
      : [];
    return { publication, contentType, categories, tags };
  }

  async setTaxonomySelections(
    connectionId: string,
    body: SourceTaxonomySelectionBody,
  ): Promise<SourceTaxonomySelectionResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(`Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`);
    }
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("Source taxonomy content type is required");

    if (body.groupId !== undefined || body.routeId !== undefined) {
      if (!body.groupId || !body.routeId) throw new Error("Route-scoped WordPress settings require both groupId and routeId");
      const route = await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
      if (route.destination.channel !== contentType) throw new Error("WordPress route content type does not match taxonomy content type");
    } else {
      if (
        current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
        current.publication.provenance.connectionId !== connectionId
      ) {
        throw new Error("Source taxonomy connection does not match the publication source");
      }
      const wordpress = current.publication.current.content.attributes.wordpress;
      if (!isRecord(wordpress) || wordpress.contentType !== contentType) {
        throw new Error("Source taxonomy content type does not match the publication source");
      }
    }

    const definitions = await this.#content.listTaxonomies(connectionId, contentType);
    const byKey = new Map(definitions.map((definition) => [definition.key, definition] as const));
    const taxonomies: Record<string, {
      readonly restBase: string;
      readonly restNamespace?: string;
      readonly names: readonly string[];
    }> = {};
    for (const [taxonomyKey, names] of Object.entries(body.selections)) {
      if (taxonomyKey === "category" || taxonomyKey === "post_tag") throw new Error("Categories and tags must use their existing canonical fields");
      const definition = byKey.get(taxonomyKey);
      if (!definition) throw new Error(`WordPress taxonomy ${taxonomyKey} is not attached to content type ${contentType}`);
      taxonomies[taxonomyKey] = {
        restBase: definition.restBase,
        ...(definition.restNamespace ? { restNamespace: definition.restNamespace } : {}),
        names,
      };
    }

    const publication = await this.#publications.setSourceTaxonomies(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType,
        taxonomies,
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    const scoped = destinationOverride(publication.publication, body.groupId, body.routeId);
    const source = scoped ? scoped.taxonomies : publication.publication.current.content.attributes.sourceTaxonomies;
    if (!isRecord(source) || !isRecord(source.taxonomies)) throw new Error("Canonical source taxonomy selections were not persisted");
    const selections: Record<string, readonly string[]> = {};
    for (const [taxonomyKey, value] of Object.entries(source.taxonomies)) {
      if (!isRecord(value) || !Array.isArray(value.names)) continue;
      selections[taxonomyKey] = value.names.filter((name): name is string => typeof name === "string");
    }
    return { publication, contentType, selections };
  }

  async setEditorialOptions(
    connectionId: string,
    body: SourceEditorialOptionsBody,
  ): Promise<SourceEditorialOptionsResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(`Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`);
    }
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("Source editorial content type is required");

    if (body.groupId !== undefined || body.routeId !== undefined) {
      if (!body.groupId || !body.routeId) throw new Error("Route-scoped WordPress settings require both groupId and routeId");
      const route = await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
      if (route.destination.channel !== contentType) {
        throw new Error("WordPress route content type does not match editorial content type");
      }
    } else {
      if (
        current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
        current.publication.provenance.connectionId !== connectionId
      ) {
        throw new Error("Source editorial options connection does not match the publication source");
      }
      const wordpress = current.publication.current.content.attributes.wordpress;
      if (!isRecord(wordpress) || wordpress.contentType !== contentType) {
        throw new Error("Source editorial options content type does not match the publication source");
      }
    }

    const contentTypes = await this.#content.listContentTypes(connectionId);
    const resolvedType = contentTypes.find((candidate) => candidate.restBase === contentType);
    if (!resolvedType) throw new Error(`WordPress content type is not available on this connection: ${contentType}`);
    const supportsComments = resolvedType.supports.includes("comments");
    if (!supportsComments && (body.commentStatus !== undefined || body.pingStatus !== undefined)) {
      throw new Error(`WordPress content type does not support discussion options: ${contentType}`);
    }
    if (body.sticky !== undefined && resolvedType.slug !== "post") {
      throw new Error(`WordPress content type does not support sticky state: ${contentType}`);
    }
    const formats = new Set(["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"]);
    const format = body.format?.trim();
    if (format !== undefined) {
      if (!resolvedType.supports.includes("post-formats")) throw new Error(`WordPress content type does not support post formats: ${contentType}`);
      if (!formats.has(format)) throw new Error("Unsupported WordPress post format");
    }
    if (body.sticky === true && body.password.length > 0) throw new Error("WordPress sticky posts cannot be password protected");

    const publication = await this.#publications.setSourceEditorialOptions(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType,
        password: body.password,
        ...(body.commentStatus === undefined ? {} : { commentStatus: body.commentStatus }),
        ...(body.pingStatus === undefined ? {} : { pingStatus: body.pingStatus }),
        ...(body.sticky === undefined ? {} : { sticky: body.sticky }),
        ...(format === undefined ? {} : { format }),
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    return {
      publication,
      contentType,
      passwordProtected: body.password.length > 0,
      ...(body.commentStatus === undefined ? {} : { commentStatus: body.commentStatus }),
      ...(body.pingStatus === undefined ? {} : { pingStatus: body.pingStatus }),
      ...(body.sticky === undefined ? {} : { sticky: body.sticky }),
      ...(format === undefined ? {} : { format }),
    };
  }

  async setPageStructure(
    connectionId: string,
    body: SourcePageStructureBody,
  ): Promise<SourcePageStructureResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(`Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`);
    }
    const contentType = body.contentType.trim();
    if (!contentType) throw new Error("Source page content type is required");

    if (body.groupId !== undefined || body.routeId !== undefined) {
      if (!body.groupId || !body.routeId) throw new Error("Route-scoped WordPress settings require both groupId and routeId");
      const route = await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
      if (route.destination.channel !== contentType) {
        throw new Error("WordPress route content type does not match page-structure content type");
      }
    } else if (
      current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
      current.publication.provenance.connectionId !== connectionId
    ) {
      throw new Error("Source page structure connection does not match the publication source");
    }

    const contentTypes = await this.#content.listContentTypes(connectionId);
    const resolvedType = contentTypes.find((candidate) => candidate.restBase === contentType);
    if (!resolvedType) throw new Error(`WordPress content type is not available on this connection: ${contentType}`);
    if (!resolvedType.hierarchical) throw new Error(`WordPress content type does not support page hierarchy: ${contentType}`);

    if (body.parentRemoteId !== null) {
      const parentRemoteId = body.parentRemoteId.trim();
      if (!/^\d+$/.test(parentRemoteId)) throw new Error("Source page parentRemoteId must be null or a positive integer string");
      if (
        current.publication.provenance.connectionId === connectionId &&
        current.publication.provenance.remoteId === parentRemoteId
      ) {
        throw new Error("A WordPress page cannot be its own parent");
      }
      await this.#content.get(connectionId, parentRemoteId, contentType);
    }

    const publication = await this.#publications.setSourcePageStructure(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType,
        parentRemoteId: body.parentRemoteId === null ? null : body.parentRemoteId.trim(),
        template: body.template,
        menuOrder: body.menuOrder,
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    const scoped = destinationOverride(publication.publication, body.groupId, body.routeId);
    const sourcePage = scoped ? scoped.pageStructure : publication.publication.current.content.attributes.sourcePage;
    if (!isRecord(sourcePage)) throw new Error("Canonical source page structure was not persisted");
    return {
      publication,
      contentType,
      parentRemoteId: typeof sourcePage.parentRemoteId === "string" ? sourcePage.parentRemoteId : null,
      template: typeof sourcePage.template === "string" ? sourcePage.template : null,
      menuOrder: typeof sourcePage.menuOrder === "number" ? sourcePage.menuOrder : 0,
    };
  }

  async setPublishingState(
    connectionId: string,
    body: SourcePublishingStateBody,
  ): Promise<SourcePublishingStateResult> {
    const supported = new Set(["publish", "draft", "pending", "private", "future"]);
    if (!supported.has(body.status)) {
      throw new Error(`Unsupported WordPress publishing status: ${body.status}`);
    }
    let scheduledAt: string | undefined;
    if (body.status === "future") {
      if (!body.scheduledAt) throw new Error("WordPress future publishing state requires scheduledAt");
      const parsed = new Date(body.scheduledAt);
      if (Number.isNaN(parsed.getTime())) throw new Error("WordPress scheduledAt must be a valid instant");
      scheduledAt = parsed.toISOString();
    } else if (body.scheduledAt !== undefined) {
      throw new Error("WordPress scheduledAt is only allowed when status is future");
    }

    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(
        `Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`,
      );
    }
    if (body.groupId || body.routeId) {
      if (!body.groupId || !body.routeId) {
        throw new Error("Route-scoped WordPress publishing state requires both groupId and routeId");
      }
      await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
    } else if (
      current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
      current.publication.provenance.connectionId !== connectionId
    ) {
      throw new Error("Source publishing state connection does not match the publication source");
    }

    const publication = await this.#publications.setSourcePublishingState(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        status: body.status,
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    return {
      publication,
      status: body.status,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
  }

  async listAuthors(connectionId: string, query: SourceAuthorQuery = {}): Promise<SourceAuthorPage> {
    const page = await this.#content.listAuthors(connectionId, {
      ...(query.search ? { search: query.search } : {}),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { perPage: query.limit }),
    });
    return {
      items: page.items.map((author) => sourceAuthorRecord(connectionId, author)),
      page: page.page,
      limit: page.perPage,
      hasMore: page.hasMore,
    };
  }

  async assignAuthor(
    connectionId: string,
    remoteId: string,
    body: SourceAuthorAssignBody,
  ): Promise<SourceAuthorAssignResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(
        `Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`,
      );
    }
    if (body.groupId || body.routeId) {
      if (!body.groupId || !body.routeId) {
        throw new Error("Route-scoped WordPress author requires both groupId and routeId");
      }
      await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        body.groupId,
        body.routeId,
      );
    } else if (
      current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
      current.publication.provenance.connectionId !== connectionId
    ) {
      throw new Error("Source author connection does not match the publication source");
    }

    const author = await this.#content.getAuthor(connectionId, remoteId);
    const publication = await this.#publications.assignSourceAuthor(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        remoteId: String(author.id),
        displayName: author.name,
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.routeId ? { routeId: body.routeId } : {}),
      },
    );
    return {
      publication,
      author: sourceAuthorRecord(connectionId, author),
    };
  }

  async #assertAssetContext(
    current: Awaited<ReturnType<PublicationWorkspaceManager["get"]>>,
    connectionId: string,
    context: {
      readonly contentType?: string;
      readonly groupId?: string;
      readonly routeId?: string;
      readonly featured?: boolean;
    },
  ): Promise<void> {
    if (!current) throw new Error("Publication is not registered");
    const hasGroup = context.groupId !== undefined;
    const hasRoute = context.routeId !== undefined;
    if (hasGroup !== hasRoute) throw new Error("Route-scoped WordPress media requires both groupId and routeId");
    if (hasGroup && context.groupId && context.routeId) {
      if (context.featured) {
        throw new Error("Route-scoped asset attach/upload cannot set the global featured image");
      }
      const route = await assertTargetWordPressRoute(
        this.#publicationGroups,
        current.publication,
        connectionId,
        context.groupId,
        context.routeId,
      );
      const contentType = context.contentType?.trim();
      if (!contentType) throw new Error("Route-scoped WordPress media requires contentType");
      if (route.destination.channel !== contentType) {
        throw new Error("WordPress route content type does not match media content type");
      }
      return;
    }

    if (
      current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
      current.publication.provenance.connectionId !== connectionId
    ) {
      throw new Error("Source asset connection does not match the publication source");
    }
  }

  async listAssets(connectionId: string, query: SourceAssetQuery = {}): Promise<SourceAssetPage> {
    const page = await this.#content.listMedia(connectionId, {
      ...(query.search ? { search: query.search } : {}),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { perPage: query.limit }),
    });
    return {
      items: page.items.map((media) => sourceAssetRecord(connectionId, media)),
      page: page.page,
      limit: page.perPage,
      hasMore: page.hasMore,
    };
  }

  async uploadAsset(
    connectionId: string,
    input: SourceAssetUploadInput,
  ): Promise<SourceAssetAttachResult> {
    const current = await this.#publications.get(input.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${input.publicationId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(
        `Publication ${input.publicationId} changed from version ${input.expectedVersion} to ${current.version}`,
      );
    }
    await this.#assertAssetContext(current, connectionId, input);

    const media = await this.#content.uploadMedia(connectionId, {
      bytes: input.bytes,
      mediaType: input.mediaType,
      filename: input.filename,
      ...(input.alt === undefined ? {} : { alt: input.alt }),
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    const asset: PublicationAsset = {
      id: canonicalWordPressAssetId(connectionId, media.id, Boolean(input.groupId && input.routeId)),
      kind: "image",
      source: media.sourceUrl,
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(media.alt ? { alt: media.alt } : {}),
      attributes: {
        wordpressMediaId: media.id,
        sourceExtensionId: WORDPRESS_REST_EXTENSION_ID,
        sourceConnectionId: connectionId,
        sourceRemoteId: String(media.id),
        uploadedByBlogmaatic: true,
      },
    };

    try {
      const publication = await this.#publications.attachAsset(
        input.publicationId,
        input.expectedVersion,
        asset,
        input.featured ?? false,
      );
      return {
        publication,
        asset: sourceAssetRecord(connectionId, media),
      };
    } catch (error) {
      try {
        await this.#content.deleteMediaPermanent(connectionId, String(media.id));
      } catch (cleanupError) {
        throw new Error(
          `Canonical source asset attachment failed and WordPress media cleanup also failed for media ${media.id}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async attachAsset(
    connectionId: string,
    remoteId: string,
    body: SourceAssetAttachBody,
  ): Promise<SourceAssetAttachResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(
        `Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`,
      );
    }
    await this.#assertAssetContext(current, connectionId, body);

    const media = await this.#content.getMedia(connectionId, remoteId);
    const asset: PublicationAsset = {
      id: canonicalWordPressAssetId(connectionId, media.id, Boolean(body.groupId && body.routeId)),
      kind: "image",
      source: media.sourceUrl,
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(media.alt ? { alt: media.alt } : {}),
      attributes: {
        wordpressMediaId: media.id,
        sourceExtensionId: WORDPRESS_REST_EXTENSION_ID,
        sourceConnectionId: connectionId,
        sourceRemoteId: String(media.id),
      },
    };
    const publication = await this.#publications.attachAsset(
      body.publicationId,
      body.expectedVersion,
      asset,
      body.featured ?? false,
    );
    return {
      publication,
      asset: sourceAssetRecord(connectionId, media),
    };
  }

  async setFeaturedMedia(
    connectionId: string,
    body: SourceFeaturedMediaBody,
  ): Promise<SourceFeaturedMediaResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(
        `Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`,
      );
    }
    const route = await assertTargetWordPressRoute(
      this.#publicationGroups,
      current.publication,
      connectionId,
      body.groupId,
      body.routeId,
    );
    if (route.destination.channel !== body.contentType) {
      throw new Error("WordPress route content type does not match featured media content type");
    }
    if (body.mode === "asset") {
      const asset = current.publication.current.content.assets.find((candidate) => candidate.id === body.assetId);
      if (!asset) throw new Error(`Featured asset does not exist: ${String(body.assetId)}`);
      if (asset.kind !== "image") throw new Error(`Featured asset must be an image: ${String(body.assetId)}`);
      if (/^https?:\/\//i.test(asset.source)) {
        const attributes = asset.attributes;
        const sourceConnectionId = typeof attributes?.sourceConnectionId === "string"
          ? attributes.sourceConnectionId
          : undefined;
        const wordpressMediaId = typeof attributes?.wordpressMediaId === "number" &&
          Number.isSafeInteger(attributes.wordpressMediaId) &&
          attributes.wordpressMediaId > 0
          ? attributes.wordpressMediaId
          : undefined;
        const legacyOwned =
          current.publication.provenance.extensionId === WORDPRESS_REST_EXTENSION_ID &&
          current.publication.provenance.connectionId === connectionId &&
          sourceConnectionId === undefined &&
          wordpressMediaId !== undefined;
        if (!(sourceConnectionId === connectionId && wordpressMediaId !== undefined) && !legacyOwned) {
          throw new Error("Remote featured asset is not managed by the selected WordPress connection");
        }
      }
    }
    const publication = await this.#publications.setSourceFeaturedMedia(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        contentType: body.contentType,
        groupId: body.groupId,
        routeId: body.routeId,
        mode: body.mode,
        ...(body.assetId === undefined ? {} : { assetId: body.assetId }),
      },
    );
    return {
      publication,
      contentType: body.contentType,
      mode: body.mode,
      ...(body.assetId === undefined ? {} : { assetId: body.assetId }),
    };
  }

  async get(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<SourceContentRecord> {
    const resolved = contentType ?? this.#content.defaultContentType(connectionId);
    return sourceRecord(connectionId, resolved, await this.#content.get(connectionId, remoteId, resolved));
  }

  async revisions(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<readonly SourceContentRevision[]> {
    const resolved = contentType ?? this.#content.defaultContentType(connectionId);
    return (await this.#content.revisions(connectionId, remoteId, resolved)).map(sourceRevision);
  }

  async restoreRevision(
    connectionId: string,
    remoteId: string,
    remoteRevisionId: string,
    body: SourceRevisionRestoreBody,
  ): Promise<SourceRevisionRestoreResult> {
    const current = await this.#publications.get(body.publicationId);
    if (!current) throw new Error(`Publication is not registered: ${body.publicationId}`);
    if (current.version !== body.expectedVersion) {
      throw new Error(
        `Publication ${body.publicationId} changed from version ${body.expectedVersion} to ${current.version}`,
      );
    }
    if (
      current.publication.provenance.extensionId !== WORDPRESS_REST_EXTENSION_ID ||
      current.publication.provenance.connectionId !== connectionId ||
      current.publication.provenance.remoteId !== remoteId
    ) {
      throw new Error("Source revision does not match the publication source identity");
    }

    const contentType = body.contentType ?? this.#content.defaultContentType(connectionId);
    const storedType = current.publication.current.content.attributes.wordpress;
    if (
      isRecord(storedType) &&
      typeof storedType.contentType === "string" &&
      storedType.contentType !== contentType
    ) {
      throw new Error("Source revision content type does not match the publication source");
    }
    const revision = await this.#content.getRevision(connectionId, remoteId, remoteRevisionId, contentType);
    const publication = await this.#publications.restoreSourceRevision(
      body.publicationId,
      body.expectedVersion,
      {
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        remoteId,
        remoteRevisionId: String(revision.id),
        title: revision.title,
        ...(plainText(revision.excerpt) ? { summary: plainText(revision.excerpt) } : {}),
        contentHtml: revision.contentHtml,
        ...(revision.modifiedGmt ? { sourceModifiedAt: revision.modifiedGmt } : {}),
        ...(revision.author === undefined ? {} : { sourceAuthorId: revision.author }),
      },
    );
    return {
      publication,
      revision: sourceRevision(revision),
    };
  }

  async import(
    connectionId: string,
    remoteId: string,
    body: SourceContentImportBody,
  ): Promise<SourceContentImportResult> {
    const groupEntry = await this.#publicationGroups.get(body.groupId);
    if (!groupEntry) throw new Error(`Publication group is not registered: ${body.groupId}`);
    if (!groupEntry.enabled) throw new Error(`Publication group is disabled: ${body.groupId}`);
    const route = routeForImport(body.groupId, body.routeId, connectionId, groupEntry.group);
    const explicitContentType = body.contentType?.trim();
    if (explicitContentType && route.destination.channel !== explicitContentType) {
      throw new Error(
        `Publication route ${body.routeId} targets WordPress content type ${route.destination.channel}, not ${explicitContentType}`,
      );
    }
    const contentType = explicitContentType ?? (
      route.destination.channel === "posts"
        ? this.#content.defaultContentType(connectionId)
        : route.destination.channel
    );
    const snapshot = await this.#content.importSnapshot(connectionId, remoteId, contentType);

    let workspace = await this.#publications.findImportedSource(
      WORDPRESS_REST_EXTENSION_ID,
      connectionId,
      remoteId,
    );

    if (
      snapshot.post.ownership.managed &&
      snapshot.post.ownership.publicationId !== workspace?.publication.id
    ) {
      throw new Error(
        `WordPress post is already managed by publication ${snapshot.post.ownership.publicationId ?? "unknown"}`,
      );
    }

    if (!workspace) {
      const publication = this.#importedPublication(
        connectionId,
        contentType,
        snapshot,
        body.groupId,
        body.routeId,
      );
      workspace = await this.#publications.registerImported(publication);
    }

    const existingTargets = workspace.publication.current.content.attributes.publishingTargets;
    const existingTargetIds = (
      existingTargets !== null &&
      typeof existingTargets === "object" &&
      !Array.isArray(existingTargets) &&
      Array.isArray((existingTargets as Readonly<Record<string, unknown>>).groupIds)
    )
      ? ((existingTargets as Readonly<Record<string, unknown>>).groupIds as readonly unknown[])
          .filter((value): value is string => typeof value === "string")
      : [];
    if (!existingTargetIds.includes(body.groupId)) {
      workspace = await this.#publications.update(workspace.publication.id, {
        expectedVersion: workspace.version,
        publishingTargetGroupIds: [...existingTargetIds, body.groupId],
      });
    }

    const projection = await this.#publisher.compile({
      publication: workspace.publication,
      route: importProjectionRoute(route, snapshot.post),
      groupId: groupEntry.group.id,
    });

    let adopted = snapshot.post;
    if (
      !snapshot.post.ownership.managed ||
      snapshot.post.ownership.publicationId !== workspace.publication.id ||
      snapshot.post.ownership.routeId !== route.id
    ) {
      adopted = await this.#content.adopt(connectionId, remoteId, projection, contentType);
    }

    const remote = remoteIdentity(adopted);
    const recordedAt = this.#now();
    await this.#projectionState.put({
      publicationId: workspace.publication.id,
      groupId: groupEntry.group.id,
      routeId: route.id,
      projectionId: projection.projectionId,
      extensionId: route.destination.extensionId,
      connectionId: route.destination.connectionId,
      sourceRevisionId: workspace.publication.current.id,
      desiredFingerprint: projection.fingerprint,
      remote,
      updatedAt: recordedAt,
    });

    const receipt = {
      publicationId: workspace.publication.id,
      revisionId: workspace.publication.current.id,
      groupId: groupEntry.group.id,
      routeId: route.id,
      projectionId: projection.projectionId,
      status: "verified" as const,
      policy: {
        effect: "allow" as const,
        reason: "Explicit WordPress source import and ownership adoption",
      },
      remote,
      evidence: {
        action: "wordpress.import",
        contentType,
        nativeStatus: adopted.status,
        sourceModifiedAt: adopted.modifiedGmt ?? null,
      },
      observed: {
        state: "synchronized" as const,
        remote,
        fingerprint: projection.fingerprint,
        observedAt: recordedAt,
        detail: "Existing WordPress post explicitly adopted into Blogmaatic ownership",
      },
      completedAt: recordedAt,
    };

    await this.#distributionHistory.append({
      id: [
        "import",
        workspace.publication.id,
        workspace.publication.current.id,
        groupEntry.group.id,
        route.id,
        remote.id,
      ].map(encodeURIComponent).join(":"),
      publicationId: workspace.publication.id,
      revisionId: workspace.publication.current.id,
      groupId: groupEntry.group.id,
      routeId: route.id,
      projectionId: projection.projectionId,
      destination: route.destination,
      groupSnapshot: groupEntry.group,
      receipt,
      recordedAt,
    });

    return {
      publication: workspace,
      remote: sourceRecord(connectionId, contentType, adopted),
    };
  }

  async trash(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<SourceContentRecord> {
    const resolved = contentType ?? this.#content.defaultContentType(connectionId);
    return sourceRecord(
      connectionId,
      resolved,
      await this.#content.trash(connectionId, remoteId, resolved),
    );
  }

  async restore(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<SourceContentRecord> {
    const resolved = contentType ?? this.#content.defaultContentType(connectionId);
    return sourceRecord(
      connectionId,
      resolved,
      await this.#content.restore(connectionId, remoteId, resolved),
    );
  }

  async deletePermanent(
    connectionId: string,
    remoteId: string,
    contentType?: string,
  ): Promise<SourceContentRecord> {
    const resolved = contentType ?? this.#content.defaultContentType(connectionId);
    const current = await this.#content.get(connectionId, remoteId, resolved);
    const deleted = await this.#content.deletePermanent(connectionId, remoteId, resolved);
    if (current.ownership.publicationId && current.ownership.routeId) {
      await this.#projectionState.delete(
        current.ownership.publicationId,
        current.ownership.routeId,
        current.ownership.groupId,
      );
    }
    return sourceRecord(connectionId, resolved, deleted);
  }

  #importedPublication(
    connectionId: string,
    contentType: string,
    snapshot: Awaited<ReturnType<WordPressContentService["importSnapshot"]>>,
    publishingTargetGroupId: string,
    publishingTargetRouteId: string,
  ): Publication {
    const now = this.#now();
    const revisionId = `revision_${this.#id()}`;
    const blocks: PublicationBlock[] = snapshot.post.contentHtml.trim()
      ? [{
        id: "wordpress-source-html",
        kind: "embed",
        data: { html: snapshot.post.contentHtml },
      }]
      : [];
    const assets: PublicationAsset[] = snapshot.featuredMedia
      ? [{
        id: `wordpress-media-${snapshot.featuredMedia.id}`,
        kind: "image",
        source: snapshot.featuredMedia.source_url,
        attributes: {
          featured: true,
          wordpressMediaId: snapshot.featuredMedia.id,
          sourceExtensionId: WORDPRESS_REST_EXTENSION_ID,
          sourceConnectionId: connectionId,
          sourceRemoteId: String(snapshot.featuredMedia.id),
        },
      }]
      : [];

    return {
      id: `publication_${this.#id()}`,
      createdAt: now,
      ...(snapshot.post.slug ? { slug: snapshot.post.slug } : {}),
      status: "draft",
      current: {
        id: revisionId,
        ordinal: 1,
        createdAt: now,
        content: {
          schemaVersion: 1,
          title: snapshot.post.title.trim() || `WordPress post ${snapshot.post.id}`,
          ...(plainText(snapshot.post.excerpt) ? { summary: plainText(snapshot.post.excerpt) } : {}),
          language: "en",
          blocks,
          assets,
          tags: [...snapshot.tagNames],
          attributes: {
            categories: [...snapshot.categoryNames],
            publishingTargets: { groupIds: [publishingTargetGroupId] },
            ...(snapshot.post.password !== undefined ||
                snapshot.post.commentStatus !== undefined ||
                snapshot.post.pingStatus !== undefined ||
                snapshot.post.sticky !== undefined ||
                snapshot.post.format !== undefined ? {
              sourceEditorial: {
                extensionId: WORDPRESS_REST_EXTENSION_ID,
                connectionId,
                contentType,
                password: snapshot.post.password ?? "",
                ...(snapshot.post.commentStatus === undefined ? {} : { commentStatus: snapshot.post.commentStatus }),
                ...(snapshot.post.pingStatus === undefined ? {} : { pingStatus: snapshot.post.pingStatus }),
                ...(snapshot.post.sticky === undefined ? {} : { sticky: snapshot.post.sticky }),
                ...(snapshot.post.format === undefined ? {} : { format: snapshot.post.format }),
              },
            } : {}),
            ...(snapshot.post.parentId !== undefined ||
                snapshot.post.template !== undefined ||
                snapshot.post.menuOrder !== undefined ? {
              sourcePage: {
                extensionId: WORDPRESS_REST_EXTENSION_ID,
                connectionId,
                contentType,
                parentRemoteId: snapshot.post.parentId === undefined ? null : String(snapshot.post.parentId),
                template: snapshot.post.template ?? null,
                menuOrder: snapshot.post.menuOrder ?? 0,
              },
            } : {}),
            ...(snapshot.post.author === undefined ? {} : {
              sourceAuthor: {
                extensionId: WORDPRESS_REST_EXTENSION_ID,
                connectionId,
                remoteId: String(snapshot.post.author),
              },
            }),
            ...((snapshot.customTaxonomies ?? []).length > 0 ? {
              sourceTaxonomies: {
                extensionId: WORDPRESS_REST_EXTENSION_ID,
                connectionId,
                contentType,
                taxonomies: Object.fromEntries((snapshot.customTaxonomies ?? []).map((taxonomy) => [
                  taxonomy.taxonomyKey,
                  {
                    restBase: taxonomy.restBase,
                    ...(taxonomy.restNamespace ? { restNamespace: taxonomy.restNamespace } : {}),
                    names: [...taxonomy.names],
                  },
                ])),
              },
            } : {}),
            ...(snapshot.restMeta && Object.keys(snapshot.restMeta.values).length > 0 ? {
              sourceMeta: {
                extensionId: WORDPRESS_REST_EXTENSION_ID,
                connectionId,
                contentType,
                values: snapshot.restMeta.values,
              },
            } : {}),
            sourcePublishing: {
              extensionId: WORDPRESS_REST_EXTENSION_ID,
              connectionId,
              status: snapshot.post.status,
              ...(snapshot.post.status === "future" && snapshot.post.dateGmt
                ? { scheduledAt: wordpressGmtInstant(snapshot.post.dateGmt) }
                : {}),
            },
            wordpress: {
              connectionId,
              groupId: publishingTargetGroupId,
              routeId: publishingTargetRouteId,
              contentType,
              remoteId: String(snapshot.post.id),
              remoteStatus: snapshot.post.status,
              authorId: snapshot.post.author ?? null,
              categoryIds: [...snapshot.post.categoryIds],
              tagIds: [...snapshot.post.tagIds],
              customTaxonomyIds: Object.fromEntries(
                Object.entries(snapshot.post.customTaxonomyIds ?? {}).map(([key, ids]) => [key, [...ids]]),
              ),
              featuredMediaId: snapshot.post.featuredMediaId ?? null,
              parentRemoteId: snapshot.post.parentId === undefined ? null : String(snapshot.post.parentId),
              template: snapshot.post.template ?? null,
              menuOrder: snapshot.post.menuOrder ?? 0,
              passwordProtected: Boolean(snapshot.post.password),
              commentStatus: snapshot.post.commentStatus ?? null,
              pingStatus: snapshot.post.pingStatus ?? null,
              sticky: snapshot.post.sticky ?? null,
              format: snapshot.post.format ?? null,
              importedHtml: snapshot.post.contentHtml,
            },
          },
        },
      },
      canonicalUrl: snapshot.post.link,
      provenance: {
        source: "wordpress",
        extensionId: WORDPRESS_REST_EXTENSION_ID,
        connectionId,
        remoteId: String(snapshot.post.id),
        remoteUrl: snapshot.post.link,
        remoteVersion: snapshot.post.modifiedGmt ?? null,
        importedAt: now,
        importedRevisionId: revisionId,
      },
    };
  }
}
