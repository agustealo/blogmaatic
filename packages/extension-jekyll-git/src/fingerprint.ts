import { createHash } from "node:crypto";

import type { AssetOperation } from "./types.js";

export const FINGERPRINT_KEY = "blogmaatic_fingerprint";

export function fingerprint(content: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof content === "string") hash.update(content, "utf8");
  else hash.update(content);
  return hash.digest("hex");
}

export function combinedFingerprint(
  documentFingerprint: string,
  assets: readonly AssetOperation[],
): string {
  const assetState = [...assets]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      fingerprint: asset.fingerprint,
    }));
  return fingerprint(JSON.stringify({ documentFingerprint, assets: assetState }));
}

export function documentWithFingerprint(canonical: string, hash: string): string {
  const second = canonical.indexOf("\n---\n", 4);
  if (!canonical.startsWith("---\n") || second < 0) {
    throw new Error("Canonical Jekyll document is malformed");
  }
  return `${canonical.slice(0, second)}\n${FINGERPRINT_KEY}: ${JSON.stringify(hash)}${canonical.slice(second)}`;
}

export function stripFingerprint(content: string): string {
  return content.replace(new RegExp(`^${FINGERPRINT_KEY}:\\s*.*\\n`, "m"), "");
}
