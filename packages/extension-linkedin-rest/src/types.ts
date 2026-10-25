import type { ImageTransformPlan } from "@blogmaatic/media";
import type { FidelityReport, SocialArticleVariant } from "@blogmaatic/variants";

export interface LinkedInSettings {
  readonly apiRoot: string;
  readonly apiVersion: string;
  readonly authorUrn: string;
  readonly accessTokenRef: string;
  readonly assetSourceRoots: readonly string[];
  readonly timeoutMs: number;
}

export type LinkedInProjectionMode = "text" | "article" | "image";

export interface LinkedInImageSpec {
  readonly assetId: string;
  readonly localPath: string;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly alt?: string;
  readonly fingerprint: string;
  readonly transform?: ImageTransformPlan;
}

export interface LinkedInProjectionPayload {
  readonly mode: LinkedInProjectionMode;
  readonly commentary: string;
  readonly article?: SocialArticleVariant;
  readonly image?: LinkedInImageSpec;
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
      readonly title?: string;
      readonly altText?: string;
    };
  };
}
