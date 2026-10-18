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

function tags(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.tags;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new OperatorRequestError("tags must be an array of non-empty strings");
  }
  return value as readonly string[];
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
  rejectUnknown(input, ["title", "body", "bodyFormat", "summary", "language", "tags", "slug", "canonicalUrl", "status"], "request body");
  const parsedTags = tags(input);
  const parsedStatus = status(input);
  const bodyValue = optionalString(input, "body");
  const parsedBodyFormat = bodyFormat(input);
  if (parsedBodyFormat !== undefined && bodyValue === undefined) {
    throw new OperatorRequestError("bodyFormat requires body");
  }
  const summary = optionalString(input, "summary");
  const language = optionalString(input, "language");
  const slug = optionalString(input, "slug");
  const canonicalUrl = optionalString(input, "canonicalUrl");
  return {
    title: requiredString(input, "title"),
    ...(bodyValue === undefined ? {} : { body: bodyValue }),
    ...(parsedBodyFormat === undefined ? {} : { bodyFormat: parsedBodyFormat }),
    ...(summary === undefined ? {} : { summary }),
    ...(language === undefined ? {} : { language }),
    ...(parsedTags === undefined ? {} : { tags: parsedTags }),
    ...(slug === undefined ? {} : { slug }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
  };
}

export function parsePublicationWorkspaceUpdateBody(body: unknown): PublicationWorkspaceUpdateBody {
  const input = record(body, "request body");
  rejectUnknown(input, ["expectedVersion", "title", "body", "bodyFormat", "summary", "language", "tags", "slug", "canonicalUrl", "status"], "request body");
  const title = optionalString(input, "title");
  const bodyValue = optionalString(input, "body");
  const parsedBodyFormat = bodyFormat(input);
  if (parsedBodyFormat !== undefined && bodyValue === undefined) {
    throw new OperatorRequestError("bodyFormat requires body");
  }
  const summary = optionalString(input, "summary");
  const language = optionalString(input, "language");
  const parsedTags = tags(input);
  const slug = optionalString(input, "slug");
  const canonicalUrl = optionalString(input, "canonicalUrl");
  const parsedStatus = status(input);
  return {
    expectedVersion: expectedVersion(input),
    ...(title === undefined ? {} : { title }),
    ...(bodyValue === undefined ? {} : { body: bodyValue }),
    ...(parsedBodyFormat === undefined ? {} : { bodyFormat: parsedBodyFormat }),
    ...(summary === undefined ? {} : { summary }),
    ...(language === undefined ? {} : { language }),
    ...(parsedTags === undefined ? {} : { tags: parsedTags }),
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

export function parsePublicationWorkspaceListQuery(query: unknown): { readonly limit?: number; readonly cursor?: string; readonly status?: WorkspacePublicationStatus } {
  const input = query === undefined || query === null ? {} : record(query, "query");
  rejectUnknown(input, ["limit", "cursor", "status"], "query");
  const limit = optionalQueryLimit(input);
  const cursor = optionalQueryString(input, "cursor");
  const parsedStatus = status(input);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
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
