import { randomUUID } from "node:crypto";

import type {
  AutomationControlPlane,
  ControlPlaneRunRecord,
  Page,
  PageRequest,
  PublicationWorkspaceEntry,
  PublicationWorkspaceListQuery,
  PublicationWorkspaceStore,
} from "@blogmaatic/control-plane";
import type { JsonValue, Publication, PublicationAsset, PublicationBlock, PublicationGroup, PublicationStatus } from "@blogmaatic/core";

import type { PublicationGroupManager } from "./publication-group-manager.js";

export type WorkspacePublicationStatus = Extract<PublicationStatus, "idea" | "draft" | "ready" | "approved" | "archived">;
export type PublicationBodyFormat = "plain" | "html";

export interface PublicationWorkspaceCreateInput {
  readonly title: string;
  readonly body?: string;
  readonly blocks?: readonly PublicationBlock[];
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly publishingTargetGroupIds?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceUpdateInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly body?: string;
  readonly blocks?: readonly PublicationBlock[];
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly featuredAssetId?: string | null;
  readonly publishingTargetGroupIds?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceDispatchResult {
  readonly publication: PublicationWorkspaceEntry;
  readonly runs: readonly ControlPlaneRunRecord[];
}

export interface PublicationWorkspaceManagerOptions {
  readonly store: PublicationWorkspaceStore;
  readonly publicationGroups: PublicationGroupManager;
  readonly controlPlane: AutomationControlPlane;
  readonly now?: () => string;
  readonly id?: () => string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function requireText(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeCategories(categories: readonly string[] | undefined): readonly string[] {
  if (!categories) return [];
  return [...new Set(categories.map((category) => category.trim()).filter(Boolean))];
}

function withoutFeaturedAttribute(
  attributes: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!attributes || attributes.featured === undefined) return attributes;
  const { featured: _featured, ...rest } = attributes;
  return Object.keys(rest).length ? rest : undefined;
}

function withFeaturedAsset(
  assets: readonly PublicationAsset[],
  featuredAssetId: string | null,
): readonly PublicationAsset[] {
  const selectedId = featuredAssetId?.trim() || null;
  if (selectedId) {
    const selected = assets.find((asset) => asset.id === selectedId);
    if (!selected) throw new Error(`Featured asset does not exist: ${selectedId}`);
    if (selected.kind !== "image") throw new Error(`Featured asset must be an image: ${selectedId}`);
  }

  return assets.map((asset) => {
    const clean = withoutFeaturedAttribute(asset.attributes);
    if (asset.id !== selectedId) {
      if (clean) return { ...asset, attributes: clean };
      if (!asset.attributes) return asset;
      const { attributes: _attributes, ...withoutAttributes } = asset;
      return withoutAttributes;
    }
    return {
      ...asset,
      attributes: {
        ...(clean ?? {}),
        featured: true,
      },
    };
  });
}

function normalizePublishingTargetGroupIds(groupIds: readonly string[] | undefined): readonly string[] {
  if (!groupIds) return [];
  return [...new Set(groupIds.map((groupId) => groupId.trim()).filter(Boolean))].sort();
}

export function publicationTargetGroupIds(publication: Publication): readonly string[] {
  const value = publication.current.content.attributes.publishingTargets;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const groupIds = (value as Readonly<Record<string, unknown>>).groupIds;
  if (!Array.isArray(groupIds)) return [];
  return normalizePublishingTargetGroupIds(
    groupIds.filter((groupId): groupId is string => typeof groupId === "string"),
  );
}

function withPublishingTargets(
  attributes: Readonly<Record<string, JsonValue>>,
  groupIds: readonly string[],
): Readonly<Record<string, JsonValue>> {
  const next: Record<string, JsonValue> = { ...attributes };
  const normalized = normalizePublishingTargetGroupIds(groupIds);
  if (normalized.length) {
    next.publishingTargets = { groupIds: [...normalized] };
  } else {
    delete next.publishingTargets;
  }
  return next;
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}

function withDestinationOverride(
  attributes: Readonly<Record<string, JsonValue>>,
  groupId: string,
  routeId: string,
  identity: {
    readonly extensionId: string;
    readonly connectionId: string;
    readonly channel: string;
  },
  patch: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const existingRoot = jsonRecord(attributes.destinationOverrides);
  const existingGroups = jsonRecord(existingRoot?.groups);
  const existingGroup = jsonRecord(existingGroups?.[groupId]);
  const existingRoutes = jsonRecord(existingGroup?.routes);
  const existingRoute = jsonRecord(existingRoutes?.[routeId]);

  const nextRoute: Record<string, JsonValue> = {
    ...(existingRoute ?? {}),
    extensionId: identity.extensionId,
    connectionId: identity.connectionId,
    channel: identity.channel,
    ...patch,
  };
  const nextRoutes: Record<string, JsonValue> = {
    ...(existingRoutes ?? {}),
    [routeId]: nextRoute,
  };
  const nextGroups: Record<string, JsonValue> = {
    ...(existingGroups ?? {}),
    [groupId]: {
      ...(existingGroup ?? {}),
      routes: nextRoutes,
    },
  };
  return {
    ...attributes,
    destinationOverrides: {
      schemaVersion: 1,
      groups: nextGroups,
    },
  };
}

function withCategories(
  attributes: Readonly<Record<string, JsonValue>>,
  categories: readonly string[],
): Readonly<Record<string, JsonValue>> {
  const next: Record<string, JsonValue> = { ...attributes };
  if (categories.length) next.categories = [...categories];
  else delete next.categories;
  return next;
}

function blocksFromBody(
  body: string | undefined,
  format: PublicationBodyFormat = "plain",
): readonly PublicationBlock[] {
  const text = body?.trim() ?? "";
  if (!text) return [];
  if (format === "html") {
    return [{
      id: "html-source",
      kind: "embed",
      data: { html: text },
    }];
  }
  return text
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({
      id: `paragraph-${index + 1}`,
      kind: "paragraph" as const,
      data: { text: paragraph },
    }));
}

const publicationBlockKinds = new Set([
  "heading",
  "paragraph",
  "image",
  "gallery",
  "quote",
  "code",
  "embed",
  "table",
  "callout",
]);

function normalizeBlocks(
  blocks: readonly PublicationBlock[],
  assets: readonly PublicationAsset[],
): readonly PublicationBlock[] {
  const seen = new Set<string>();
  return blocks.map((block, index) => {
    const id = typeof block.id === "string" ? block.id.trim() : "";
    if (!id) throw new Error(`Publication block ${index + 1} requires id`);
    if (seen.has(id)) throw new Error(`Publication blocks contain duplicate id: ${id}`);
    seen.add(id);
    if (!publicationBlockKinds.has(block.kind)) {
      throw new Error(`Publication block ${id} has unsupported kind: ${String(block.kind)}`);
    }
    if (!block.data || typeof block.data !== "object" || Array.isArray(block.data)) {
      throw new Error(`Publication block ${id} data must be an object`);
    }

    if (block.kind === "image") {
      const assetId = block.data.assetId;
      const src = block.data.src;
      if (typeof assetId === "string" && assetId.trim()) {
        const asset = assets.find((candidate) => candidate.id === assetId);
        if (!asset) throw new Error(`Publication image block ${id} references missing asset: ${assetId}`);
        if (asset.kind !== "image") throw new Error(`Publication image block ${id} asset must be an image: ${assetId}`);
      } else if (typeof src !== "string" || !src.trim()) {
        throw new Error(`Publication image block ${id} requires assetId`);
      }
    }

    return {
      id,
      kind: block.kind,
      data: block.data,
    };
  });
}

function contentChanged(input: PublicationWorkspaceUpdateInput): boolean {
  return input.title !== undefined ||
    input.body !== undefined ||
    input.blocks !== undefined ||
    input.summary !== undefined ||
    input.language !== undefined ||
    input.tags !== undefined ||
    input.categories !== undefined ||
    input.featuredAssetId !== undefined ||
    input.publishingTargetGroupIds !== undefined;
}

export class PublicationWorkspaceManager {
  readonly #store: PublicationWorkspaceStore;
  readonly #publicationGroups: PublicationGroupManager;
  readonly #controlPlane: AutomationControlPlane;
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(options: PublicationWorkspaceManagerOptions) {
    this.#store = options.store;
    this.#publicationGroups = options.publicationGroups;
    this.#controlPlane = options.controlPlane;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  list(query: PublicationWorkspaceListQuery = {}): Promise<Page<PublicationWorkspaceEntry>> {
    return this.#store.list(query);
  }

  get(publicationId: string): Promise<PublicationWorkspaceEntry | undefined> {
    return this.#store.get(publicationId);
  }

  listVersions(publicationId: string, query: PageRequest = {}): Promise<Page<PublicationWorkspaceEntry>> {
    return this.#store.listVersions(publicationId, query);
  }

  getVersion(publicationId: string, version: number): Promise<PublicationWorkspaceEntry | undefined> {
    return this.#store.getVersion(publicationId, version);
  }

  async #publishingTargetRoute(
    publication: Publication,
    groupId: string,
    routeId: string,
  ): Promise<PublicationGroup["routes"][number]> {
    const normalizedGroupId = requireText(groupId, "Publishing target group id");
    const normalizedRouteId = requireText(routeId, "Publishing target route id");
    if (!publicationTargetGroupIds(publication).includes(normalizedGroupId)) {
      throw new Error(`Publication does not target Publication Group: ${normalizedGroupId}`);
    }
    const groupEntry = await this.#publicationGroups.get(normalizedGroupId);
    if (!groupEntry) throw new Error(`Publishing target is not registered: ${normalizedGroupId}`);
    if (!groupEntry.enabled) throw new Error(`Publishing target is disabled: ${normalizedGroupId}`);
    const route = groupEntry.group.routes.find((candidate) => candidate.id === normalizedRouteId);
    if (!route) {
      throw new Error(`Publishing target ${normalizedGroupId} does not contain route ${normalizedRouteId}`);
    }
    if (!route.enabled) {
      throw new Error(`Publishing target route is disabled: ${normalizedGroupId}/${normalizedRouteId}`);
    }
    return route;
  }

  async findImportedSource(
    extensionId: string,
    connectionId: string,
    remoteId: string,
  ): Promise<PublicationWorkspaceEntry | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.#store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      const match = page.items.find((entry) =>
        entry.publication.provenance.extensionId === extensionId &&
        entry.publication.provenance.connectionId === connectionId &&
        entry.publication.provenance.remoteId === remoteId,
      );
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  }

  async registerImported(publication: Publication): Promise<PublicationWorkspaceEntry> {
    if (!publication.id.trim() || !publication.current.id.trim()) {
      throw new Error("Imported publication and revision ids are required");
    }
    if (publication.current.ordinal !== 1) {
      throw new Error("Imported publication must begin at canonical revision ordinal 1");
    }
    if (publication.status !== "draft") {
      throw new Error("Imported publication must enter the workspace as a draft");
    }
    if (publication.provenance.source === "blogmaatic.publication-workspace") {
      throw new Error("registerImported cannot register workspace-native publications");
    }
    return this.#store.create(publication, this.#now());
  }

  async create(input: PublicationWorkspaceCreateInput): Promise<PublicationWorkspaceEntry> {
    if (input.body !== undefined && input.blocks !== undefined) {
      throw new Error("Publication blocks and body are mutually exclusive");
    }
    if (input.bodyFormat !== undefined && input.body === undefined) {
      throw new Error("Publication bodyFormat requires body");
    }
    if (input.blocks !== undefined && input.bodyFormat !== undefined) {
      throw new Error("Publication bodyFormat cannot be used with blocks");
    }
    const now = this.#now();
    const slug = trimmed(input.slug);
    const summary = trimmed(input.summary);
    const canonicalUrl = trimmed(input.canonicalUrl);
    const publication: Publication = {
      id: `publication_${this.#id()}`,
      createdAt: now,
      ...(slug ? { slug } : {}),
      status: input.status ?? "draft",
      current: {
        id: `revision_${this.#id()}`,
        ordinal: 1,
        createdAt: now,
        content: {
          schemaVersion: 1,
          title: requireText(input.title, "Publication title"),
          ...(summary ? { summary } : {}),
          language: trimmed(input.language) ?? "en",
          blocks: input.blocks === undefined
            ? blocksFromBody(input.body, input.bodyFormat)
            : normalizeBlocks(input.blocks, []),
          assets: [],
          tags: normalizeTags(input.tags),
          attributes: withPublishingTargets(
            withCategories({}, normalizeCategories(input.categories)),
            input.publishingTargetGroupIds ?? [],
          ),
        },
      },
      ...(canonicalUrl ? { canonicalUrl } : {}),
      provenance: { source: "blogmaatic.publication-workspace" },
    };
    return this.#store.create(publication, now);
  }

  async update(publicationId: string, input: PublicationWorkspaceUpdateInput): Promise<PublicationWorkspaceEntry> {
    if (input.body !== undefined && input.blocks !== undefined) {
      throw new Error("Publication blocks and body are mutually exclusive");
    }
    if (input.bodyFormat !== undefined && input.body === undefined) {
      throw new Error("Publication bodyFormat requires body");
    }
    if (input.blocks !== undefined && input.bodyFormat !== undefined) {
      throw new Error("Publication bodyFormat cannot be used with blocks");
    }
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${input.expectedVersion} to ${current.version}`);
    }

    const now = this.#now();
    const oldContent = current.publication.current.content;
    const summary = input.summary === undefined ? oldContent.summary : trimmed(input.summary);
    const nextCurrent = contentChanged(input) ? {
      id: `revision_${this.#id()}`,
      ordinal: current.publication.current.ordinal + 1,
      createdAt: now,
      content: {
        schemaVersion: 1 as const,
        title: input.title === undefined ? oldContent.title : requireText(input.title, "Publication title"),
        ...(summary ? { summary } : {}),
        language: input.language === undefined ? oldContent.language : requireText(input.language, "Publication language"),
        blocks: input.blocks !== undefined
          ? normalizeBlocks(input.blocks, oldContent.assets)
          : input.body === undefined
            ? oldContent.blocks
            : blocksFromBody(input.body, input.bodyFormat),
        assets: input.featuredAssetId === undefined
          ? oldContent.assets
          : withFeaturedAsset(oldContent.assets, input.featuredAssetId),
        tags: input.tags === undefined ? oldContent.tags : normalizeTags(input.tags),
        attributes: (() => {
          const withCategoryState = input.categories === undefined
            ? oldContent.attributes
            : withCategories(oldContent.attributes, normalizeCategories(input.categories));
          return input.publishingTargetGroupIds === undefined
            ? withCategoryState
            : withPublishingTargets(withCategoryState, input.publishingTargetGroupIds);
        })(),
      },
    } : current.publication.current;

    const slug = input.slug === undefined ? current.publication.slug : trimmed(input.slug);
    const canonicalUrl = input.canonicalUrl === undefined ? current.publication.canonicalUrl : trimmed(input.canonicalUrl);
    const publication: Publication = {
      id: current.publication.id,
      createdAt: current.publication.createdAt,
      ...(slug ? { slug } : {}),
      status: input.status ?? current.publication.status,
      current: nextCurrent,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      provenance: current.publication.provenance,
    };
    return this.#store.update(publication, input.expectedVersion, now);
  }

  async restoreSourceRevision(
    publicationId: string,
    expectedVersion: number,
    source: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly remoteId: string;
      readonly remoteRevisionId: string;
      readonly title: string;
      readonly summary?: string;
      readonly contentHtml: string;
      readonly sourceModifiedAt?: string;
      readonly sourceAuthorId?: number;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
      current.publication.provenance.extensionId !== source.extensionId ||
      current.publication.provenance.connectionId !== source.connectionId ||
      current.publication.provenance.remoteId !== source.remoteId
    ) {
      throw new Error("Source revision does not match the publication source identity");
    }
    const remoteRevisionId = source.remoteRevisionId.trim();
    if (!remoteRevisionId) throw new Error("Source revision id is required");

    const oldContent = current.publication.current.content;
    const title = source.title.trim() || oldContent.title;
    const summary = source.summary?.trim();
    const html = source.contentHtml;
    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          schemaVersion: oldContent.schemaVersion,
          title,
          ...(summary ? { summary } : {}),
          language: oldContent.language,
          blocks: html.trim()
            ? [{
              id: `source-revision-${remoteRevisionId}`,
              kind: "embed",
              data: { html },
            }]
            : [],
          assets: oldContent.assets,
          tags: oldContent.tags,
          attributes: {
            ...oldContent.attributes,
            sourceRevisionRecovery: {
              extensionId: source.extensionId,
              connectionId: source.connectionId,
              remoteId: source.remoteId,
              remoteRevisionId,
              recoveredAt: now,
              ...(source.sourceModifiedAt ? { sourceModifiedAt: source.sourceModifiedAt } : {}),
              ...(source.sourceAuthorId === undefined ? {} : { sourceAuthorId: source.sourceAuthorId }),
            },
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async setSourceEditorialOptions(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly contentType: string;
      readonly password: string;
      readonly commentStatus?: "open" | "closed";
      readonly pingStatus?: "open" | "closed";
      readonly sticky?: boolean;
      readonly format?: string;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
      current.publication.provenance.extensionId !== state.extensionId ||
      current.publication.provenance.connectionId !== state.connectionId
    ) {
      throw new Error("Source editorial options connection does not match the publication source");
    }
    const wordpress = current.publication.current.content.attributes.wordpress;
    if (
      wordpress === null ||
      typeof wordpress !== "object" ||
      Array.isArray(wordpress) ||
      wordpress.contentType !== state.contentType
    ) {
      throw new Error("Source editorial options content type does not match the publication source");
    }
    const contentType = state.contentType.trim();
    if (!contentType) throw new Error("Source editorial content type is required");
    const password = state.password;
    if (state.commentStatus !== undefined && state.commentStatus !== "open" && state.commentStatus !== "closed") {
      throw new Error("Source editorial commentStatus must be open or closed");
    }
    if (state.pingStatus !== undefined && state.pingStatus !== "open" && state.pingStatus !== "closed") {
      throw new Error("Source editorial pingStatus must be open or closed");
    }
    const formats = new Set(["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"]);
    const format = state.format?.trim();
    if (format !== undefined && !formats.has(format)) throw new Error("Unsupported WordPress post format");
    if (state.sticky === true && password.length > 0) {
      throw new Error("WordPress sticky posts cannot be password protected");
    }

    const nextState: JsonValue = {
      extensionId: state.extensionId,
      connectionId: state.connectionId,
      contentType,
      password,
      ...(state.commentStatus === undefined ? {} : { commentStatus: state.commentStatus }),
      ...(state.pingStatus === undefined ? {} : { pingStatus: state.pingStatus }),
      ...(state.sticky === undefined ? {} : { sticky: state.sticky }),
      ...(format === undefined ? {} : { format }),
    };
    if (JSON.stringify(current.publication.current.content.attributes.sourceEditorial) === JSON.stringify(nextState)) {
      return current;
    }
    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...current.publication.current.content,
          attributes: {
            ...current.publication.current.content.attributes,
            sourceEditorial: nextState,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async setSourcePageStructure(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly contentType: string;
      readonly parentRemoteId: string | null;
      readonly template: string | null;
      readonly menuOrder: number;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
      current.publication.provenance.extensionId !== state.extensionId ||
      current.publication.provenance.connectionId !== state.connectionId
    ) {
      throw new Error("Source page structure connection does not match the publication source");
    }

    const wordpress = current.publication.current.content.attributes.wordpress;
    if (
      wordpress === null ||
      typeof wordpress !== "object" ||
      Array.isArray(wordpress) ||
      wordpress.contentType !== state.contentType
    ) {
      throw new Error("Source page structure content type does not match the publication source");
    }

    const contentType = state.contentType.trim();
    if (!contentType) throw new Error("Source page content type is required");

    let parentRemoteId: string | null = null;
    if (state.parentRemoteId !== null) {
      parentRemoteId = state.parentRemoteId.trim();
      if (!/^\d+$/.test(parentRemoteId)) {
        throw new Error("Source page parentRemoteId must be null or a positive integer string");
      }
      const parent = Number(parentRemoteId);
      if (!Number.isSafeInteger(parent) || parent < 1) {
        throw new Error("Source page parentRemoteId must be null or a positive integer string");
      }
      if (current.publication.provenance.remoteId === parentRemoteId) {
        throw new Error("A WordPress page cannot be its own parent");
      }
    }

    const template = state.template === null ? null : state.template.trim() || null;
    if (!Number.isSafeInteger(state.menuOrder) || state.menuOrder < 0) {
      throw new Error("Source page menuOrder must be a non-negative integer");
    }

    const nextState: JsonValue = {
      extensionId: state.extensionId,
      connectionId: state.connectionId,
      contentType,
      parentRemoteId,
      template,
      menuOrder: state.menuOrder,
    };
    const existing = current.publication.current.content.attributes.sourcePage;
    if (JSON.stringify(existing) === JSON.stringify(nextState)) return current;

    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...current.publication.current.content,
          attributes: {
            ...current.publication.current.content.attributes,
            sourcePage: nextState,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async setSourceMetaValues(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly contentType: string;
      readonly values: Readonly<Record<string, JsonValue>>;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
      current.publication.provenance.extensionId !== state.extensionId ||
      current.publication.provenance.connectionId !== state.connectionId
    ) {
      throw new Error("Source meta connection does not match the publication source");
    }
    const contentType = state.contentType.trim();
    if (!contentType) throw new Error("Source meta content type is required");

    const wordpress = current.publication.current.content.attributes.wordpress;
    if (
      wordpress === null ||
      typeof wordpress !== "object" ||
      Array.isArray(wordpress) ||
      wordpress.contentType !== contentType
    ) {
      throw new Error("Source meta content type does not match the publication source");
    }

    const values: Record<string, JsonValue> = {};
    for (const [rawKey, value] of Object.entries(state.values)) {
      const key = rawKey.trim();
      if (!key) throw new Error("Source meta field key is required");
      values[key] = value;
    }

    const nextState: JsonValue = {
      extensionId: state.extensionId,
      connectionId: state.connectionId,
      contentType,
      values,
    };
    const existing = current.publication.current.content.attributes.sourceMeta;
    if (JSON.stringify(existing) === JSON.stringify(nextState)) return current;

    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...current.publication.current.content,
          attributes: {
            ...current.publication.current.content.attributes,
            sourceMeta: nextState,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async setSourceTaxonomies(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly contentType: string;
      readonly taxonomies: Readonly<Record<string, {
        readonly restBase: string;
        readonly restNamespace?: string;
        readonly names: readonly string[];
      }>>;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
      current.publication.provenance.extensionId !== state.extensionId ||
      current.publication.provenance.connectionId !== state.connectionId
    ) {
      throw new Error("Source taxonomy connection does not match the publication source");
    }
    const contentType = state.contentType.trim();
    if (!contentType) throw new Error("Source taxonomy content type is required");

    const normalized: Record<string, JsonValue> = {};
    for (const [rawKey, value] of Object.entries(state.taxonomies)) {
      const taxonomyKey = rawKey.trim();
      if (!taxonomyKey) throw new Error("Source taxonomy key is required");
      const restBase = value.restBase.trim();
      if (!restBase) throw new Error(`Source taxonomy REST base is required: ${taxonomyKey}`);
      const names = [...new Set(value.names.map((name) => name.trim()).filter(Boolean))].sort();
      normalized[taxonomyKey] = {
        restBase,
        ...(value.restNamespace?.trim() ? { restNamespace: value.restNamespace.trim() } : {}),
        names,
      };
    }

    const nextState: JsonValue = {
      extensionId: state.extensionId,
      connectionId: state.connectionId,
      contentType,
      taxonomies: normalized,
    };
    const existing = current.publication.current.content.attributes.sourceTaxonomies;
    if (JSON.stringify(existing) === JSON.stringify(nextState)) return current;

    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...current.publication.current.content,
          attributes: {
            ...current.publication.current.content.attributes,
            sourceTaxonomies: nextState,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async setSourcePublishingState(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly status: string;
      readonly scheduledAt?: string;
      readonly groupId?: string;
      readonly routeId?: string;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    let targetRoute: PublicationGroup["routes"][number] | undefined;
    if (state.groupId !== undefined || state.routeId !== undefined) {
      if (!state.groupId || !state.routeId) {
        throw new Error("Route-scoped source publishing state requires both groupId and routeId");
      }
      targetRoute = await this.#publishingTargetRoute(current.publication, state.groupId, state.routeId);
      if (
        targetRoute.destination.extensionId !== state.extensionId ||
        targetRoute.destination.connectionId !== state.connectionId
      ) {
        throw new Error("Source publishing state route does not match the requested destination");
      }
    } else if (
      current.publication.provenance.extensionId !== state.extensionId ||
      current.publication.provenance.connectionId !== state.connectionId
    ) {
      throw new Error("Source publishing state connection does not match the publication source");
    }
    const status = state.status.trim();
    if (!status) throw new Error("Source publishing status is required");
    const scheduledAt = state.scheduledAt?.trim();
    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (Number.isNaN(parsed.getTime())) throw new Error("Source publishing schedule must be a valid instant");
    }

    const nextState: Record<string, JsonValue> = {
      extensionId: state.extensionId,
      connectionId: state.connectionId,
      status,
      ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
    };
    const oldAttributes = current.publication.current.content.attributes;
    const nextAttributes = targetRoute && state.groupId && state.routeId
      ? withDestinationOverride(
        oldAttributes,
        state.groupId,
        state.routeId,
        targetRoute.destination,
        { publishing: nextState },
      )
      : { ...oldAttributes, sourcePublishing: nextState };
    if (JSON.stringify(oldAttributes) === JSON.stringify(nextAttributes)) return current;

    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...current.publication.current.content,
          attributes: {
            ...nextAttributes,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async assignSourceAuthor(
    publicationId: string,
    expectedVersion: number,
    author: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly remoteId: string;
      readonly displayName: string;
      readonly groupId?: string;
      readonly routeId?: string;
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    let targetRoute: PublicationGroup["routes"][number] | undefined;
    if (author.groupId !== undefined || author.routeId !== undefined) {
      if (!author.groupId || !author.routeId) {
        throw new Error("Route-scoped source author requires both groupId and routeId");
      }
      targetRoute = await this.#publishingTargetRoute(current.publication, author.groupId, author.routeId);
      if (
        targetRoute.destination.extensionId !== author.extensionId ||
        targetRoute.destination.connectionId !== author.connectionId
      ) {
        throw new Error("Source author route does not match the requested destination");
      }
    } else if (
      current.publication.provenance.extensionId !== author.extensionId ||
      current.publication.provenance.connectionId !== author.connectionId
    ) {
      throw new Error("Source author connection does not match the publication source");
    }
    const remoteId = author.remoteId.trim();
    if (!remoteId) throw new Error("Source author remote id is required");
    const displayName = author.displayName.trim();
    if (!displayName) throw new Error("Source author display name is required");

    const oldContent = current.publication.current.content;
    const nextAuthor: JsonValue = {
      extensionId: author.extensionId,
      connectionId: author.connectionId,
      remoteId,
      displayName,
    };
    const nextAttributes = targetRoute && author.groupId && author.routeId
      ? withDestinationOverride(
        oldContent.attributes,
        author.groupId,
        author.routeId,
        targetRoute.destination,
        { author: nextAuthor },
      )
      : { ...oldContent.attributes, sourceAuthor: nextAuthor };
    if (JSON.stringify(oldContent.attributes) === JSON.stringify(nextAttributes)) return current;

    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...oldContent,
          attributes: {
            ...nextAttributes,
          },
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async attachAsset(
    publicationId: string,
    expectedVersion: number,
    asset: PublicationAsset,
    featured = false,
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    const assetId = asset.id.trim();
    const source = asset.source.trim();
    if (!assetId) throw new Error("Publication asset id is required");
    if (!source) throw new Error("Publication asset source is required");

    const oldContent = current.publication.current.content;
    const existing = oldContent.assets.find((candidate) => candidate.id === assetId);
    if (existing && (existing.kind !== asset.kind || existing.source !== source)) {
      throw new Error(`Publication asset id already belongs to a different asset: ${assetId}`);
    }
    const needsFeatureChange = featured && existing?.attributes?.featured !== true;
    if (existing && !needsFeatureChange) return current;

    const attached = existing ? oldContent.assets : [...oldContent.assets, { ...asset, id: assetId, source }];
    const assets = featured ? withFeaturedAsset(attached, assetId) : attached;
    const now = this.#now();
    const publication: Publication = {
      ...current.publication,
      current: {
        id: `revision_${this.#id()}`,
        ordinal: current.publication.current.ordinal + 1,
        createdAt: now,
        content: {
          ...oldContent,
          assets,
        },
      },
    };
    return this.#store.update(publication, expectedVersion, now);
  }

  async approveAndDispatch(publicationId: string, expectedVersion: number): Promise<PublicationWorkspaceDispatchResult> {
    let entry = await this.#store.get(publicationId);
    if (!entry) throw new Error(`Publication is not registered: ${publicationId}`);
    if (entry.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${entry.version}`);
    }
    if (entry.publication.status === "archived") throw new Error("Archived publications cannot be dispatched");

    const targetGroupIds = publicationTargetGroupIds(entry.publication);
    if (targetGroupIds.length === 0) {
      throw new Error("Publication has no publishing targets. Select at least one Publication Group before publishing.");
    }

    const groups: PublicationGroup[] = [];
    for (const groupId of targetGroupIds) {
      const groupEntry = await this.#publicationGroups.get(groupId);
      if (!groupEntry) throw new Error(`Publishing target is not registered: ${groupId}`);
      if (!groupEntry.enabled) throw new Error(`Publishing target is disabled: ${groupId}`);
      if (!groupEntry.group.routes.some((route) => route.enabled)) {
        throw new Error(`Publishing target has no enabled routes: ${groupId}`);
      }
      groups.push(groupEntry.group);
    }

    if (entry.publication.status !== "approved") {
      entry = await this.update(publicationId, { expectedVersion, status: "approved" });
    }

    const runs = await this.#controlPlane.routeEvent({
      id: `approved:${entry.publication.id}:${entry.publication.current.id}`,
      type: "publication.approved",
      source: "blogmaatic.publication-workspace",
      occurredAt: this.#now(),
      publication: entry.publication,
      groups,
    });
    return { publication: entry, runs };
  }
}
