import type { FastifyInstance, FastifyRequest } from "fastify";

import { auditedMutation } from "./audit.js";
import type { OperatorPermission, OperatorPrincipal } from "./auth.js";
import {
  parsePublicationWorkspaceCreateBody,
  parsePublicationWorkspaceDispatchBody,
  parsePublicationWorkspaceListQuery,
  parsePublicationWorkspaceUpdateBody,
  parsePublicationWorkspaceVersionListQuery,
} from "./publication-workspace-validation.js";
import type { OperatorApiOptions, OperatorPublicationWorkspaceManager } from "./types.js";
import { requirePathString, requirePathVersion } from "./validation.js";

export class PublicationWorkspaceApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationWorkspaceApiError";
  }
}

function params(request: FastifyRequest): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

function manager(options: OperatorApiOptions): OperatorPublicationWorkspaceManager {
  if (!options.publications) {
    throw new PublicationWorkspaceApiError(503, "PUBLICATION_WORKSPACE_UNAVAILABLE", "Publication Workspace is unavailable");
  }
  return options.publications;
}

async function authorize(
  options: OperatorApiOptions,
  request: FastifyRequest,
  permission: Extract<OperatorPermission, "publications:read" | "publications:write" | "publications:publish">,
): Promise<OperatorPrincipal> {
  return options.authorizer.authorize(request.headers.authorization, permission);
}

async function domainCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PublicationWorkspaceApiError) throw error;
    const message = error instanceof Error ? error.message : "Publication Workspace operation was rejected";
    if (/changed from version \d+ to \d+/.test(message)) {
      throw new PublicationWorkspaceApiError(409, "PUBLICATION_VERSION_CONFLICT", message);
    }
    throw new PublicationWorkspaceApiError(422, "DOMAIN_REJECTED", message);
  }
}

async function currentOr404(publications: OperatorPublicationWorkspaceManager, publicationId: string) {
  const entry = await domainCall(() => publications.get(publicationId));
  if (!entry) throw new PublicationWorkspaceApiError(404, "PUBLICATION_NOT_FOUND", "Publication was not found");
  return entry;
}

export function registerPublicationWorkspaceRoutes(app: FastifyInstance, options: OperatorApiOptions): void {
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  app.get("/v1/publications", async (request) => {
    await authorize(options, request, "publications:read");
    return domainCall(() => manager(options).list(parsePublicationWorkspaceListQuery(request.query)));
  });

  app.post("/v1/publications", async (request, reply) => {
    const principal = await authorize(options, request, "publications:write");
    const body = parsePublicationWorkspaceCreateBody(request.body);
    const created = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication.create",
      resource: { type: "publication", id: `request:${request.id}` },
      evidence: { status: body.status ?? "draft", titleLength: body.title.trim().length },
      now: () => clock.now(),
      execute: () => domainCall(() => manager(options).create(body)),
      success: (result) => ({
        evidence: {
          publicationId: result.publication.id,
          revisionId: result.publication.current.id,
          version: result.version,
          status: result.publication.status,
        },
      }),
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/publications/:publicationId", async (request) => {
    await authorize(options, request, "publications:read");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    return currentOr404(manager(options), publicationId);
  });

  app.get("/v1/publications/:publicationId/versions", async (request) => {
    await authorize(options, request, "publications:read");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    await currentOr404(manager(options), publicationId);
    return domainCall(() => manager(options).listVersions(
      publicationId,
      parsePublicationWorkspaceVersionListQuery(request.query),
    ));
  });

  app.get("/v1/publications/:publicationId/versions/:version", async (request) => {
    await authorize(options, request, "publications:read");
    const routeParams = params(request);
    const publicationId = requirePathString(routeParams.publicationId, "publicationId");
    const version = requirePathVersion(routeParams.version);
    const entry = await domainCall(() => manager(options).getVersion(publicationId, version));
    if (!entry) throw new PublicationWorkspaceApiError(404, "PUBLICATION_VERSION_NOT_FOUND", "Publication version was not found");
    return entry;
  });

  app.patch("/v1/publications/:publicationId", async (request) => {
    const principal = await authorize(options, request, "publications:write");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    const publications = manager(options);
    const current = await currentOr404(publications, publicationId);
    const body = parsePublicationWorkspaceUpdateBody(request.body);
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication.update",
      resource: { type: "publication", id: publicationId },
      evidence: { expectedVersion: body.expectedVersion, currentVersion: current.version },
      now: () => clock.now(),
      execute: () => domainCall(() => publications.update(publicationId, body)),
      success: (result) => ({
        evidence: {
          revisionId: result.publication.current.id,
          version: result.version,
          status: result.publication.status,
        },
      }),
    });
  });

  app.post("/v1/publications/:publicationId/publish", async (request) => {
    const principal = await authorize(options, request, "publications:publish");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    const publications = manager(options);
    const current = await currentOr404(publications, publicationId);
    const body = parsePublicationWorkspaceDispatchBody(request.body);
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication.approve-and-dispatch",
      resource: { type: "publication", id: publicationId },
      evidence: {
        expectedVersion: body.expectedVersion,
        currentVersion: current.version,
        currentStatus: current.publication.status,
      },
      now: () => clock.now(),
      execute: () => domainCall(() => publications.approveAndDispatch(publicationId, body.expectedVersion)),
      success: (result) => ({
        evidence: {
          version: result.publication.version,
          revisionId: result.publication.publication.current.id,
          runCount: result.runs.length,
          runIds: result.runs.map((run) => run.runId),
        },
      }),
    });
  });
}
