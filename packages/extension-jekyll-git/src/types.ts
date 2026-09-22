export interface JekyllGitSettings {
  readonly repositoryPath: string;
  readonly branch: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly postsDirectory: string;
  readonly draftsDirectory: string;
  readonly assetsDirectory: string;
  readonly remote: string;
  readonly push: boolean;
  readonly siteBaseUrl?: string;
  readonly buildVerification: "none" | "bundle";
  readonly assetSourceRoots: readonly string[];
}

export interface AssetOperation {
  readonly assetId: string;
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly fingerprint: string;
}

export interface JekyllPayload {
  readonly relativePath: string;
  readonly content: string;
  readonly assets: readonly AssetOperation[];
  readonly publicUrl?: string;
}

export interface FileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly content?: Buffer;
}
