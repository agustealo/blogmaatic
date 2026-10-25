import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { PublicationAsset } from "@blogmaatic/core";
import {
  planImageTransform,
  renderImageTransformCached,
  type ImageTransformSpec,
} from "@blogmaatic/media";

import type { LinkedInImageSpec, LinkedInSettings } from "./types.js";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 36_152_320;

function sha256(value: Uint8Array): string {
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
  if (isWebUrl(source)) {
    throw new Error("LinkedIn single-image delivery does not fetch remote canonical image URLs");
  }
  if (!isAbsolute(source)) throw new Error(`LinkedIn local image source must be absolute: ${source}`);
  if (roots.length === 0) throw new Error("LinkedIn local images require settings.assetSourceRoots");
  const candidate = await realpath(source);
  for (const root of roots) {
    const resolvedRoot = await realpath(root);
    const rel = relative(resolvedRoot, candidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return candidate;
  }
  throw new Error("LinkedIn local image is outside the configured assetSourceRoots");
}

export async function compileLinkedInImage(
  asset: PublicationAsset,
  settings: LinkedInSettings,
  transformSpec: ImageTransformSpec = {},
): Promise<LinkedInImageSpec> {
  if (asset.kind !== "image") throw new Error(`LinkedIn selected asset must be an image: ${asset.id}`);
  const localPath = await confinedPath(asset.source, settings.assetSourceRoots);
  const info = await stat(localPath);
  if (!info.isFile()) throw new Error("LinkedIn local image must be a regular file");
  if (info.size > MAX_SOURCE_BYTES) throw new Error("LinkedIn local image exceeds Blogmaatic's 50MB source safety ceiling");

  const bytes = await readFile(localPath);
  const plan = planImageTransform({ bytes, spec: transformSpec });
  if (plan.output.mediaType !== "image/jpeg" && plan.output.mediaType !== "image/png") {
    throw new Error("LinkedIn Images API requires JPEG or PNG output; configure imageTransform.format accordingly");
  }
  if (plan.output.width * plan.output.height >= MAX_IMAGE_PIXELS) {
    throw new Error(`LinkedIn image must contain fewer than ${MAX_IMAGE_PIXELS.toLocaleString()} pixels`);
  }
  if (asset.mediaType && asset.mediaType !== plan.source.mediaType) {
    throw new Error(
      `LinkedIn image mediaType ${asset.mediaType} does not match detected bytes ${plan.source.mediaType}`,
    );
  }

  return {
    assetId: asset.id,
    localPath,
    mediaType: plan.output.mediaType,
    ...(asset.alt ? { alt: asset.alt } : {}),
    fingerprint: plan.transformationFingerprint,
    transform: plan,
  };
}

export interface LinkedInRenderedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly outputFingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly cacheHit: boolean;
}

export async function renderLinkedInImage(asset: LinkedInImageSpec): Promise<LinkedInRenderedImage> {
  if (asset.transform?.renderRequired) {
    const rendered = await renderImageTransformCached({
      sourcePath: asset.localPath,
      plan: asset.transform,
    });
    if (rendered.mediaType !== "image/jpeg" && rendered.mediaType !== "image/png") {
      throw new Error(`LinkedIn rendered image has unsupported media type: ${rendered.mediaType}`);
    }
    return {
      bytes: rendered.bytes,
      mediaType: rendered.mediaType,
      outputFingerprint: rendered.outputFingerprint,
      width: rendered.width,
      height: rendered.height,
      cacheHit: rendered.cacheHit ?? false,
    };
  }

  const bytes = await readFile(asset.localPath);
  return {
    bytes,
    mediaType: asset.mediaType,
    outputFingerprint: sha256(bytes),
    width: asset.transform.source.width,
    height: asset.transform.source.height,
    cacheHit: false,
  };
}
