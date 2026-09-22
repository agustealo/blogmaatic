import { basename } from "node:path";
import { readFile } from "node:fs/promises";

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
}

export async function publishMedia(
  client: WordPressRestClient,
  publicationId: string,
  asset: CompiledWordPressAsset,
): Promise<PublishedMedia> {
  if (!asset.localPath) {
    return { assetId: asset.assetId, sourceUrl: asset.source };
  }
  const slug = mediaSlug(publicationId, asset);
  const existing = await findMedia(client, slug);
  if (existing) {
    return { assetId: asset.assetId, mediaId: existing.id, sourceUrl: existing.source_url };
  }

  const bytes = await readFile(asset.localPath);
  const contentType = asset.mediaType ?? "application/octet-stream";
  const created = await client.requestBytes<WordPressMediaRecord>(
    "/media",
    bytes,
    contentType,
    basename(asset.localPath),
  );
  const updated = await client.requestJson<WordPressMediaRecord>(`/media/${created.id}`, {
    method: "POST",
    body: JSON.stringify({
      slug,
      ...(asset.alt ? { alt_text: asset.alt } : {}),
    }),
  });
  return { assetId: asset.assetId, mediaId: updated.id, sourceUrl: updated.source_url };
}
