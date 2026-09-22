import { readFile } from "node:fs/promises";

import type { Publication } from "@blogmaatic/core";

import { sha256 } from "./fingerprint.js";
import { approvedLocalPath } from "./path-safety.js";
import type { CompiledWordPressAsset, WordPressSettings } from "./types.js";

export async function compileAssets(
  publication: Publication,
  settings: WordPressSettings,
): Promise<readonly CompiledWordPressAsset[]> {
  const compiled: CompiledWordPressAsset[] = [];
  for (const asset of publication.current.content.assets) {
    if (/^https?:\/\//i.test(asset.source)) {
      compiled.push({
        assetId: asset.id,
        source: asset.source,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.alt ? { alt: asset.alt } : {}),
      });
      continue;
    }
    const localPath = await approvedLocalPath(asset.source, settings.assetSourceRoots);
    const bytes = await readFile(localPath);
    compiled.push({
      assetId: asset.id,
      source: asset.source,
      localPath,
      fingerprint: sha256(bytes),
      ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
      ...(asset.alt ? { alt: asset.alt } : {}),
    });
  }
  return compiled;
}
