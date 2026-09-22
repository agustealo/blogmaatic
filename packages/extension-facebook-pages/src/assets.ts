import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { PublicationAsset } from "@blogmaatic/core";

import type { FacebookAssetSpec, FacebookSettings } from "./types.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"]);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

async function confinedPath(source: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(source)) throw new Error(`Facebook local asset source must be absolute: ${source}`);
  if (roots.length === 0) throw new Error("Facebook local assets require settings.assetSourceRoots");
  const candidate = await realpath(source);
  for (const root of roots) {
    const resolvedRoot = await realpath(root);
    const rel = relative(resolvedRoot, candidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidate;
  }
  throw new Error("Facebook local asset is outside the configured assetSourceRoots");
}

export async function compileFacebookAssets(
  assets: readonly PublicationAsset[],
  settings: FacebookSettings,
): Promise<readonly FacebookAssetSpec[]> {
  const compiled: FacebookAssetSpec[] = [];
  for (const asset of assets) {
    if (asset.kind !== "image") continue;
    if (asset.mediaType && !ALLOWED_MEDIA_TYPES.has(asset.mediaType)) {
      throw new Error(`Facebook image media type is not supported: ${asset.mediaType}`);
    }
    if (isWebUrl(asset.source)) {
      compiled.push({
        assetId: asset.id,
        source: asset.source,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.alt ? { alt: asset.alt } : {}),
        fingerprint: sha256(`remote:${asset.source}:${asset.mediaType ?? ""}`),
      });
      continue;
    }
    const localPath = await confinedPath(asset.source, settings.assetSourceRoots);
    const info = await stat(localPath);
    if (!info.isFile()) throw new Error("Facebook local asset must be a regular file");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("Facebook image exceeds the 10MB Graph API limit");
    const bytes = await readFile(localPath);
    compiled.push({
      assetId: asset.id,
      source: `managed-local:${asset.id}`,
      ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
      ...(asset.alt ? { alt: asset.alt } : {}),
      fingerprint: sha256(bytes),
      localPath,
    });
  }
  return compiled;
}

export async function localAssetBlob(asset: FacebookAssetSpec): Promise<Blob> {
  if (!asset.localPath) throw new Error("Facebook asset is not a managed local file");
  const bytes = await readFile(asset.localPath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: asset.mediaType ?? "application/octet-stream" });
}
