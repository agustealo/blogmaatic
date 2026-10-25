import type { ImageTransformPlan } from "@blogmaatic/media";
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
  readonly transform?: ImageTransformPlan;
}

export interface WordPressProjectionPayload {
  readonly contentType: string;
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
  readonly authorId?: number;
  readonly parentId?: number;
  readonly template?: string;
  readonly menuOrder?: number;
  readonly password?: string;
  readonly commentStatus?: "open" | "closed";
  readonly pingStatus?: "open" | "closed";
  readonly sticky?: boolean;
  readonly format?: string;
  readonly customTaxonomies?: Readonly<Record<string, {
    readonly restBase: string;
    readonly restNamespace?: string;
    readonly names: readonly string[];
  }>>;
  readonly restMeta?: Readonly<Record<string, JsonValue>>;
  readonly legacyOwnershipAllowed?: boolean;
}

export interface WordPressPostRecord {
  readonly [key: string]: unknown;
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
  readonly parent?: number;
  readonly template?: string;
  readonly menu_order?: number;
  readonly password?: string;
  readonly comment_status?: "open" | "closed";
  readonly ping_status?: "open" | "closed";
  readonly sticky?: boolean;
  readonly format?: string;
  readonly meta?: Readonly<Record<string, JsonValue>>;
}

export interface WordPressMediaRecord {
  readonly id: number;
  readonly source_url: string;
  readonly slug: string;
  readonly media_type?: string;
  readonly mime_type?: string;
  readonly alt_text?: string;
  readonly modified_gmt?: string;
  readonly title?: { readonly raw?: string; readonly rendered?: string };
  readonly media_details?: {
    readonly width?: number;
    readonly height?: number;
  };
}

export interface WordPressMediaQuery {
  readonly search?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface WordPressMediaView {
  readonly id: number;
  readonly sourceUrl: string;
  readonly slug: string;
  readonly mediaType?: string;
  readonly mediaKind?: string;
  readonly alt: string;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
  readonly modifiedGmt?: string;
}

export interface WordPressMediaPage {
  readonly items: readonly WordPressMediaView[];
  readonly page: number;
  readonly perPage: number;
  readonly hasMore: boolean;
}

export interface WordPressUserRecord {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly link?: string;
  readonly url?: string;
  readonly description?: string;
  readonly avatar_urls?: Readonly<Record<string, string>>;
}

export interface WordPressUserQuery {
  readonly search?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface WordPressUserView {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly link?: string;
  readonly avatarUrl?: string;
}

export interface WordPressUserPage {
  readonly items: readonly WordPressUserView[];
  readonly page: number;
  readonly perPage: number;
  readonly hasMore: boolean;
}

export interface WordPressTermRecord {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly count?: number;
}

export interface WordPressTermQuery {
  readonly search?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface WordPressTermPage {
  readonly items: readonly WordPressTermRecord[];
  readonly page: number;
  readonly perPage: number;
  readonly hasMore: boolean;
}

export interface WordPressTaxonomyRecord {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly hierarchical?: boolean;
  readonly types?: readonly string[];
  readonly rest_base?: string;
  readonly rest_namespace?: string;
  readonly visibility?: {
    readonly show_ui?: boolean;
    readonly show_in_nav_menus?: boolean;
    readonly show_in_rest?: boolean;
  };
}

export interface WordPressTaxonomyView {
  readonly key: string;
  readonly label: string;
  readonly restBase: string;
  readonly hierarchical: boolean;
  readonly contentTypes: readonly string[];
  readonly restNamespace?: string;
  readonly description?: string;
}

export interface WordPressCustomTaxonomySelection {
  readonly taxonomyKey: string;
  readonly restBase: string;
  readonly restNamespace?: string;
  readonly names: readonly string[];
}

export type WordPressRestMetaType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface WordPressRestMetaFieldDefinition {
  readonly key: string;
  readonly type: WordPressRestMetaType;
  readonly nullable: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly defaultValue?: JsonValue;
}

export interface WordPressRestMetaSnapshot {
  readonly fields: readonly WordPressRestMetaFieldDefinition[];
  readonly values: Readonly<Record<string, JsonValue>>;
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

export interface WordPressContentTypeRecord {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly hierarchical?: boolean;
  readonly viewable?: boolean;
  readonly rest_base?: string;
  readonly rest_namespace?: string;
  readonly taxonomies?: readonly string[];
  readonly supports?: Readonly<Record<string, boolean>>;
}

export interface WordPressContentTypeView {
  readonly slug: string;
  readonly name: string;
  readonly restBase: string;
  readonly description?: string;
  readonly hierarchical: boolean;
  readonly viewable: boolean;
  readonly restNamespace?: string;
  readonly taxonomies: readonly string[];
  readonly supports: readonly string[];
}

export interface WordPressPostQuery {
  readonly contentType?: string;
  readonly search?: string;
  readonly status?: string;
  readonly page?: number;
  readonly perPage?: number;
}

export interface WordPressManagedOwnership {
  readonly managed: boolean;
  readonly publicationId?: string;
  readonly groupId?: string;
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
  readonly parentId?: number;
  readonly template?: string;
  readonly menuOrder?: number;
  readonly password?: string;
  readonly commentStatus?: "open" | "closed";
  readonly pingStatus?: "open" | "closed";
  readonly sticky?: boolean;
  readonly format?: string;
  readonly customTaxonomyIds?: Readonly<Record<string, readonly number[]>>;
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
  readonly customTaxonomies?: readonly WordPressCustomTaxonomySelection[];
  readonly restMeta?: WordPressRestMetaSnapshot;
  readonly featuredMedia?: WordPressMediaRecord;
}
