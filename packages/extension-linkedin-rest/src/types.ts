import type { FidelityReport, SocialArticleVariant } from "@blogmaatic/variants";

export interface LinkedInSettings {
  readonly apiRoot: string;
  readonly apiVersion: string;
  readonly authorUrn: string;
  readonly accessTokenRef: string;
  readonly timeoutMs: number;
}

export type LinkedInProjectionMode = "text" | "article";

export interface LinkedInProjectionPayload {
  readonly mode: LinkedInProjectionMode;
  readonly commentary: string;
  readonly article?: SocialArticleVariant;
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
  };
}
