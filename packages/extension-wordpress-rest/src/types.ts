import type { JsonValue } from "@blogmaatic/core";

export interface WordPressSettings {
  readonly siteUrl: string;
  readonly apiRoot: string;
  readonly username: string;
  readonly applicationPasswordRef: string;
  readonly postTypeRestBase: string;
  readonly assetSourceRoots: readonly string[];
  readonly createMissingTerms: boolean;
  readonly timeoutMs: number;
}

export interface CompiledWordPressAsset {
  readonly assetId: string;
  readonly source: string;
  readonly mediaType?: string;
  readonly alt?: string;
  readonly fingerprint?: string;
  readonly localPath?: string;
  readonly wordpressMediaId?: number;
}

export interface WordPressProjectionPayload {
  readonly title: string;
  readonly excerpt: string;
  readonly slug: string;
  readonly status: "publish" | "draft" | "pending" | "private" | "future";
  readonly scheduledAt?: string;
  readonly bodyTemplate: string;
  readonly tags: readonly string[];
  readonly categories: readonly string[];
  readonly assets: readonly Readonly<Record<string, JsonValue>>[];
  readonly featuredAssetId?: string;
}

export interface WordPressPostRecord {
  readonly id: number;
  readonly author?: number;
  readonly date_gmt?: string | null;
  readonly modified_gmt?: string;
  readonly link: string;
  readonly slug: string;
  readonly status: string;
  readonly title?: { readonly raw?: string; readonly rendered?: string };
  readonly excerpt?: { readonly raw?: string; readonly rendered?: string };
  readonly content?: { readonly raw?: string; readonly rendered?: string };
  readonly categories?: readonly number[];
  readonly tags?: readonly number[];
  readonly featured_media?: number;
}

export interface WordPressMediaRecord {
  readonly id: number;
  readonly source_url: string;
  readonly slug: string;
}

export interface WordPressTermRecord {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
}


export interface WordPressRevisionRecord {
  readonly id: number;
  readonly parent?: number;
  readonly author?: number;
  readonly date_gmt?: string | null;
  readonly modified_gmt?: string;
  readonly title?: { readonly raw?: string; readonly rendered?: string };
  readonly excerpt?: { readonly raw?: string; readonly rendered?: string };
  readonly content?: { readonly raw?: string; readonly rendered?: string };
}

export interface WordPressPostQuery {
  readonly search?: string;
  readonly status?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface WordPressManagedOwnership {
  readonly managed: boolean;
  readonly publicationId?: string;
  readonly routeId?: string;
  readonly projectionFingerprint?: string;
}

export interface WordPressPostView {
  readonly id: number;
  readonly author?: number;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHtml: string;
  readonly slug: string;
  readonly status: string;
  readonly link: string;
  readonly dateGmt?: string | null;
  readonly modifiedGmt?: string;
  readonly categoryIds: readonly number[];
  readonly tagIds: readonly number[];
  readonly featuredMediaId?: number;
  readonly ownership: WordPressManagedOwnership;
}

export interface WordPressPostPage {
  readonly items: readonly WordPressPostView[];
  readonly page: number;
  readonly perPage: number;
  readonly hasMore: boolean;
}

export interface WordPressRevisionView {
  readonly id: number;
  readonly parent?: number;
  readonly author?: number;
  readonly dateGmt?: string | null;
  readonly modifiedGmt?: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHtml: string;
}

export interface WordPressImportSnapshot {
  readonly post: WordPressPostView;
  readonly categoryNames: readonly string[];
  readonly tagNames: readonly string[];
  readonly featuredMedia?: WordPressMediaRecord;
}
