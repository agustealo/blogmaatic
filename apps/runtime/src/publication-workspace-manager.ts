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
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceUpdateInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly body?: string;
  readonly bodyFormat?: PublicationBodyFormat;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly categories?: readonly string[];
  readonly featuredAssetId?: string | null;
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

function contentChanged(input: PublicationWorkspaceUpdateInput): boolean {
  return input.title !== undefined ||
    input.body !== undefined ||
    input.summary !== undefined ||
    input.language !== undefined ||
    input.tags !== undefined ||
    input.categories !== undefined ||
    input.featuredAssetId !== undefined;
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
    if (input.bodyFormat !== undefined && input.body === undefined) {
      throw new Error("Publication bodyFormat requires body");
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
          blocks: blocksFromBody(input.body, input.bodyFormat),
          assets: [],
          tags: normalizeTags(input.tags),
          attributes: withCategories({}, normalizeCategories(input.categories)),
        },
      },
      ...(canonicalUrl ? { canonicalUrl } : {}),
      provenance: { source: "blogmaatic.publication-workspace" },
    };
    return this.#store.create(publication, now);
  }

  async update(publicationId: string, input: PublicationWorkspaceUpdateInput): Promise<PublicationWorkspaceEntry> {
    if (input.bodyFormat !== undefined && input.body === undefined) {
      throw new Error("Publication bodyFormat requires body");
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
        blocks: input.body === undefined ? oldContent.blocks : blocksFromBody(input.body, input.bodyFormat),
        assets: input.featuredAssetId === undefined
          ? oldContent.assets
          : withFeaturedAsset(oldContent.assets, input.featuredAssetId),
        tags: input.tags === undefined ? oldContent.tags : normalizeTags(input.tags),
        attributes: input.categories === undefined
          ? oldContent.attributes
          : withCategories(oldContent.attributes, normalizeCategories(input.categories)),
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

  async setSourcePublishingState(
    publicationId: string,
    expectedVersion: number,
    state: {
      readonly extensionId: string;
      readonly connectionId: string;
      readonly status: string;
      readonly scheduledAt?: string;
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
    const existing = current.publication.current.content.attributes.sourcePublishing;
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
            sourcePublishing: nextState,
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
    },
  ): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${current.version}`);
    }
    if (
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
    const existing = oldContent.attributes.sourceAuthor;
    const nextAuthor: JsonValue = {
      extensionId: author.extensionId,
      connectionId: author.connectionId,
      remoteId,
      displayName,
    };
    if (JSON.stringify(existing) === JSON.stringify(nextAuthor)) return current;

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
            ...oldContent.attributes,
            sourceAuthor: nextAuthor,
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
    if (entry.publication.status !== "approved") {
      entry = await this.update(publicationId, { expectedVersion, status: "approved" });
    }

    const groups: PublicationGroup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#publicationGroups.list({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      groups.push(...page.items.map((groupEntry) => groupEntry.group));
      cursor = page.nextCursor;
    } while (cursor);

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
