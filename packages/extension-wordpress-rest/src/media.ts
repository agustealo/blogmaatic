import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { renderImageTransformCached } from "@blogmaatic/media";

import { WordPressRestClient } from "./client.js";
import { termSlug } from "./taxonomy.js";
import type { CompiledWordPressAsset, WordPressMediaRecord } from "./types.js";

function mediaSlug(publicationId: string, asset: CompiledWordPressAsset): string {
  const base = `blogmaatic-${termSlug(publicationId)}-${termSlug(asset.assetId)}`;
  return asset.fingerprint ? `${base}-${asset.fingerprint.slice(0, 12)}` : base;
}

async function findMedia(
  client: WordPressRestClient,
  slug: string,
): Promise<WordPressMediaRecord | undefined> {
  const records = await client.requestJson<readonly WordPressMediaRecord[]>(
    `/media?context=edit&slug=${encodeURIComponent(slug)}&per_page=100`,
  );
  return records.find((record) => record.slug === slug);
}

export interface PublishedMedia {
  readonly assetId: string;
  readonly mediaId?: number;
  readonly sourceUrl: string;
  readonly transformationFingerprint?: string;
  readonly derivedAssetId?: string;
  readonly outputFingerprint?: string;
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly cacheHit?: boolean;
}

export async function publishMedia(
  client: WordPressRestClient,
  publicationId: string,
  asset: CompiledWordPressAsset,
): Promise<PublishedMedia> {
  if (!asset.localPath) {
    return {
      assetId: asset.assetId,
      ...(asset.wordpressMediaId === undefined ? {} : { mediaId: asset.wordpressMediaId }),
      sourceUrl: asset.source,
    };
  }
  const slug = mediaSlug(publicationId, asset);
  const existing = await findMedia(client, slug);
  if (existing) {
    return { assetId: asset.assetId, mediaId: existing.id, sourceUrl: existing.source_url };
  }

  let bytes: Uint8Array;
  let contentType = asset.mediaType ?? "application/octet-stream";
  let fileName = basename(asset.localPath);
  let transformEvidence: Omit<PublishedMedia, "assetId" | "mediaId" | "sourceUrl"> = {};
  if (asset.transform?.renderRequired) {
    const rendered = await renderImageTransformCached({
      sourcePath: asset.localPath,
      plan: asset.transform,
    });
    bytes = rendered.bytes;
    contentType = rendered.mediaType;
    const extension = rendered.mediaType === "image/png" ? "png" : rendered.mediaType === "image/webp" ? "webp" : "jpg";
    fileName = `${asset.transform.derivedAssetId}.${extension}`;
    transformEvidence = {
      transformationFingerprint: asset.transform.transformationFingerprint,
      derivedAssetId: asset.transform.derivedAssetId,
      outputFingerprint: rendered.outputFingerprint,
      mediaType: rendered.mediaType,
      width: rendered.width,
      height: rendered.height,
      cacheHit: rendered.cacheHit ?? false,
    };
  } else {
    bytes = await readFile(asset.localPath);
    if (asset.transform) {
      transformEvidence = {
        transformationFingerprint: asset.transform.transformationFingerprint,
        derivedAssetId: asset.transform.derivedAssetId,
        outputFingerprint: asset.transform.sourceFingerprint,
        mediaType: asset.transform.output.mediaType,
        width: asset.transform.output.width,
        height: asset.transform.output.height,
        cacheHit: false,
      };
    }
  }
  const created = await client.requestBytes<WordPressMediaRecord>(
    "/media",
    bytes,
    contentType,
    fileName,
  );
  const updated = await client.requestJson<WordPressMediaRecord>(`/media/${created.id}`, {
    method: "POST",
    body: JSON.stringify({
      slug,
      ...(asset.alt ? { alt_text: asset.alt } : {}),
    }),
  });
  return {
    assetId: asset.assetId,
    mediaId: updated.id,
    sourceUrl: updated.source_url,
    ...transformEvidence,
  };
}
