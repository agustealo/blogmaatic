import type { CompiledProjection, JsonValue } from "@blogmaatic/core";

import { isRecord, stringArray } from "./json.js";
import type { CompiledWordPressAsset, WordPressProjectionPayload } from "./types.js";

function requiredString(record: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`WordPress projection payload requires string ${key}`);
  return value;
}

function parseAssets(value: JsonValue | undefined): readonly CompiledWordPressAsset[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("WordPress projection asset must be an object");
    const assetId = requiredString(entry, "assetId");
    const source = requiredString(entry, "source");
    const mediaType = typeof entry.mediaType === "string" ? entry.mediaType : undefined;
    const alt = typeof entry.alt === "string" ? entry.alt : undefined;
    const fingerprint = typeof entry.fingerprint === "string" ? entry.fingerprint : undefined;
    const localPath = typeof entry.localPath === "string" ? entry.localPath : undefined;
    return {
      assetId,
      source,
      ...(mediaType ? { mediaType } : {}),
      ...(alt ? { alt } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(localPath ? { localPath } : {}),
    };
  });
}

export interface ParsedWordPressPayload extends WordPressProjectionPayload {
  readonly assetsParsed: readonly CompiledWordPressAsset[];
}

export function parsePayload(projection: CompiledProjection): ParsedWordPressPayload {
  if (!isRecord(projection.payload)) throw new Error("WordPress projection payload must be an object");
  const status = requiredString(projection.payload, "status");
  if (!["publish", "draft", "pending", "private", "future"].includes(status)) {
    throw new Error(`Unsupported WordPress post status: ${status}`);
  }
  const scheduledAt = typeof projection.payload.scheduledAt === "string" ? projection.payload.scheduledAt : undefined;
  const featuredAssetId = typeof projection.payload.featuredAssetId === "string" ? projection.payload.featuredAssetId : undefined;
  const assetsParsed = parseAssets(projection.payload.assets);
  return {
    title: requiredString(projection.payload, "title"),
    excerpt: requiredString(projection.payload, "excerpt"),
    slug: requiredString(projection.payload, "slug"),
    status: status as WordPressProjectionPayload["status"],
    bodyTemplate: requiredString(projection.payload, "bodyTemplate"),
    tags: stringArray(projection.payload.tags),
    categories: stringArray(projection.payload.categories),
    assets: projection.payload.assets && Array.isArray(projection.payload.assets)
      ? projection.payload.assets.filter(isRecord)
      : [],
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(featuredAssetId ? { featuredAssetId } : {}),
    assetsParsed,
  };
}
