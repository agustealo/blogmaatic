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
  SourceRevisionRestoreBody,
  SourcePublishingStateBody,
  SourceTaxonomyCreateBody,
  SourceTaxonomyQuery,
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

function parseQuery(request: FastifyRequest): SourceContentQuery {
  const input = query(request);
  const allowed = new Set(["search", "status", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const search = optionalString(input, "search");
  const status = optionalString(input, "status");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
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
  const allowed = new Set(["kind", "name", "slug", "description"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);

  const kind = input.kind;
  if (kind !== "category" && kind !== "tag") {
    throw new OperatorRequestError("kind must be category or tag");
  }
  const name = input.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new OperatorRequestError("name is required");
  }
  if (name.trim().length > 200) {
    throw new OperatorRequestError("name must not exceed 200 characters");
  }
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
    kind,
    name: name.trim(),
    ...(typeof slug === "string" ? { slug: slug.trim() } : {}),
    ...(typeof description === "string" ? { description: description.trim() } : {}),
  };
}

function parseTaxonomyQuery(request: FastifyRequest): SourceTaxonomyQuery {
  const input = query(request);
  const allowed = new Set(["kind", "search", "page", "limit"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new OperatorRequestError(`query contains unknown field: ${unknown}`);
  const kind = optionalString(input, "kind");
  if (kind !== "category" && kind !== "tag") {
    throw new OperatorRequestError("kind must be category or tag");
  }
  const search = optionalString(input, "search");
  const page = optionalInteger(input, "page", 1, 1000000);
  const limit = optionalInteger(input, "limit", 1, 100);
  return {
    kind,
    ...(search ? { search } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
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
  const unknown = Object.keys(input).find((key) => key !== "groupId" && key !== "routeId");
  if (unknown) throw new OperatorRequestError(`request body contains unknown field: ${unknown}`);
  const groupId = input.groupId;
  const routeId = input.routeId;
  if (typeof groupId !== "string" || !groupId.trim()) {
    throw new OperatorRequestError("groupId is required");
  }
  if (typeof routeId !== "string" || !routeId.trim()) {
    throw new OperatorRequestError("routeId is required");
  }
  return { groupId: groupId.trim(), routeId: routeId.trim() };
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

  app.post("/v1/connections/:connectionId/taxonomy", async (request, reply) => {
    const principal = await authorize(options, request, "source-content:write");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    const body = parseTaxonomyCreateBody(request.body);
    const result = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "source-taxonomy.create",
      resource: { type: "source-taxonomy", id: `${connectionId}:${body.kind}:${body.slug ?? body.name}` },
      evidence: {
        connectionId,
        kind: body.kind,
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
    ));
  });

  app.get("/v1/connections/:connectionId/content/:remoteId/revisions", async (request) => {
    await authorize(options, request, "source-content:read");
    const values = params(request);
    return {
      items: await domainCall(() => manager(options).revisions(
        requirePathString(values.connectionId, "connectionId"),
        requirePathString(values.remoteId, "remoteId"),
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
      evidence: { connectionId, remoteId, groupId: body.groupId, routeId: body.routeId },
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
      evidence: { connectionId, remoteId },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).trash(connectionId, remoteId)),
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
      evidence: { connectionId, remoteId },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).restore(connectionId, remoteId)),
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
      evidence: { connectionId, remoteId, permanent: true },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).deletePermanent(connectionId, remoteId)),
    });
  });
}
