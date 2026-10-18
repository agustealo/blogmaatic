import { createHash } from "node:crypto";

import type { JsonValue } from "@blogmaatic/core";

export const MEDIA_TRANSFORM_IMPLEMENTATION = "blogmaatic-sharp-0.35.5-v1" as const;

export type ImageFit = "contain" | "cover";
export type ImageOutputFormat = "preserve" | "jpeg" | "png" | "webp";

export interface ImageFocalPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageTransformSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly focalPoint?: ImageFocalPoint;
  readonly format?: ImageOutputFormat;
  readonly quality?: number;
  readonly maxBytes?: number;
  readonly withoutEnlargement?: boolean;
}

export interface NormalizedImageTransformSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit: ImageFit;
  readonly focalPoint: ImageFocalPoint;
  readonly format: ImageOutputFormat;
  readonly quality: number;
  readonly maxBytes?: number;
  readonly withoutEnlargement: boolean;
}

export interface ImageMetadata {
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

export interface ImageTransformPlan {
  readonly schemaVersion: 1;
  readonly implementationVersion: typeof MEDIA_TRANSFORM_IMPLEMENTATION;
  readonly source: ImageMetadata;
  readonly sourceFingerprint: string;
  readonly spec: NormalizedImageTransformSpec;
  readonly output: {
    readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
    readonly width: number;
    readonly height: number;
    readonly maxBytes?: number;
  };
  readonly renderRequired: boolean;
  readonly transformationFingerprint: string;
  readonly derivedAssetId: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function positiveDimension(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 32768) {
    throw new Error(`${label} must be an integer from 1 through 32768`);
  }
  return value;
}

function positiveByteLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1024 * 1024 * 1024) {
    throw new Error("Image maxBytes must be an integer from 1 through 1073741824");
  }
  return value;
}

function bounded(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

export function normalizeImageTransformSpec(spec: ImageTransformSpec = {}): NormalizedImageTransformSpec {
  const width = positiveDimension(spec.width, "Image width");
  const height = positiveDimension(spec.height, "Image height");
  const quality = spec.quality ?? 85;
  if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) {
    throw new Error("Image quality must be an integer from 1 through 100");
  }
  const maxBytes = positiveByteLimit(spec.maxBytes);
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    fit: spec.fit ?? "contain",
    focalPoint: {
      x: bounded(spec.focalPoint?.x ?? 0.5, "Image focalPoint.x"),
      y: bounded(spec.focalPoint?.y ?? 0.5, "Image focalPoint.y"),
    },
    format: spec.format ?? "preserve",
    quality,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    withoutEnlargement: spec.withoutEnlargement ?? true,
  };
}

function pngMetadata(bytes: Uint8Array): ImageMetadata | undefined {
  if (bytes.byteLength < 24) return undefined;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) throw new Error("PNG has invalid dimensions");
  return { mediaType: "image/png", width, height, byteLength: bytes.byteLength };
}

function jpegMetadata(bytes: Uint8Array): ImageMetadata | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (!width || !height) throw new Error("JPEG has invalid dimensions");
      return { mediaType: "image/jpeg", width, height, byteLength: bytes.byteLength };
    }
    offset += length;
  }
  throw new Error("JPEG dimensions could not be determined");
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function webpMetadata(bytes: Uint8Array): ImageMetadata | undefined {
  if (bytes.byteLength < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return undefined;
  }
  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
  } else if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) throw new Error("WebP lossless signature is invalid");
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    width = 1 + (((b2 & 0x3f) << 8) | b1);
    height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
  } else if (chunk === "VP8 ") {
    if (bytes.byteLength < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new Error("WebP lossy frame header is invalid");
    }
    width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
  } else {
    throw new Error(`Unsupported WebP chunk: ${chunk}`);
  }
  if (!width || !height) throw new Error("WebP has invalid dimensions");
  return { mediaType: "image/webp", width, height, byteLength: bytes.byteLength };
}

export function inspectImageBytes(bytes: Uint8Array): ImageMetadata {
  return pngMetadata(bytes) ?? jpegMetadata(bytes) ?? webpMetadata(bytes) ??
    (() => { throw new Error("Unsupported image bytes; expected PNG, JPEG, or WebP"); })();
}

export function imageFingerprint(bytes: Uint8Array): string {
  return sha256(bytes);
}

function outputMediaType(
  source: ImageMetadata["mediaType"],
  format: ImageOutputFormat,
): ImageMetadata["mediaType"] {
  if (format === "preserve") return source;
  return format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
}

function plannedDimensions(
  source: ImageMetadata,
  spec: NormalizedImageTransformSpec,
): { width: number; height: number } {
  const targetWidth = spec.width;
  const targetHeight = spec.height;
  if (targetWidth === undefined && targetHeight === undefined) {
    return { width: source.width, height: source.height };
  }
  if (targetWidth !== undefined && targetHeight !== undefined && spec.fit === "cover") {
    let scale = Math.max(targetWidth / source.width, targetHeight / source.height);
    if (spec.withoutEnlargement) scale = Math.min(scale, 1);
    const resizedWidth = Math.max(1, Math.round(source.width * scale));
    const resizedHeight = Math.max(1, Math.round(source.height * scale));
    return {
      width: Math.min(targetWidth, resizedWidth),
      height: Math.min(targetHeight, resizedHeight),
    };
  }

  const widthRatio = targetWidth === undefined ? Number.POSITIVE_INFINITY : targetWidth / source.width;
  const heightRatio = targetHeight === undefined ? Number.POSITIVE_INFINITY : targetHeight / source.height;
  let scale = Math.min(widthRatio, heightRatio);
  if (!Number.isFinite(scale)) {
    scale = targetWidth === undefined ? heightRatio : widthRatio;
  }
  if (spec.withoutEnlargement) scale = Math.min(scale, 1);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

export function planImageTransform(input: {
  readonly bytes: Uint8Array;
  readonly spec?: ImageTransformSpec;
}): ImageTransformPlan {
  const source = inspectImageBytes(input.bytes);
  const sourceFingerprint = imageFingerprint(input.bytes);
  const spec = normalizeImageTransformSpec(input.spec);
  const dimensions = plannedDimensions(source, spec);
  const mediaType = outputMediaType(source.mediaType, spec.format);
  const renderRequired =
    dimensions.width !== source.width ||
    dimensions.height !== source.height ||
    mediaType !== source.mediaType ||
    spec.quality !== 85 ||
    (spec.maxBytes !== undefined && source.byteLength > spec.maxBytes);

  const transformSemantic: JsonValue = {
    implementationVersion: MEDIA_TRANSFORM_IMPLEMENTATION,
    sourceFingerprint,
    source: {
      mediaType: source.mediaType,
      width: source.width,
      height: source.height,
      byteLength: source.byteLength,
    },
    spec: {
      width: spec.width ?? null,
      height: spec.height ?? null,
      fit: spec.fit,
      focalPoint: { x: spec.focalPoint.x, y: spec.focalPoint.y },
      format: spec.format,
      quality: spec.quality,
      maxBytes: spec.maxBytes ?? null,
      withoutEnlargement: spec.withoutEnlargement,
    },
    output: {
      mediaType,
      width: dimensions.width,
      height: dimensions.height,
      maxBytes: spec.maxBytes ?? null,
    },
  };
  const transformationFingerprint = sha256(stable(transformSemantic));

  return {
    schemaVersion: 1,
    implementationVersion: MEDIA_TRANSFORM_IMPLEMENTATION,
    source,
    sourceFingerprint,
    spec,
    output: {
      mediaType,
      width: dimensions.width,
      height: dimensions.height,
      ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
    },
    renderRequired,
    transformationFingerprint,
    derivedAssetId: `derived_${transformationFingerprint.slice(0, 24)}`,
  };
}

export { renderImageTransform, renderImageTransformCached } from "./renderer.js";

export function assertImagePlanRenderableWithoutTransformer(plan: ImageTransformPlan): void {
  if (plan.renderRequired) {
    throw new Error(
      `Image transform ${plan.derivedAssetId} requires a media renderer before delivery (${plan.source.width}x${plan.source.height} ${plan.source.mediaType} -> ${plan.output.width}x${plan.output.height} ${plan.output.mediaType})`,
    );
  }
}
