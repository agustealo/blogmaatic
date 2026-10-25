import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { PublicationAsset } from "@blogmaatic/core";
import {
  inspectImageBytes,
  planImageTransform,
  renderImageTransformCached,
  type ImageTransformPlan,
  type ImageTransformSpec,
} from "@blogmaatic/media";

import type { LinkedInImageSpec, LinkedInSettings } from "./types.js";

const LINKEDIN_MAX_PIXELS = 36_152_320;
const SUPPORTED_SOURCE_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_OUTPUT_MEDIA = new Set(["image/jpeg", "image/png"]);

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
  if (isWebUrl(source)) {
    throw new Error("LinkedIn remote image URLs are not supported until a hardened remote-ingestion boundary exists");
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
  const bytes = await readFile(localPath);
  const detected = inspectImageBytes(bytes);
  if (!SUPPORTED_SOURCE_MEDIA.has(detected.mediaType)) {
    throw new Error(`LinkedIn image source media type is not supported: ${detected.mediaType}`);
  }
  if (asset.mediaType && asset.mediaType !== detected.mediaType) {
    throw new Error(
      `LinkedIn image mediaType ${asset.mediaType} does not match detected bytes ${detected.mediaType}`,
    );
  }

  const requestedFormat = transformSpec.format;
  if (requestedFormat === "webp") {
    throw new Error("LinkedIn imageTransform.format cannot be webp");
  }
  const effectiveFormat = detected.mediaType === "image/webp" && (!requestedFormat || requestedFormat === "preserve")
    ? "jpeg"
    : requestedFormat;
  const transform = planImageTransform({
    bytes,
    spec: {
      ...transformSpec,
      ...(effectiveFormat === undefined ? {} : { format: effectiveFormat }),
    },
  });
  if (!SUPPORTED_OUTPUT_MEDIA.has(transform.output.mediaType)) {
    throw new Error(`LinkedIn rendered image media type is not supported: ${transform.output.mediaType}`);
  }
  if (transform.output.width * transform.output.height >= LINKEDIN_MAX_PIXELS) {
    throw new Error(
      `LinkedIn rendered image exceeds the Images API pixel limit: ${transform.output.width}x${transform.output.height}`,
    );
  }

  return {
    assetId: asset.id,
    source: `managed-local:${asset.id}`,
    localPath,
    mediaType: detected.mediaType,
    ...(asset.alt ? { alt: asset.alt } : {}),
    fingerprint: transform.sourceFingerprint ?? sha256(bytes),
    transform,
  };
}

export interface LinkedInRenderedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
  readonly outputFingerprint: string;
  readonly cacheHit: boolean;
  readonly transformationFingerprint: string;
  readonly derivedAssetId: string;
}

export async function renderLinkedInImage(asset: LinkedInImageSpec): Promise<LinkedInRenderedImage> {
  if (asset.transform.renderRequired) {
    const rendered = await renderImageTransformCached({
      sourcePath: asset.localPath,
      plan: asset.transform,
    });
    if (rendered.mediaType !== "image/jpeg" && rendered.mediaType !== "image/png") {
      throw new Error(`LinkedIn rendered image media type is not supported: ${rendered.mediaType}`);
    }
    return {
      bytes: rendered.bytes,
      mediaType: rendered.mediaType,
      width: asset.transform.output.width,
      height: asset.transform.output.height,
      outputFingerprint: rendered.outputFingerprint,
      cacheHit: rendered.cacheHit ?? false,
      transformationFingerprint: asset.transform.transformationFingerprint,
      derivedAssetId: asset.transform.derivedAssetId,
    };
  }

  const bytes = await readFile(asset.localPath);
  const mediaType = asset.transform.output.mediaType;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new Error(`LinkedIn rendered image media type is not supported: ${mediaType}`);
  }
  return {
    bytes,
    mediaType,
    width: asset.transform.output.width,
    height: asset.transform.output.height,
    outputFingerprint: sha256(bytes),
    cacheHit: false,
    transformationFingerprint: asset.transform.transformationFingerprint,
    derivedAssetId: asset.transform.derivedAssetId,
  };
}
