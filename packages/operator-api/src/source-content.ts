import type { FastifyInstance, FastifyRequest } from "fastify";

import { auditedMutation } from "./audit.js";
import type { OperatorPermission } from "./auth.js";
import type {
  OperatorApiOptions,
  OperatorSourceContentManager,
  SourceAssetAttachBody,
  SourceAssetQuery,
  SourceContentImportBody,
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
