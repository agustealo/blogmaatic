import type { JsonValue, PublicationBlock, PublicationBlockKind } from "@blogmaatic/core";

import type {
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchBody,
  PublicationWorkspaceUpdateBody,
  PublicationBodyFormat,
  WorkspacePublicationStatus,
} from "./types.js";
import { OperatorRequestError } from "./validation.js";

const statuses = new Set<WorkspacePublicationStatus>(["idea", "draft", "ready", "approved", "archived"]);
const bodyFormats = new Set<PublicationBodyFormat>(["plain", "html"]);
const blockKinds = new Set<PublicationBlockKind>([
  "heading",
  "paragraph",
  "image",
  "gallery",
  "quote",
  "code",
  "embed",
  "table",
  "callout",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorRequestError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  const key = Object.keys(input).find((candidate) => !set.has(candidate));
  if (key) throw new OperatorRequestError(`${label} contains unknown field: ${key}`);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new OperatorRequestError(`${key} is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new OperatorRequestError(`${key} must be a string`);
  return value;
}

function expectedVersion(input: Record<string, unknown>): number {
  const value = input.expectedVersion;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  return value as number;
}

function stringList(input: Record<string, unknown>, key: "tags" | "categories"): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new OperatorRequestError(`${key} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

function publishingTargetGroupIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.publishingTargetGroupIds;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((groupId) => typeof groupId !== "string" || !groupId.trim())) {
    throw new OperatorRequestError("publishingTargetGroupIds must be an array of non-empty strings");
  }
  return [...new Set((value as readonly string[]).map((groupId) => groupId.trim()))];
}

function featuredAssetId(input: Record<string, unknown>): string | null | undefined {
  const value = input.featuredAssetId;
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new OperatorRequestError("featuredAssetId must be a non-empty string or null");
  }
  return value.trim();
}

function status(input: Record<string, unknown>): WorkspacePublicationStatus | undefined {
  const value = input.status;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !statuses.has(value as WorkspacePublicationStatus)) {
    throw new OperatorRequestError("status must be idea, draft, ready, approved, or archived");
  }
  return value as WorkspacePublicationStatus;
}

function bodyFormat(input: Record<string, unknown>): PublicationBodyFormat | undefined {
  const value = input.bodyFormat;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !bodyFormats.has(value as PublicationBodyFormat)) {
    throw new OperatorRequestError("bodyFormat must be plain or html");
  }
  return value as PublicationBodyFormat;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`)]),
    );
  }
  throw new OperatorRequestError(`${label} must contain only JSON-safe values`);
}

function blocks(input: Record<string, unknown>): readonly PublicationBlock[] | undefined {
  const value = input.blocks;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new OperatorRequestError("blocks must be an array");

  const seen = new Set<string>();
  return value.map((item, index) => {
    const block = record(item, `blocks[${index}]`);
    rejectUnknown(block, ["id", "kind", "data"], `blocks[${index}]`);
    const id = requiredString(block, "id").trim();
    if (id.length > 200) throw new OperatorRequestError(`blocks[${index}].id must not exceed 200 characters`);
    if (seen.has(id)) throw new OperatorRequestError(`blocks contains duplicate id: ${id}`);
    seen.add(id);

    const kind = block.kind;
    if (typeof kind !== "string" || !blockKinds.has(kind as PublicationBlockKind)) {
      throw new OperatorRequestError(`blocks[${index}].kind is unsupported`);
    }
    const data = record(block.data, `blocks[${index}].data`);
    return {
      id,
      kind: kind as PublicationBlockKind,
      data: jsonValue(data, `blocks[${index}].data`) as Readonly<Record<string, JsonValue>>,
    };
  });
}

function optionalQueryLimit(input: Record<string, unknown>): number | undefined {
  const value = input.limit;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new OperatorRequestError("limit must be an integer between 1 and 200");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new OperatorRequestError("limit must be an integer between 1 and 200");
  }
  return parsed;
}

function optionalQueryString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new OperatorRequestError(`${key} must be a non-empty string`);
  return value;
}

export function parsePublicationWorkspaceCreateBody(body: unknown): PublicationWorkspaceCreateBody {
  const input = record(body, "request body");
  rejectUnknown(input, ["title", "body", "bodyFormat", "blocks", "summary", "language", "tags", "categories", "publishingTargetGroupIds", "slug", "canonicalUrl", "status"], "request body");
  const parsedTags = stringList(input, "tags");
  const parsedCategories = stringList(input, "categories");
  const parsedPublishingTargetGroupIds = publishingTargetGroupIds(input);
  const parsedStatus = status(input);
  const bodyValue = optionalString(input, "body");
  const parsedBlocks = blocks(input);
  const parsedBodyFormat = bodyFormat(input);
  if (parsedBodyFormat !== undefined && bodyValue === undefined) {
    throw new OperatorRequestError("bodyFormat requires body");
  }
  if (parsedBlocks !== undefined && bodyValue !== undefined) {
    throw new OperatorRequestError("blocks and body are mutually exclusive");
  }
  if (parsedBlocks !== undefined && parsedBodyFormat !== undefined) {
    throw new OperatorRequestError("bodyFormat cannot be used with blocks");
  }
  const summary = optionalString(input, "summary");
  const language = optionalString(input, "language");
  const slug = optionalString(input, "slug");
  const canonicalUrl = optionalString(input, "canonicalUrl");
  return {
    title: requiredString(input, "title"),
    ...(bodyValue === undefined ? {} : { body: bodyValue }),
    ...(parsedBlocks === undefined ? {} : { blocks: parsedBlocks }),
    ...(parsedBodyFormat === undefined ? {} : { bodyFormat: parsedBodyFormat }),
    ...(summary === undefined ? {} : { summary }),
    ...(language === undefined ? {} : { language }),
    ...(parsedTags === undefined ? {} : { tags: parsedTags }),
    ...(parsedCategories === undefined ? {} : { categories: parsedCategories }),
    ...(parsedPublishingTargetGroupIds === undefined ? {} : { publishingTargetGroupIds: parsedPublishingTargetGroupIds }),
    ...(slug === undefined ? {} : { slug }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
  };
}

export function parsePublicationWorkspaceUpdateBody(body: unknown): PublicationWorkspaceUpdateBody {
  const input = record(body, "request body");
  rejectUnknown(input, ["expectedVersion", "title", "body", "bodyFormat", "blocks", "summary", "language", "tags", "categories", "featuredAssetId", "publishingTargetGroupIds", "slug", "canonicalUrl", "status"], "request body");
  const title = optionalString(input, "title");
  const bodyValue = optionalString(input, "body");
  const parsedBlocks = blocks(input);
  const parsedBodyFormat = bodyFormat(input);
  if (parsedBodyFormat !== undefined && bodyValue === undefined) {
    throw new OperatorRequestError("bodyFormat requires body");
  }
  if (parsedBlocks !== undefined && bodyValue !== undefined) {
    throw new OperatorRequestError("blocks and body are mutually exclusive");
  }
  if (parsedBlocks !== undefined && parsedBodyFormat !== undefined) {
    throw new OperatorRequestError("bodyFormat cannot be used with blocks");
  }
  const summary = optionalString(input, "summary");
  const language = optionalString(input, "language");
  const parsedTags = stringList(input, "tags");
  const parsedCategories = stringList(input, "categories");
  const parsedFeaturedAssetId = featuredAssetId(input);
  const parsedPublishingTargetGroupIds = publishingTargetGroupIds(input);
  const slug = optionalString(input, "slug");
  const canonicalUrl = optionalString(input, "canonicalUrl");
  const parsedStatus = status(input);
  return {
    expectedVersion: expectedVersion(input),
    ...(title === undefined ? {} : { title }),
    ...(bodyValue === undefined ? {} : { body: bodyValue }),
    ...(parsedBlocks === undefined ? {} : { blocks: parsedBlocks }),
    ...(parsedBodyFormat === undefined ? {} : { bodyFormat: parsedBodyFormat }),
    ...(summary === undefined ? {} : { summary }),
    ...(language === undefined ? {} : { language }),
    ...(parsedTags === undefined ? {} : { tags: parsedTags }),
    ...(parsedCategories === undefined ? {} : { categories: parsedCategories }),
    ...(parsedFeaturedAssetId === undefined ? {} : { featuredAssetId: parsedFeaturedAssetId }),
    ...(parsedPublishingTargetGroupIds === undefined ? {} : { publishingTargetGroupIds: parsedPublishingTargetGroupIds }),
    ...(slug === undefined ? {} : { slug }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
  };
}

export function parsePublicationWorkspaceDispatchBody(body: unknown): PublicationWorkspaceDispatchBody {
  const input = record(body, "request body");
  rejectUnknown(input, ["expectedVersion"], "request body");
  return { expectedVersion: expectedVersion(input) };
}

export function parsePublicationWorkspaceListQuery(query: unknown): {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: WorkspacePublicationStatus;
  readonly search?: string;
} {
  const input = query === undefined || query === null ? {} : record(query, "query");
  rejectUnknown(input, ["limit", "cursor", "status", "search"], "query");
  const limit = optionalQueryLimit(input);
  const cursor = optionalQueryString(input, "cursor");
  const parsedStatus = status(input);
  const search = optionalQueryString(input, "search")?.trim();
  if (search && search.length > 200) {
    throw new OperatorRequestError("search must not exceed 200 characters");
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
    ...(search === undefined ? {} : { search }),
  };
}

export function parsePublicationWorkspaceVersionListQuery(query: unknown): { readonly limit?: number; readonly cursor?: string } {
  const input = query === undefined || query === null ? {} : record(query, "query");
  rejectUnknown(input, ["limit", "cursor"], "query");
  const limit = optionalQueryLimit(input);
  const cursor = optionalQueryString(input, "cursor");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}


export function parsePublicationDistributionHistoryQuery(query: unknown): {
  readonly revisionId?: string;
  readonly routeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
} {
  const input = query === undefined || query === null ? {} : record(query, "query");
  rejectUnknown(input, ["revisionId", "routeId", "limit", "cursor"], "query");
  const revisionId = optionalQueryString(input, "revisionId");
  const routeId = optionalQueryString(input, "routeId");
  const limit = optionalQueryLimit(input);
  const cursor = optionalQueryString(input, "cursor");
  return {
    ...(revisionId === undefined ? {} : { revisionId }),
    ...(routeId === undefined ? {} : { routeId }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
