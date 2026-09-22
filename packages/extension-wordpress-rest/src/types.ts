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
