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
import type { Publication, PublicationBlock, PublicationStatus } from "@blogmaatic/core";

import type { PublicationGroupManager } from "./publication-group-manager.js";

export type WorkspacePublicationStatus = Extract<PublicationStatus, "idea" | "draft" | "ready" | "approved" | "archived">;

export interface PublicationWorkspaceCreateInput {
  readonly title: string;
  readonly body?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
  readonly slug?: string;
  readonly canonicalUrl?: string;
  readonly status?: WorkspacePublicationStatus;
}

export interface PublicationWorkspaceUpdateInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly body?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
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

function blocksFromBody(body: string | undefined): readonly PublicationBlock[] {
  const text = body?.trim() ?? "";
  if (!text) return [];
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
    input.tags !== undefined;
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

  async create(input: PublicationWorkspaceCreateInput): Promise<PublicationWorkspaceEntry> {
    const now = this.#now();
    const publicationId = `publication_${this.#id()}`;
    const revisionId = `revision_${this.#id()}`;
    const publication: Publication = {
      id: publicationId,
      createdAt: now,
      ...(trimmed(input.slug) ? { slug: trimmed(input.slug) } : {}),
      status: input.status ?? "draft",
      current: {
        id: revisionId,
        ordinal: 1,
        createdAt: now,
        content: {
          schemaVersion: 1,
          title: requireText(input.title, "Publication title"),
          ...(trimmed(input.summary) ? { summary: trimmed(input.summary) } : {}),
          language: trimmed(input.language) ?? "en",
          blocks: blocksFromBody(input.body),
          assets: [],
          tags: normalizeTags(input.tags),
          attributes: {},
        },
      },
      ...(trimmed(input.canonicalUrl) ? { canonicalUrl: trimmed(input.canonicalUrl) } : {}),
      provenance: { source: "blogmaatic.publication-workspace" },
    };
    return this.#store.create(publication, now);
  }

  async update(publicationId: string, input: PublicationWorkspaceUpdateInput): Promise<PublicationWorkspaceEntry> {
    const current = await this.#store.get(publicationId);
    if (!current) throw new Error(`Publication is not registered: ${publicationId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${input.expectedVersion} to ${current.version}`);
    }
    const now = this.#now();
    const changed = contentChanged(input);
    const oldContent = current.publication.current.content;
    const nextCurrent = changed ? {
      id: `revision_${this.#id()}`,
      ordinal: current.publication.current.ordinal + 1,
      createdAt: now,
      content: {
        schemaVersion: 1 as const,
        title: input.title === undefined ? oldContent.title : requireText(input.title, "Publication title"),
        ...((input.summary === undefined ? oldContent.summary : trimmed(input.summary)) ? {
          summary: input.summary === undefined ? oldContent.summary : trimmed(input.summary),
        } : {}),
        language: input.language === undefined ? oldContent.language : requireText(input.language, "Publication language"),
        blocks: input.body === undefined ? oldContent.blocks : blocksFromBody(input.body),
        assets: oldContent.assets,
        tags: input.tags === undefined ? oldContent.tags : normalizeTags(input.tags),
        attributes: oldContent.attributes,
      },
    } : current.publication.current;

    const publication: Publication = {
      ...current.publication,
      ...(input.slug === undefined
        ? {}
        : trimmed(input.slug) ? { slug: trimmed(input.slug) } : { slug: undefined }),
      ...(input.canonicalUrl === undefined
        ? {}
        : trimmed(input.canonicalUrl) ? { canonicalUrl: trimmed(input.canonicalUrl) } : { canonicalUrl: undefined }),
      status: input.status ?? current.publication.status,
      current: nextCurrent,
    };

    // Delete optional undefined values before core JSON validation/persistence.
    const normalized: Publication = JSON.parse(JSON.stringify(publication)) as Publication;
    return this.#store.update(normalized, input.expectedVersion, now);
  }

  async approveAndDispatch(publicationId: string, expectedVersion: number): Promise<PublicationWorkspaceDispatchResult> {
    let entry = await this.#store.get(publicationId);
    if (!entry) throw new Error(`Publication is not registered: ${publicationId}`);
    if (entry.version !== expectedVersion) {
      throw new Error(`Publication ${publicationId} changed from version ${expectedVersion} to ${entry.version}`);
    }
    if (entry.publication.status === "archived") throw new Error("Archived publications cannot be dispatched");
    if (entry.publication.status !== "approved") {
      entry = await this.update(publicationId, {
        expectedVersion,
        status: "approved",
      });
    }

    const groups: Publication["current"] extends never ? never : Awaited<ReturnType<PublicationGroupManager["list"]>>["items"] = [] as never;
    const snapshots = [];
    let cursor: string | undefined;
    do {
      const page = await this.#publicationGroups.list({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      snapshots.push(...page.items.map((groupEntry) => groupEntry.group));
      cursor = page.nextCursor;
    } while (cursor);

    const runs = await this.#controlPlane.routeEvent({
      id: `approved:${entry.publication.id}:${entry.publication.current.id}`,
      type: "publication.approved",
      source: "blogmaatic.publication-workspace",
      occurredAt: this.#now(),
      publication: entry.publication,
      groups: snapshots,
    });
    void groups;
    return { publication: entry, runs };
  }
}
