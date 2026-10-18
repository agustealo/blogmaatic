import type { CompiledProjection } from "@blogmaatic/core";
import { parseImageTransformPlan } from "@blogmaatic/media";

import { getString, isRecord } from "./json.js";
import type { AssetOperation, JekyllPayload } from "./types.js";

export function parsePayload(projection: CompiledProjection): JekyllPayload {
  if (!isRecord(projection.payload)) {
    throw new Error("Jekyll projection payload must be an object");
  }
  const relativePath = getString(projection.payload, "relativePath");
  const content = getString(projection.payload, "content");
  if (!relativePath || content === undefined) {
    throw new Error("Jekyll projection payload is missing path/content");
  }

  const rawAssets = projection.payload.assets;
  const assets: AssetOperation[] = Array.isArray(rawAssets)
    ? rawAssets.filter(isRecord).map((item) => {
        const sourcePath = getString(item, "sourcePath");
        const assetPath = getString(item, "relativePath");
        const assetFingerprint = getString(item, "fingerprint");
        if (!sourcePath || !assetPath || !assetFingerprint) {
          throw new Error("Invalid Jekyll asset operation");
        }
        const mediaType = getString(item, "mediaType");
        const transform = item.transform === undefined ? undefined : parseImageTransformPlan(item.transform);
        return {
          assetId: getString(item, "assetId") ?? "unknown",
          sourcePath,
          relativePath: assetPath,
          fingerprint: assetFingerprint,
          ...(mediaType ? { mediaType } : {}),
          ...(transform ? { transform } : {}),
        };
      })
    : [];
  const url = getString(projection.payload, "publicUrl");
  return { relativePath, content, assets, ...(url ? { publicUrl: url } : {}) };
}
