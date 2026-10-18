import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp, { type Sharp } from "sharp";

import type { ImageTransformPlan } from "./index.js";

export interface RenderedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly outputFingerprint: string;
  readonly transformationFingerprint: string;
  readonly derivedAssetId: string;
  readonly effectiveQuality?: number;
  readonly cachePath?: string;
  readonly cacheHit?: boolean;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function extension(mediaType: RenderedImage["mediaType"]): string {
  return mediaType === "image/jpeg" ? ".jpg" : mediaType === "image/png" ? ".png" : ".webp";
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function coverGeometry(plan: ImageTransformPlan): {
  readonly resizedWidth: number;
  readonly resizedHeight: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} | undefined {
  const targetWidth = plan.spec.width;
  const targetHeight = plan.spec.height;
  if (plan.spec.fit !== "cover" || targetWidth === undefined || targetHeight === undefined) return undefined;

  let scale = Math.max(targetWidth / plan.source.width, targetHeight / plan.source.height);
  if (plan.spec.withoutEnlargement) scale = Math.min(scale, 1);
  const resizedWidth = Math.max(1, Math.round(plan.source.width * scale));
  const resizedHeight = Math.max(1, Math.round(plan.source.height * scale));
  const outputWidth = Math.min(targetWidth, resizedWidth);
  const outputHeight = Math.min(targetHeight, resizedHeight);
  const left = clamp(
    Math.round(plan.spec.focalPoint.x * resizedWidth - outputWidth / 2),
    0,
    Math.max(0, resizedWidth - outputWidth),
  );
  const top = clamp(
    Math.round(plan.spec.focalPoint.y * resizedHeight - outputHeight / 2),
    0,
    Math.max(0, resizedHeight - outputHeight),
  );
  return {
    resizedWidth,
    resizedHeight,
    left,
    top,
    width: outputWidth,
    height: outputHeight,
  };
}

function pipelineForGeometry(bytes: Uint8Array, plan: ImageTransformPlan): Sharp {
  let pipeline = sharp(Buffer.from(bytes), { failOn: "error" });
  const cover = coverGeometry(plan);
  if (cover) {
    if (cover.resizedWidth !== plan.source.width || cover.resizedHeight !== plan.source.height) {
      pipeline = pipeline.resize({
        width: cover.resizedWidth,
        height: cover.resizedHeight,
        fit: "fill",
        withoutEnlargement: plan.spec.withoutEnlargement,
      });
    }
    if (
      cover.left !== 0 ||
      cover.top !== 0 ||
      cover.width !== cover.resizedWidth ||
      cover.height !== cover.resizedHeight
    ) {
      pipeline = pipeline.extract({
        left: cover.left,
        top: cover.top,
        width: cover.width,
        height: cover.height,
      });
    }
    return pipeline;
  }

  if (plan.output.width !== plan.source.width || plan.output.height !== plan.source.height) {
    pipeline = pipeline.resize({
      width: plan.output.width,
      height: plan.output.height,
      fit: "fill",
      withoutEnlargement: plan.spec.withoutEnlargement,
    });
  }
  return pipeline;
}

async function encode(
  sourceBytes: Uint8Array,
  plan: ImageTransformPlan,
  quality: number,
): Promise<Buffer> {
  let pipeline = pipelineForGeometry(sourceBytes, plan);
  if (plan.output.mediaType === "image/jpeg") {
    pipeline = pipeline.jpeg({
      quality,
      chromaSubsampling: "4:4:4",
      mozjpeg: false,
    });
  } else if (plan.output.mediaType === "image/webp") {
    pipeline = pipeline.webp({ quality, smartSubsample: false });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: false });
  }
  return pipeline.toBuffer();
}

async function verifyRendered(
  bytes: Uint8Array,
  plan: ImageTransformPlan,
  effectiveQuality?: number,
): Promise<RenderedImage> {
  const metadata = await sharp(Buffer.from(bytes), { failOn: "error" }).metadata();
  if (
    metadata.width !== plan.output.width ||
    metadata.height !== plan.output.height
  ) {
    throw new Error(
      `Rendered image dimensions do not match media plan: expected ${plan.output.width}x${plan.output.height}, got ${metadata.width ?? "?"}x${metadata.height ?? "?"}`,
    );
  }
  const expectedFormat = plan.output.mediaType === "image/jpeg"
    ? "jpeg"
    : plan.output.mediaType === "image/png"
      ? "png"
      : "webp";
  if (metadata.format !== expectedFormat) {
    throw new Error(
      `Rendered image format does not match media plan: expected ${expectedFormat}, got ${metadata.format ?? "unknown"}`,
    );
  }
  if (plan.output.maxBytes !== undefined && bytes.byteLength > plan.output.maxBytes) {
    throw new Error(
      `Rendered image exceeds destination byte ceiling: ${bytes.byteLength} > ${plan.output.maxBytes}`,
    );
  }
  return {
    bytes,
    mediaType: plan.output.mediaType,
    width: plan.output.width,
    height: plan.output.height,
    byteLength: bytes.byteLength,
    outputFingerprint: sha256(bytes),
    transformationFingerprint: plan.transformationFingerprint,
    derivedAssetId: plan.derivedAssetId,
    ...(effectiveQuality === undefined ? {} : { effectiveQuality }),
  };
}

export async function renderImageTransform(input: {
  readonly bytes: Uint8Array;
  readonly plan: ImageTransformPlan;
}): Promise<RenderedImage> {
  const sourceFingerprint = sha256(input.bytes);
  if (sourceFingerprint !== input.plan.sourceFingerprint) {
    throw new Error("Source image bytes do not match the media plan fingerprint");
  }

  if (!input.plan.renderRequired) {
    return verifyRendered(input.bytes, input.plan);
  }

  const initialQuality = input.plan.spec.quality;
  const supportsQualityReduction =
    input.plan.output.mediaType === "image/jpeg" ||
    input.plan.output.mediaType === "image/webp";
  const qualityFloor = 30;
  let quality = initialQuality;

  while (true) {
    const bytes = await encode(input.bytes, input.plan, quality);
    if (
      input.plan.output.maxBytes === undefined ||
      bytes.byteLength <= input.plan.output.maxBytes
    ) {
      return verifyRendered(bytes, input.plan, quality);
    }
    if (!supportsQualityReduction || quality <= qualityFloor) {
      throw new Error(
        `Image cannot satisfy destination byte ceiling ${input.plan.output.maxBytes} with the configured transform`,
      );
    }
    quality = Math.max(qualityFloor, quality - 5);
  }
}

interface CacheMetadata {
  readonly transformationFingerprint: string;
  readonly sourceFingerprint: string;
  readonly outputFingerprint: string;
  readonly mediaType: RenderedImage["mediaType"];
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly effectiveQuality?: number;
}

async function cachedResult(
  outputPath: string,
  metadataPath: string,
  plan: ImageTransformPlan,
): Promise<RenderedImage | undefined> {
  try {
    const [bytes, rawMetadata] = await Promise.all([
      readFile(outputPath),
      readFile(metadataPath, "utf8"),
    ]);
    const metadata = JSON.parse(rawMetadata) as CacheMetadata;
    if (
      metadata.transformationFingerprint !== plan.transformationFingerprint ||
      metadata.sourceFingerprint !== plan.sourceFingerprint ||
      metadata.outputFingerprint !== sha256(bytes)
    ) {
      return undefined;
    }
    const verified = await verifyRendered(bytes, plan, metadata.effectiveQuality);
    return {
      ...verified,
      cachePath: outputPath,
      cacheHit: true,
    };
  } catch {
    return undefined;
  }
}

export async function renderImageTransformCached(input: {
  readonly sourcePath: string;
  readonly plan: ImageTransformPlan;
  readonly cacheDirectory?: string;
}): Promise<RenderedImage> {
  const cacheDirectory = input.cacheDirectory ?? join(tmpdir(), "blogmaatic-media-cache-v1");
  const suffix = extension(input.plan.output.mediaType);
  const outputPath = join(cacheDirectory, `${input.plan.derivedAssetId}${suffix}`);
  const metadataPath = `${outputPath}.json`;
  await mkdir(cacheDirectory, { recursive: true });

  const existing = await cachedResult(outputPath, metadataPath, input.plan);
  if (existing) return existing;

  await Promise.all([
    rm(outputPath, { force: true }),
    rm(metadataPath, { force: true }),
  ]);
  const sourceBytes = await readFile(input.sourcePath);
  const rendered = await renderImageTransform({ bytes: sourceBytes, plan: input.plan });
  const token = randomUUID();
  const temporaryOutput = join(cacheDirectory, `.${input.plan.derivedAssetId}.${token}${suffix}`);
  const temporaryMetadata = `${temporaryOutput}.json`;
  const metadata: CacheMetadata = {
    transformationFingerprint: input.plan.transformationFingerprint,
    sourceFingerprint: input.plan.sourceFingerprint,
    outputFingerprint: rendered.outputFingerprint,
    mediaType: rendered.mediaType,
    width: rendered.width,
    height: rendered.height,
    byteLength: rendered.byteLength,
    ...(rendered.effectiveQuality === undefined ? {} : { effectiveQuality: rendered.effectiveQuality }),
  };

  await writeFile(temporaryOutput, rendered.bytes, { flag: "wx" });
  await writeFile(temporaryMetadata, JSON.stringify(metadata), { flag: "wx" });
  try {
    await rename(temporaryOutput, outputPath);
    await rename(temporaryMetadata, metadataPath);
  } catch (error) {
    await Promise.all([
      rm(temporaryOutput, { force: true }),
      rm(temporaryMetadata, { force: true }),
    ]);
    const concurrent = await cachedResult(outputPath, metadataPath, input.plan);
    if (concurrent) return concurrent;
    throw error;
  }

  return {
    ...rendered,
    cachePath: outputPath,
    cacheHit: false,
  };
}
