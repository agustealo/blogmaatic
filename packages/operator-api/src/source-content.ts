import type { FastifyInstance, FastifyRequest } from "fastify";

import { auditedMutation } from "./audit.js";
import type { OperatorPermission } from "./auth.js";
import type {
  OperatorApiOptions,
  OperatorSourceContentManager,
  SourceContentImportBody,
  SourceContentQuery,
} from "./types.js";
import { OperatorRequestError, requirePathString } from "./validation.js";

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
  if (!options.sourceContent) throw new Error("Source content management is unavailable");
  return options.sourceContent;
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

  app.get("/v1/connections/:connectionId/content", async (request) => {
    await authorize(options, request, "source-content:read");
    const connectionId = requirePathString(params(request).connectionId, "connectionId");
    return manager(options).list(connectionId, parseQuery(request));
  });

  app.get("/v1/connections/:connectionId/content/:remoteId", async (request) => {
    await authorize(options, request, "source-content:read");
    const values = params(request);
    return manager(options).get(
      requirePathString(values.connectionId, "connectionId"),
      requirePathString(values.remoteId, "remoteId"),
    );
  });

  app.get("/v1/connections/:connectionId/content/:remoteId/revisions", async (request) => {
    await authorize(options, request, "source-content:read");
    const values = params(request);
    return {
      items: await manager(options).revisions(
        requirePathString(values.connectionId, "connectionId"),
        requirePathString(values.remoteId, "remoteId"),
      ),
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
      execute: () => manager(options).import(connectionId, remoteId, body),
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
      execute: () => manager(options).trash(connectionId, remoteId),
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
      execute: () => manager(options).restore(connectionId, remoteId),
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
      execute: () => manager(options).deletePermanent(connectionId, remoteId),
    });
  });
}
