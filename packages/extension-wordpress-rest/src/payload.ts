import type { CompiledProjection, JsonValue } from "@blogmaatic/core";
import { parseImageTransformPlan } from "@blogmaatic/media";

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
    const wordpressMediaId = entry.wordpressMediaId === undefined ? undefined : entry.wordpressMediaId;
    if (
      wordpressMediaId !== undefined &&
      (typeof wordpressMediaId !== "number" || !Number.isSafeInteger(wordpressMediaId) || wordpressMediaId < 1)
    ) {
      throw new Error("WordPress projection asset wordpressMediaId must be a positive integer");
    }
    const transform = entry.transform === undefined ? undefined : parseImageTransformPlan(entry.transform);
    return {
      assetId,
      source,
      ...(mediaType ? { mediaType } : {}),
      ...(alt ? { alt } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(localPath ? { localPath } : {}),
      ...(wordpressMediaId === undefined ? {} : { wordpressMediaId }),
      ...(transform ? { transform } : {}),
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
  const authorIdRaw = projection.payload.authorId;
  if (
    authorIdRaw !== undefined &&
    (typeof authorIdRaw !== "number" || !Number.isSafeInteger(authorIdRaw) || authorIdRaw < 1)
  ) {
    throw new Error("WordPress projection authorId must be a positive integer");
  }
  const parentIdRaw = projection.payload.parentId;
  if (
    parentIdRaw !== undefined &&
    (typeof parentIdRaw !== "number" || !Number.isSafeInteger(parentIdRaw) || parentIdRaw < 0)
  ) {
    throw new Error("WordPress projection parentId must be a non-negative integer");
  }
  const templateRaw = projection.payload.template;
  if (templateRaw !== undefined && typeof templateRaw !== "string") {
    throw new Error("WordPress projection template must be a string");
  }
  const menuOrderRaw = projection.payload.menuOrder;
  if (
    menuOrderRaw !== undefined &&
    (typeof menuOrderRaw !== "number" || !Number.isSafeInteger(menuOrderRaw) || menuOrderRaw < 0)
  ) {
    throw new Error("WordPress projection menuOrder must be a non-negative integer");
  }
  const assetsParsed = parseAssets(projection.payload.assets);
  return {
    contentType: requiredString(projection.payload, "contentType"),
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
    ...(authorIdRaw === undefined ? {} : { authorId: authorIdRaw }),
    ...(parentIdRaw === undefined ? {} : { parentId: parentIdRaw }),
    ...(templateRaw === undefined ? {} : { template: templateRaw }),
    ...(menuOrderRaw === undefined ? {} : { menuOrder: menuOrderRaw }),
    assetsParsed,
  };
}
