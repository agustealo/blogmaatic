import type { ImageTransformPlan } from "@blogmaatic/media";
import type { FidelityReport, SocialArticleVariant } from "@blogmaatic/variants";

export interface LinkedInSettings {
  readonly apiRoot: string;
  readonly apiVersion: string;
  readonly authorUrn: string;
  readonly assetSourceRoots: readonly string[];
  readonly accessTokenRef: string;
  readonly timeoutMs: number;
}

export type LinkedInProjectionMode = "text" | "article" | "image" | "multiImage";

export interface LinkedInImageSpec {
  readonly assetId: string;
  readonly source: string;
  readonly localPath: string;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly alt?: string;
  readonly fingerprint: string;
  readonly transform: ImageTransformPlan;
}

export interface LinkedInProjectionPayload {
  readonly mode: LinkedInProjectionMode;
  readonly commentary: string;
  readonly article?: SocialArticleVariant;
  readonly image?: LinkedInImageSpec;
  readonly images?: readonly LinkedInImageSpec[];
  readonly fidelity: FidelityReport;
}

export interface LinkedInPostRecord {
  readonly id: string;
  readonly author: string;
  readonly commentary: string;
  readonly visibility?: string;
  readonly lifecycleState?: string;
  readonly lastModifiedAt?: number;
  readonly distribution?: {
    readonly feedDistribution?: string;
    readonly targetEntities?: readonly unknown[];
    readonly thirdPartyDistributionChannels?: readonly unknown[];
  };
  readonly content?: {
    readonly article?: {
      readonly source?: string;
      readonly title?: string;
      readonly description?: string;
    };
    readonly media?: {
      readonly id?: string;
      readonly altText?: string;
      readonly title?: string;
    };
    readonly multiImage?: {
      readonly images?: readonly {
        readonly id?: string;
        readonly altText?: string;
      }[];
    };
  };
}


export interface LinkedInImageInitializeResponse {
  readonly value?: {
    readonly uploadUrl?: string;
    readonly uploadUrlExpiresAt?: number;
    readonly image?: string;
  };
}

export interface LinkedInImageRecord {
  readonly id: string;
  readonly owner?: string;
  readonly status?: "WAITING_UPLOAD" | "PROCESSING" | "PROCESSING_FAILED" | "AVAILABLE" | string;
  readonly downloadUrl?: string;
  readonly downloadUrlExpiresAt?: number;
}
