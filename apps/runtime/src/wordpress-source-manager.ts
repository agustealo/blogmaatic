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
  type WordPressPostView,
  type WordPressRevisionView,
} from "@blogmaatic/extension-wordpress-rest";
import type {
  OperatorSourceContentManager,
  SourceContentImportBody,
  SourceContentImportResult,
  SourceContentPage,
  SourceContentQuery,
  SourceContentRecord,
  SourceContentRevision,
} from "@blogmaatic/operator-api";

import type { PublicationGroupManager } from "./publication-group-manager.js";
import type { PublicationWorkspaceManager } from "./publication-workspace-manager.js";

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

function sourceRecord(connectionId: string, post: WordPressPostView): SourceContentRecord {
  const metadata: Record<string, JsonValue> = {
    authorId: post.author ?? null,
    categoryIds: [...post.categoryIds],
    tagIds: [...post.tagIds],
    featuredMediaId: post.featuredMediaId ?? null,
  };
  return {
    connectionId,
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
    ...(post.ownership.routeId ? { routeId: post.ownership.routeId } : {}),
    metadata,
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
      ...(post.status === "future" && post.dateGmt ? { scheduledAt: post.dateGmt } : {}),
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

  async list(connectionId: string, query: SourceContentQuery = {}): Promise<SourceContentPage> {
    const page = await this.#content.list(connectionId, {
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.limit === undefined ? {} : { perPage: query.limit }),
    });
    return {
      items: page.items.map((post) => sourceRecord(connectionId, post)),
      page: page.page,
      limit: page.perPage,
      hasMore: page.hasMore,
    };
  }

  async get(connectionId: string, remoteId: string): Promise<SourceContentRecord> {
    return sourceRecord(connectionId, await this.#content.get(connectionId, remoteId));
  }

  async revisions(connectionId: string, remoteId: string): Promise<readonly SourceContentRevision[]> {
    return (await this.#content.revisions(connectionId, remoteId)).map(sourceRevision);
  }

  async import(
    connectionId: string,
    remoteId: string,
    body: SourceContentImportBody,
  ): Promise<SourceContentImportResult> {
    const snapshot = await this.#content.importSnapshot(connectionId, remoteId);
    const groupEntry = await this.#publicationGroups.get(body.groupId);
    if (!groupEntry) throw new Error(`Publication group is not registered: ${body.groupId}`);
    if (!groupEntry.enabled) throw new Error(`Publication group is disabled: ${body.groupId}`);
    const route = routeForImport(body.groupId, body.routeId, connectionId, groupEntry.group);

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
      const publication = this.#importedPublication(connectionId, snapshot);
      workspace = await this.#publications.registerImported(publication);
    }

    const projection = await this.#publisher.compile({
      publication: workspace.publication,
      route: importProjectionRoute(route, snapshot.post),
    });

    let adopted = snapshot.post;
    if (
      !snapshot.post.ownership.managed ||
      snapshot.post.ownership.publicationId !== workspace.publication.id ||
      snapshot.post.ownership.routeId !== route.id
    ) {
      adopted = await this.#content.adopt(connectionId, remoteId, projection);
    }

    const remote = remoteIdentity(adopted);
    const recordedAt = this.#now();
    await this.#projectionState.put({
      publicationId: workspace.publication.id,
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
      remote: sourceRecord(connectionId, adopted),
    };
  }

  async trash(connectionId: string, remoteId: string): Promise<SourceContentRecord> {
    return sourceRecord(connectionId, await this.#content.trash(connectionId, remoteId));
  }

  async restore(connectionId: string, remoteId: string): Promise<SourceContentRecord> {
    return sourceRecord(connectionId, await this.#content.restore(connectionId, remoteId));
  }

  async deletePermanent(connectionId: string, remoteId: string): Promise<SourceContentRecord> {
    return sourceRecord(connectionId, await this.#content.deletePermanent(connectionId, remoteId));
  }

  #importedPublication(
    connectionId: string,
    snapshot: Awaited<ReturnType<WordPressContentService["importSnapshot"]>>,
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
          tags: snapshot.tagNames,
          attributes: {
            categories: snapshot.categoryNames,
            wordpress: {
              connectionId,
              remoteId: String(snapshot.post.id),
              remoteStatus: snapshot.post.status,
              authorId: snapshot.post.author ?? null,
              categoryIds: [...snapshot.post.categoryIds],
              tagIds: [...snapshot.post.tagIds],
              featuredMediaId: snapshot.post.featuredMediaId ?? null,
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
