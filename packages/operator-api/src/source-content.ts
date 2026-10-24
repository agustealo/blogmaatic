import type { FastifyInstance, FastifyRequest } from "fastify";

import { auditedMutation } from "./audit.js";
import type { OperatorPermission } from "./auth.js";
import type {
  OperatorApiOptions,
  OperatorSourceContentManager,
  SourceAssetAttachBody,
  SourceAssetQuery,
  SourceAssetUploadInput,
  SourceAuthorAssignBody,
  SourceAuthorQuery,
  SourceContentImportBody,
  SourceEditorialOptionsBody,
  SourceRevisionRestoreBody,
  SourcePublishingStateBody,
  SourcePageStructureBody,
  SourceTaxonomyCreateBody,
  SourceTaxonomyQuery,
  SourceTaxonomySelectionBody,
  SourceContentQuery,
} from "./types.js";
import { OperatorRequestError, requirePathString } from "./validation.js";

export class SourceContentApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceContentApiError";
  }
}

function params(request: FastifyRequest): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

function query(request: FastifyRequest): Record<string, unknown> {
  const value = request.query;
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorRequestError("query must be an object");
  }
  return value as Record<string, unknown>;
}

function manager(options: OperatorApiOptions): OperatorSourceContentManager {
  if (!options.sourceContent) {
    throw new SourceContentApiError(
      503,
      "SOURCE_CONTENT_UNAVAILABLE",
      "Source content management is unavailable",
    );
  }
  return options.sourceContent;
}

async function domainCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SourceContentApiError || error instanceof OperatorRequestError) throw error;
    throw new SourceContentApiError(
      422,
      "SOURCE_CONTENT_REJECTED",
      error instanceof Error ? error.message : "Source content operation was rejected",
    );
  }
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new OperatorRequestError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new OperatorRequestError(`${key} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new OperatorRequestError(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function optionalContentType(value: unknown, label = "contentType"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new OperatorRequestError(`${label} must be a string`);
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new OperatorRequestError(`${label} must contain only lowercase letters, numbers, underscores, or hyphens`);
  }
  return normalized;
}

function contentTypeFromQuery(request: FastifyRequest): string | undefined {
  return optionalContentType(query(request).contentType);
}

function parseQuery(request: FastifyRequest): SourceContentQuery {
  const input = query(request);
  const allowed = new Set(["contentType", "search", "status", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const contentType = optionalContentType(input.contentType);
  const search = optionalString(input, "search");
  const status = optionalString(input, "status");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
    ...(contentType ? { contentType } : {}),
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseAuthorQuery(request: FastifyRequest): SourceAuthorQuery {
  const input = query(request);
  const allowed = new Set(["search", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const search = optionalString(input, "search");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
    ...(search ? { search } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseAuthorAssignBody(body: unknown): SourceAuthorAssignBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["publicationId", "expectedVersion"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const publicationId = input.publicationId;
  if (typeof publicationId !== "string" || !publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  return {
    publicationId: publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
  };
}

function parseAssetQuery(request: FastifyRequest): SourceAssetQuery {
  const input = query(request);
  const allowed = new Set(["search", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const search = optionalString(input, "search");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
    ...(search ? { search } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseTaxonomyCreateBody(body: unknown): SourceTaxonomyCreateBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["kind", "taxonomyKey", "contentType", "name", "slug", "description"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);

  const kind = input.kind;
  if (kind !== undefined && kind !== "category" && kind !== "tag" && kind !== "custom") {
    throw new OperatorRequestError("kind must be category, tag, or custom");
  }
  const taxonomyKey = optionalString(input, "taxonomyKey");
  const contentType = optionalContentType(input.contentType);
  if (taxonomyKey) {
    if (!contentType) throw new OperatorRequestError("contentType is required with taxonomyKey");
  } else if (kind !== "category" && kind !== "tag") {
    throw new OperatorRequestError("category or tag kind is required when taxonomyKey is omitted");
  }

  const name = input.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new OperatorRequestError("name is required");
  }
  if (name.trim().length > 200) throw new OperatorRequestError("name must not exceed 200 characters");
  const slug = input.slug;
  if (slug !== undefined && (typeof slug !== "string" || !slug.trim())) {
    throw new OperatorRequestError("slug must be a non-empty string when provided");
  }
  if (typeof slug === "string" && slug.trim().length > 200) {
    throw new OperatorRequestError("slug must not exceed 200 characters");
  }
  const description = input.description;
  if (description !== undefined && typeof description !== "string") {
    throw new OperatorRequestError("description must be a string when provided");
  }
  if (typeof description === "string" && description.length > 2000) {
    throw new OperatorRequestError("description must not exceed 2000 characters");
  }
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(taxonomyKey ? { taxonomyKey } : {}),
    ...(contentType ? { contentType } : {}),
    name: name.trim(),
    ...(typeof slug === "string" ? { slug: slug.trim() } : {}),
    ...(typeof description === "string" ? { description: description.trim() } : {}),
  };
}

function parseTaxonomyQuery(request: FastifyRequest): SourceTaxonomyQuery {
  const input = query(request);
  const allowed = new Set(["kind", "taxonomyKey", "contentType", "search", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const kind = optionalString(input, "kind");
  if (kind !== undefined && kind !== "category" && kind !== "tag" && kind !== "custom") {
    throw new OperatorRequestError("kind must be category, tag, or custom");
  }
  const taxonomyKey = optionalString(input, "taxonomyKey");
  const contentType = optionalContentType(input.contentType);
  if (taxonomyKey) {
    if (!contentType) throw new OperatorRequestError("contentType is required with taxonomyKey");
  } else if (kind !== "category" && kind !== "tag") {
    throw new OperatorRequestError("category or tag kind is required when taxonomyKey is omitted");
  }
  const search = optionalString(input, "search");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(taxonomyKey ? { taxonomyKey } : {}),
    ...(contentType ? { contentType } : {}),
    ...(search ? { search } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseTaxonomySelectionBody(body: unknown): SourceTaxonomySelectionBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["publicationId", "expectedVersion", "contentType", "selections"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  if (typeof input.publicationId !== "string" || !input.publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  const contentType = optionalContentType(input.contentType);
  if (!contentType) throw new OperatorRequestError("contentType is required");
  if (input.selections === null || typeof input.selections !== "object" || Array.isArray(input.selections)) {
    throw new OperatorRequestError("selections must be an object");
  }
  const selections: Record<string, readonly string[]> = {};
  for (const [rawKey, rawNames] of Object.entries(input.selections as Record<string, unknown>)) {
    const taxonomyKey = rawKey.trim();
    if (!taxonomyKey) throw new OperatorRequestError("taxonomy selection key must be non-empty");
    if (!Array.isArray(rawNames) || rawNames.some((name) => typeof name !== "string")) {
      throw new OperatorRequestError(`taxonomy selection ${taxonomyKey} must be an array of strings`);
    }
    const names = [...new Set((rawNames as string[]).map((name) => name.trim()).filter(Boolean))];
    if (names.length > 200) throw new OperatorRequestError(`taxonomy selection ${taxonomyKey} is too large`);
    selections[taxonomyKey] = names;
  }
  return {
    publicationId: input.publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
    contentType,
    selections,
  };
}

const SOURCE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function boundedOptionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = optionalString(input, key);
  if (value && value.length > maxLength) {
    throw new OperatorRequestError(`${key} must not exceed ${maxLength} characters`);
  }
  return value;
}

function parseAssetUpload(request: FastifyRequest): SourceAssetUploadInput {
  const input = query(request);
  const allowed = new Set(["publicationId", "expectedVersion", "featured", "filename", "alt", "title"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);

  const publicationId = optionalString(input, "publicationId");
  if (!publicationId) throw new OperatorRequestError("publicationId is required");
  const expectedVersion = optionalInteger(input, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === undefined) throw new OperatorRequestError("expectedVersion is required");
  const filename = boundedOptionalString(input, "filename", 180);
  if (!filename) throw new OperatorRequestError("filename is required");
  if (/[\\/\u0000-\u001f\u007f]/u.test(filename) || filename === "." || filename === "..") {
    throw new OperatorRequestError("filename must be a simple file name without path separators or control characters");
  }

  const featuredRaw = input.featured;
  let featured: boolean | undefined;
  if (featuredRaw !== undefined) {
    if (featuredRaw === "true") featured = true;
    else if (featuredRaw === "false") featured = false;
    else throw new OperatorRequestError("featured must be true or false");
  }

  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") throw new OperatorRequestError("Content-Type is required");
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!SOURCE_IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new OperatorRequestError("Content-Type must be image/jpeg, image/png, or image/webp");
  }

  const body = request.body;
  if (!(body instanceof Uint8Array) || body.byteLength === 0) {
    throw new OperatorRequestError("Image upload body is required");
  }

  const alt = boundedOptionalString(input, "alt", 500);
  const title = boundedOptionalString(input, "title", 500);
  return {
    publicationId,
    expectedVersion,
    filename,
    mediaType,
    bytes: new Uint8Array(body),
    ...(featured === undefined ? {} : { featured }),
    ...(alt === undefined ? {} : { alt }),
    ...(title === undefined ? {} : { title }),
  };
}

function parseAssetAttachBody(body: unknown): SourceAssetAttachBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["publicationId", "expectedVersion", "featured"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const publicationId = input.publicationId;
  if (typeof publicationId !== "string" || !publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  if (input.featured !== undefined && typeof input.featured !== "boolean") {
    throw new OperatorRequestError("featured must be a boolean");
  }
  return {
    publicationId: publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
    ...(typeof input.featured === "boolean" ? { featured: input.featured } : {}),
  };
}

function parseRevisionRestoreBody(body: unknown): SourceRevisionRestoreBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["contentType", "publicationId", "expectedVersion"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const contentType = optionalContentType(input.contentType);
  const publicationId = input.publicationId;
  if (typeof publicationId !== "string" || !publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  return {
    ...(contentType ? { contentType } : {}),
    publicationId: publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
  };
}

function parsePageStructureBody(body: unknown): SourcePageStructureBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set([
    "publicationId",
    "expectedVersion",
    "contentType",
    "parentRemoteId",
    "template",
    "menuOrder",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);

  const publicationId = input.publicationId;
  if (typeof publicationId !== "string" || !publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  const contentType = optionalContentType(input.contentType);
  if (!contentType) throw new OperatorRequestError("contentType is required");

  const parentRemoteId = input.parentRemoteId;
  if (
    parentRemoteId !== null &&
    (typeof parentRemoteId !== "string" || !/^\d+$/.test(parentRemoteId.trim()))
  ) {
    throw new OperatorRequestError("parentRemoteId must be null or a positive integer string");
  }
  const template = input.template;
  if (template !== null && typeof template !== "string") {
    throw new OperatorRequestError("template must be null or a string");
  }
  if (typeof template === "string" && template.length > 500) {
    throw new OperatorRequestError("template must not exceed 500 characters");
  }
  if (!Number.isSafeInteger(input.menuOrder) || (input.menuOrder as number) < 0) {
    throw new OperatorRequestError("menuOrder must be a non-negative integer");
  }

  return {
    publicationId: publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
    contentType,
    parentRemoteId: parentRemoteId === null ? null : (parentRemoteId as string).trim(),
    template: template === null ? null : (template as string).trim() || null,
    menuOrder: input.menuOrder as number,
  };
}

function parseEditorialOptionsBody(body: unknown): SourceEditorialOptionsBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set([
    "publicationId", "expectedVersion", "contentType", "password",
    "commentStatus", "pingStatus", "sticky", "format",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  if (typeof input.publicationId !== "string" || !input.publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  if (typeof input.contentType !== "string" || !input.contentType.trim()) {
    throw new OperatorRequestError("contentType is required");
  }
  if (typeof input.password !== "string") throw new OperatorRequestError("password must be a string");
  if (input.password.length > 255) throw new OperatorRequestError("password must not exceed 255 characters");
  if (input.commentStatus !== undefined && input.commentStatus !== "open" && input.commentStatus !== "closed") {
    throw new OperatorRequestError("commentStatus must be open or closed");
  }
  if (input.pingStatus !== undefined && input.pingStatus !== "open" && input.pingStatus !== "closed") {
    throw new OperatorRequestError("pingStatus must be open or closed");
  }
  if (input.sticky !== undefined && typeof input.sticky !== "boolean") {
    throw new OperatorRequestError("sticky must be a boolean");
  }
  const formats = new Set(["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"]);
  if (input.format !== undefined && (typeof input.format !== "string" || !formats.has(input.format))) {
    throw new OperatorRequestError("format is not a supported WordPress post format");
  }
  if (input.sticky === true && input.password.length > 0) {
    throw new OperatorRequestError("sticky posts cannot be password protected");
  }
  return {
    publicationId: input.publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
    contentType: input.contentType.trim(),
    password: input.password,
    ...(input.commentStatus === undefined ? {} : { commentStatus: input.commentStatus }),
    ...(input.pingStatus === undefined ? {} : { pingStatus: input.pingStatus }),
    ...(input.sticky === undefined ? {} : { sticky: input.sticky }),
    ...(input.format === undefined ? {} : { format: input.format }),
  };
}

function parsePublishingStateBody(body: unknown): SourcePublishingStateBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["publicationId", "expectedVersion", "status", "scheduledAt"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const publicationId = input.publicationId;
  if (typeof publicationId !== "string" || !publicationId.trim()) {
    throw new OperatorRequestError("publicationId is required");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new OperatorRequestError("expectedVersion must be a positive integer");
  }
  const status = input.status;
  if (typeof status !== "string" || !status.trim()) {
    throw new OperatorRequestError("status is required");
  }
  const scheduledAt = input.scheduledAt;
  if (scheduledAt !== undefined && (typeof scheduledAt !== "string" || !scheduledAt.trim())) {
    throw new OperatorRequestError("scheduledAt must be a non-empty string when provided");
  }
  return {
    publicationId: publicationId.trim(),
    expectedVersion: input.expectedVersion as number,
    status: status.trim(),
    ...(typeof scheduledAt === "string" ? { scheduledAt: scheduledAt.trim() } : {}),
  };
}

function parseImportBody(body: unknown): SourceContentImportBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["contentType", "groupId", "routeId"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const contentType = optionalContentType(input.contentType);
  const groupId = input.groupId;
  const routeId = input.routeId;
  if (typeof groupId !== "string" || !groupId.trim()) {
    throw new OperatorRequestError("groupId is required");
  }
  if (typeof routeId !== "string" || !routeId.trim()) {
    throw new OperatorRequestError("routeId is required");
  }
  return {
    ...(contentType ? { contentType } : {}),
    groupId: groupId.trim(),
    routeId: routeId.trim(),
  };
}

async function authorize(
  options: OperatorApiOptions,
  request: FastifyRequest,
  permission: Extract<OperatorPermission, "source-content:read" | "source-content:write">,
) {
  return options.authorizer.authorize(request.headers.authorization, permission);
}

export function registerSourceContentRoutes(app: FastifyInstance, options: OperatorApiOptions): void {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post("/v1/connections/:connectionId/page-structure", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parsePageStructureBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-page-structure.update",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
        contentType: body.contentType,
        parentRemoteId: body.parentRemoteId,
        template: body.template,
        menuOrder: body.menuOrder,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).setPageStructure(connectionId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          contentType: value.contentType,
          parentRemoteId: value.parentRemoteId,
          template: value.template,
          menuOrder: value.menuOrder,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/editorial-options", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parseEditorialOptionsBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-editorial-options.update",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
        contentType: body.contentType,
        passwordProtected: body.password.length > 0,
        commentStatus: body.commentStatus ?? null,
        pingStatus: body.pingStatus ?? null,
        sticky: body.sticky ?? null,
        format: body.format ?? null,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).setEditorialOptions(connectionId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          passwordProtected: value.passwordProtected,
          commentStatus: value.commentStatus ?? null,
          pingStatus: value.pingStatus ?? null,
          sticky: value.sticky ?? null,
          format: value.format ?? null,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/publishing-state", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parsePublishingStateBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-publishing-state.update",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
        status: body.status,
        scheduledAt: body.scheduledAt ?? null,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).setPublishingState(connectionId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          status: value.status,
          scheduledAt: value.scheduledAt ?? null,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/connections/:connectionId/authors", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return domainCall(() => manager(options).listAuthors(connectionId, parseAuthorQuery(request)));
  });

  app.post("/v1/connections/:connectionId/authors/:remoteId/assign", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    const body = parseAuthorAssignBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-author.assign",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        remoteId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).assignAuthor(connectionId, remoteId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          authorRemoteId: value.author.remoteId,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/connections/:connectionId/taxonomies", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const input = query(request);
    const unknown = Object.keys(input).find((key) => key !== "contentType");
    if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
    const contentType = optionalContentType(input.contentType);
    if (!contentType) throw new OperatorRequestError("contentType is required");
    return { items: await domainCall(() => manager(options).listTaxonomyDefinitions(connectionId, contentType)) };
  });

  app.post("/v1/connections/:connectionId/taxonomy-selections", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parseTaxonomySelectionBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-taxonomy.selection.update",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
        contentType: body.contentType,
        taxonomyKeys: Object.keys(body.selections).sort(),
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).setTaxonomySelections(connectionId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          taxonomyKeys: Object.keys(value.selections).sort(),
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/taxonomy", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parseTaxonomyCreateBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-taxonomy.create",
      resource: { type: "source-taxonomy", id: `${connectionId}:${body.taxonomyKey ?? body.kind ?? "taxonomy"}:${body.slug ?? body.name}` },
      evidence: {
        connectionId,
        kind: body.kind ?? null,
        taxonomyKey: body.taxonomyKey ?? null,
        contentType: body.contentType ?? null,
        name: body.name,
        requestedSlug: body.slug ?? null,
        descriptionPresent: Boolean(body.description),
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).createTaxonomy(connectionId, body)),
      success: (value) => ({
        evidence: {
          remoteId: value.remoteId,
          name: value.name,
          slug: value.slug,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/connections/:connectionId/taxonomy", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return domainCall(() => manager(options).listTaxonomy(connectionId, parseTaxonomyQuery(request)));
  });

  app.get("/v1/connections/:connectionId/assets", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return domainCall(() => manager(options).listAssets(connectionId, parseAssetQuery(request)));
  });

  app.post("/v1/connections/:connectionId/assets/upload", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const input = parseAssetUpload(request);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-asset.upload",
      resource: { type: "publication", id: input.publicationId },
      evidence: {
        connectionId,
        publicationId: input.publicationId,
        expectedVersion: input.expectedVersion,
        featured: input.featured ?? false,
        filename: input.filename,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).uploadAsset(connectionId, input)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          assetRemoteId: value.asset.remoteId,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/assets/:remoteId/attach", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    const body = parseAssetAttachBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-asset.attach",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        remoteId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
        featured: body.featured ?? false,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).attachAsset(connectionId, remoteId, body)),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          assetRemoteId: value.asset.remoteId,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/connections/:connectionId/content-types", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return { items: await domainCall(() => manager(options).listContentTypes(connectionId)) };
  });

  app.get("/v1/connections/:connectionId/content", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return domainCall(() => manager(options).list(connectionId, parseQuery(request)));
  });

  app.get("/v1/connections/:connectionId/content/:remoteId", async (request) => {
    await authorize(options, request, "source-content:read");
    const values = params(request);
    return domainCall(() => manager(options).get(
      requirePathString(values.connectionId, "connectionId"),
      requirePathString(values.remoteId, "remoteId"),
      contentTypeFromQuery(request),
    ));
  });

  app.get("/v1/connections/:connectionId/content/:remoteId/revisions", async (request) => {
    await authorize(options, request, "source-content:read");
    const values = params(request);
    return {
      items: await domainCall(() => manager(options).revisions(
        requirePathString(values.connectionId, "connectionId"),
        requirePathString(values.remoteId, "remoteId"),
        contentTypeFromQuery(request),
      )),
    };
  });

  app.post("/v1/connections/:connectionId/content/:remoteId/revisions/:revisionId/restore", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    const revisionId = requirePathString(values.revisionId, "revisionId");
    const body = parseRevisionRestoreBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-content.revision.restore",
      resource: { type: "publication", id: body.publicationId },
      evidence: {
        connectionId,
        remoteId,
        remoteRevisionId: revisionId,
        publicationId: body.publicationId,
        expectedVersion: body.expectedVersion,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).restoreRevision(
        connectionId,
        remoteId,
        revisionId,
        body,
      )),
      success: (value) => ({
        evidence: {
          revisionId: value.publication.publication.current.id,
          version: value.publication.version,
          restoredRemoteRevisionId: value.revision.remoteRevisionId,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/content/:remoteId/import", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    const body = parseImportBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-content.import",
      resource: { type: "source-content", id: `${connectionId}:${remoteId}` },
      evidence: {
        connectionId,
        remoteId,
        contentType: body.contentType ?? null,
        groupId: body.groupId,
        routeId: body.routeId,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).import(connectionId, remoteId, body)),
      success: (value) => ({
        evidence: {
          publicationId: value.publication.publication.id,
          revisionId: value.publication.publication.current.id,
        },
      }),
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/connections/:connectionId/content/:remoteId/trash", async (request) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-content.trash",
      resource: { type: "source-content", id: `${connectionId}:${remoteId}` },
      evidence: { connectionId, remoteId, contentType: contentTypeFromQuery(request) ?? null },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).trash(
        connectionId,
        remoteId,
        contentTypeFromQuery(request),
      )),
    });
  });

  app.post("/v1/connections/:connectionId/content/:remoteId/restore", async (request) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-content.restore",
      resource: { type: "source-content", id: `${connectionId}:${remoteId}` },
      evidence: { connectionId, remoteId, contentType: contentTypeFromQuery(request) ?? null },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).restore(
        connectionId,
        remoteId,
        contentTypeFromQuery(request),
      )),
    });
  });

  app.post("/v1/connections/:connectionId/content/:remoteId/delete-permanently", async (request) => {
    const principal = await authorize(options, request, "source-content:write");
    const values = params(request);
    const connectionId = requirePathString(values.connectionId, "connectionId");
    const remoteId = requirePathString(values.remoteId, "remoteId");
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-content.delete-permanently",
      resource: { type: "source-content", id: `${connectionId}:${remoteId}` },
      evidence: {
        connectionId,
        remoteId,
        contentType: contentTypeFromQuery(request) ?? null,
        permanent: true,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).deletePermanent(
        connectionId,
        remoteId,
        contentTypeFromQuery(request),
      )),
    });
  });
}
