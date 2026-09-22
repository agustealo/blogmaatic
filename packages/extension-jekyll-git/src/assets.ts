import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";

import type { Publication } from "@blogmaatic/core";

import { fingerprint } from "./fingerprint.js";
import { safeSegment } from "./path-safety.js";
import type { AssetOperation, JekyllGitSettings } from "./types.js";

function isRemoteAsset(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function assertAllowedAssetSource(
  source: string,
  roots: readonly string[],
): Promise<string> {
  if (!isAbsolute(source)) {
    throw new Error(`Local asset source must be absolute: ${source}`);
  }
  const actual = await realpath(source);
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    let actualRoot: string;
    try {
      actualRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(actualRoot, actual);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return actual;
    }
  }
  throw new Error(`Local asset source is outside configured assetSourceRoots: ${source}`);
}

export async function assetOperations(
  publication: Publication,
  settings: JekyllGitSettings,
): Promise<readonly AssetOperation[]> {
  const operations: AssetOperation[] = [];
  for (const asset of publication.current.content.assets) {
    if (isRemoteAsset(asset.source)) continue;
    const sourcePath = await assertAllowedAssetSource(asset.source, settings.assetSourceRoots);
    const sourceName = basename(sourcePath);
    const extension = sourceName.match(/\.[^.]+$/)?.[0] ?? "";
    const stem = sourceName.replace(/\.[^.]+$/, "");
    const fileName = `${safeSegment(asset.id)}-${safeSegment(stem)}${extension}`;
    operations.push({
      assetId: asset.id,
      sourcePath,
      relativePath: `${settings.assetsDirectory}/${safeSegment(publication.id)}/${fileName}`,
      fingerprint: fingerprint(await readFile(sourcePath)),
    });
  }
  return operations;
}
