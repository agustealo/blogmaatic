import type { CompiledProjection } from "@blogmaatic/core";
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
import { WORDPRESS_REST_EXTENSION_ID, parseSettings } from "./settings.js";
import type {
  WordPressImportSnapshot,
  WordPressMediaRecord,
  WordPressPostPage,
  WordPressPostQuery,
  WordPressPostRecord,
  WordPressPostView,
  WordPressRevisionRecord,
  WordPressRevisionView,
  WordPressTermRecord,
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

function postView(post: WordPressPostRecord): WordPressPostView {
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
    ownership: ownership(post),
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

  #client(connectionId: string): { readonly client: WordPressRestClient; readonly restBase: string } {
    const connection = this.#connections.requireActive(WORDPRESS_REST_EXTENSION_ID, connectionId);
    const settings = parseSettings(connection);
    return {
      client: new WordPressRestClient(connection, settings, this.#secrets),
      restBase: settings.postTypeRestBase,
    };
  }

  async list(connectionId: string, query: WordPressPostQuery = {}): Promise<WordPressPostPage> {
    const { client, restBase } = this.#client(connectionId);
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
    return {
      items: records.map(postView),
      page,
      perPage,
      hasMore: records.length === perPage,
    };
  }

  async get(connectionId: string, remoteId: string): Promise<WordPressPostView> {
    return postView(await this.#getRecord(connectionId, remoteId));
  }

  async importSnapshot(connectionId: string, remoteId: string): Promise<WordPressImportSnapshot> {
    const { client } = this.#client(connectionId);
    const post = await this.#getRecord(connectionId, remoteId);
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
    return {
      post: postView(post),
      categoryNames,
      tagNames,
      ...(featuredMedia ? { featuredMedia } : {}),
    };
  }

  async revisions(connectionId: string, remoteId: string): Promise<readonly WordPressRevisionView[]> {
    const { client, restBase } = this.#client(connectionId);
    const id = requireRemoteId(remoteId);
    const revisions = await client.requestJson<readonly WordPressRevisionRecord[]>(
      `/${restBase}/${id}/revisions?context=edit&per_page=100`,
    );
    return revisions.map(revisionView);
  }

  async trash(connectionId: string, remoteId: string): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId);
    const current = await this.#getRecord(connectionId, remoteId);
    this.#assertManaged(current);
    const saved = await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ status: "trash" }) },
    );
    return postView(saved);
  }

  async restore(connectionId: string, remoteId: string): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId);
    const current = await this.#getRecord(connectionId, remoteId);
    this.#assertManaged(current);
    if (current.status !== "trash") throw new Error("Only trashed WordPress posts can be restored");
    const saved = await client.requestJson<WordPressPostRecord>(
      `/${restBase}/${requireRemoteId(remoteId)}`,
      { method: "POST", body: JSON.stringify({ status: "draft" }) },
    );
    return postView(saved);
  }

  async deletePermanent(connectionId: string, remoteId: string): Promise<WordPressPostView> {
    const { client, restBase } = this.#client(connectionId);
    const current = await this.#getRecord(connectionId, remoteId);
    this.#assertManaged(current);
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
  ): Promise<WordPressPostView> {
    if (projection.destination.extensionId !== WORDPRESS_REST_EXTENSION_ID) {
      throw new Error("WordPress adoption requires a WordPress projection");
    }
    if (projection.destination.connectionId !== connectionId) {
      throw new Error("WordPress adoption projection belongs to a different connection");
    }
    const { client, restBase } = this.#client(connectionId);
    const current = await this.#getRecord(connectionId, remoteId);
    const currentMarker = parseMarker(rawValue(current.content));
    if (
      currentMarker &&
      (currentMarker.publicationId !== projection.publicationId ||
        currentMarker.routeId !== projection.routeId)
    ) {
      throw new Error("WordPress post is already owned by a different Blogmaatic publication or route");
    }
    const raw = stripMarker(rawValue(current.content));
    const marked = documentWithMarker(raw, {
      version: 1,
      publicationId: projection.publicationId,
      routeId: projection.routeId,
      projectionFingerprint: projection.fingerprint,
      renderedHash: remoteStateHash(current, raw),
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
  ): Promise<void> {
    const { client, restBase } = this.#client(connectionId);
    const current = await this.#getRecord(connectionId, remoteId);
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

  async #getRecord(connectionId: string, remoteId: string): Promise<WordPressPostRecord> {
    const { client, restBase } = this.#client(connectionId);
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
