import type { FidelityReport } from "@blogmaatic/variants";

export type FacebookProjectionMode = "text" | "link" | "image";

export interface FacebookSettings {
  readonly apiRoot: string;
  readonly apiVersion: string;
  readonly pageId: string;
  readonly pageAccessTokenRef: string;
  readonly assetSourceRoots: readonly string[];
  readonly timeoutMs: number;
}

export interface FacebookAssetSpec {
  readonly assetId: string;
  readonly source: string;
  readonly mediaType?: string;
  readonly alt?: string;
  readonly fingerprint?: string;
  readonly localPath?: string;
}

export interface FacebookProjectionPayload {
  readonly mode: FacebookProjectionMode;
  readonly message: string;
  readonly link?: string;
  readonly images: readonly FacebookAssetSpec[];
  readonly scheduledAt?: string;
  readonly fidelity: FidelityReport;
}

export interface FacebookAttachment {
  readonly media_type?: string;
  readonly url?: string;
  readonly target?: { readonly id?: string };
  readonly subattachments?: { readonly data?: readonly FacebookAttachment[] };
}

export interface FacebookPostRecord {
  readonly id: string;
  readonly message?: string;
  readonly permalink_url?: string;
  readonly created_time?: string;
  readonly updated_time?: string;
  readonly link?: string;
  readonly is_published?: boolean;
  readonly scheduled_publish_time?: number;
  readonly attachments?: { readonly data?: readonly FacebookAttachment[] };
}
