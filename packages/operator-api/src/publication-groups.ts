import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { auditedMutation } from "./audit.js";
import type { OperatorPermission, OperatorPrincipal } from "./auth.js";
import {
  parsePublicationDistributionHistoryQuery,
  parsePublicationWorkspaceCreateBody,
  parsePublicationWorkspaceDispatchBody,
  parsePublicationWorkspaceListQuery,
  parsePublicationWorkspaceUpdateBody,
  parsePublicationWorkspaceVersionListQuery,
} from "./publication-workspace-validation.js";
import {
  parsePublicationGroupActivationBody,
  parsePublicationGroupCreateBody,
  parsePublicationGroupListQuery,
  parsePublicationGroupUpdateBody,
  parsePublicationGroupVersionListQuery,
} from "./publication-group-validation.js";
import type {
  OperatorApiOptions,
  OperatorDistributionHistory,
  OperatorPublicationGroupManager,
  OperatorPublicationWorkspaceManager,
} from "./types.js";
import { requirePathString, requirePathVersion } from "./validation.js";

export class PublicationGroupApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicationGroupApiError";
  }
}

function params(request: FastifyRequest): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

function query(request: FastifyRequest): unknown {
  return request.query;
}

function manager(options: OperatorApiOptions): OperatorPublicationGroupManager {
  if (!options.publicationGroups) {
    throw new PublicationGroupApiError(
      503,
      "PUBLICATION_GROUP_MANAGEMENT_UNAVAILABLE",
      "Publication group management is unavailable",
    );
  }
  return options.publicationGroups;
}

function distributionManager(options: OperatorApiOptions): OperatorDistributionHistory {
  if (!options.distributions) {
    throw new PublicationGroupApiError(
      503,
      "PUBLICATION_DISTRIBUTION_HISTORY_UNAVAILABLE",
      "Publication distribution history is unavailable",
    );
  }
  return options.distributions;
}

function publicationManager(options: OperatorApiOptions): OperatorPublicationWorkspaceManager {
  if (!options.publications) {
    throw new PublicationGroupApiError(
      503,
      "PUBLICATION_WORKSPACE_UNAVAILABLE",
      "Publication Workspace is unavailable",
    );
  }
  return options.publications;
}

async function authorize(
  options: OperatorApiOptions,
  request: FastifyRequest,
  permission: Extract<OperatorPermission,
    | "publication-groups:read"
    | "publication-groups:write"
    | "publications:read"
    | "publications:write"
    | "publications:publish"
  >,
): Promise<OperatorPrincipal> {
  return options.authorizer.authorize(request.headers.authorization, permission);
}

async function domainCall<T>(
  fn: () => Promise<T>,
  conflictCode = "PUBLICATION_GROUP_VERSION_CONFLICT",
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PublicationGroupApiError) throw error;
    const message = error instanceof Error ? error.message : "Publication operation was rejected";
    if (/changed from version \d+ to \d+/.test(message)) {
      throw new PublicationGroupApiError(409, conflictCode, message);
    }
    throw new PublicationGroupApiError(422, "DOMAIN_REJECTED", message);
  }
}

function publicationDomainCall<T>(fn: () => Promise<T>): Promise<T> {
  return domainCall(fn, "PUBLICATION_VERSION_CONFLICT");
}

async function currentOr404(groupManager: OperatorPublicationGroupManager, groupId: string) {
  const entry = await domainCall(() => groupManager.get(groupId));
  if (!entry) {
    throw new PublicationGroupApiError(404, "PUBLICATION_GROUP_NOT_FOUND", "Publication group was not found");
  }
  return entry;
}

async function publicationOr404(publications: OperatorPublicationWorkspaceManager, publicationId: string) {
  const entry = await publicationDomainCall(() => publications.get(publicationId));
  if (!entry) {
    throw new PublicationGroupApiError(404, "PUBLICATION_NOT_FOUND", "Publication was not found");
  }
  return entry;
}

function registerPublicationWorkspaceRoutes(app: FastifyInstance, options: OperatorApiOptions): void {
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  app.get("/v1/publications", async (request) => {
    await authorize(options, request, "publications:read");
    return publicationDomainCall(() => publicationManager(options).list(parsePublicationWorkspaceListQuery(query(request))));
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
      execute: () => publicationDomainCall(() => publicationManager(options).create(body)),
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
    return publicationOr404(publicationManager(options), publicationId);
  });

  app.get("/v1/publications/:publicationId/distributions", async (request) => {
    await authorize(options, request, "publications:read");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    await publicationOr404(publicationManager(options), publicationId);
    return publicationDomainCall(() => distributionManager(options).list(
      publicationId,
      parsePublicationDistributionHistoryQuery(query(request)),
    ));
  });

  app.get("/v1/publications/:publicationId/versions", async (request) => {
    await authorize(options, request, "publications:read");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    const publications = publicationManager(options);
    await publicationOr404(publications, publicationId);
    return publicationDomainCall(() => publications.listVersions(
      publicationId,
      parsePublicationWorkspaceVersionListQuery(query(request)),
    ));
  });

  app.get("/v1/publications/:publicationId/versions/:version", async (request) => {
    await authorize(options, request, "publications:read");
    const routeParams = params(request);
    const publicationId = requirePathString(routeParams.publicationId, "publicationId");
    const version = requirePathVersion(routeParams.version);
    const entry = await publicationDomainCall(() => publicationManager(options).getVersion(publicationId, version));
    if (!entry) {
      throw new PublicationGroupApiError(404, "PUBLICATION_VERSION_NOT_FOUND", "Publication version was not found");
    }
    return entry;
  });

  app.patch("/v1/publications/:publicationId", async (request) => {
    const principal = await authorize(options, request, "publications:write");
    const publicationId = requirePathString(params(request).publicationId, "publicationId");
    const publications = publicationManager(options);
    const current = await publicationOr404(publications, publicationId);
    const body = parsePublicationWorkspaceUpdateBody(request.body);
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication.update",
      resource: { type: "publication", id: publicationId },
      evidence: { expectedVersion: body.expectedVersion, currentVersion: current.version },
      now: () => clock.now(),
      execute: () => publicationDomainCall(() => publications.update(publicationId, body)),
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
    const publications = publicationManager(options);
    const current = await publicationOr404(publications, publicationId);
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
      execute: () => publicationDomainCall(() => publications.approveAndDispatch(publicationId, body.expectedVersion)),
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

export function registerPublicationGroupRoutes(app: FastifyInstance, options: OperatorApiOptions): void {
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  app.get("/v1/publication-group-options", async (request) => {
    await authorize(options, request, "publication-groups:read");
    return { policySetIds: manager(options).listPolicySetIds() };
  });

  app.get("/v1/publication-groups", async (request) => {
    await authorize(options, request, "publication-groups:read");
    return domainCall(() => manager(options).list(parsePublicationGroupListQuery(query(request))));
  });

  app.post("/v1/publication-groups", async (request, reply) => {
    const principal = await authorize(options, request, "publication-groups:write");
    const groupManager = manager(options);
    const body = parsePublicationGroupCreateBody(request.body);
    const groupId = `group_${randomUUID()}`;
    const created = await auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication-group.create",
      resource: { type: "publication-group", id: groupId },
      evidence: {
        enabled: body.enabled ?? true,
        routeCount: body.routes.length,
        connectionIds: [...new Set(body.routes.map((route) => route.destination.connectionId))].sort(),
      },
      now: () => clock.now(),
      execute: () => domainCall(() => groupManager.create({
        group: {
          id: groupId,
          name: body.name,
          policySetId: body.policySetId,
          routes: body.routes,
        },
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      })),
      success: (result) => ({ evidence: { version: result.version, enabled: result.enabled } }),
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/publication-groups/:groupId", async (request) => {
    await authorize(options, request, "publication-groups:read");
    const groupId = requirePathString(params(request).groupId, "groupId");
    return currentOr404(manager(options), groupId);
  });

  app.get("/v1/publication-groups/:groupId/versions", async (request) => {
    await authorize(options, request, "publication-groups:read");
    const groupId = requirePathString(params(request).groupId, "groupId");
    await currentOr404(manager(options), groupId);
    return domainCall(() => manager(options).listVersions(
      groupId,
      parsePublicationGroupVersionListQuery(query(request)),
    ));
  });

  app.get("/v1/publication-groups/:groupId/versions/:version", async (request) => {
    await authorize(options, request, "publication-groups:read");
    const routeParams = params(request);
    const groupId = requirePathString(routeParams.groupId, "groupId");
    const version = requirePathVersion(routeParams.version);
    const stored = await domainCall(() => manager(options).getVersion(groupId, version));
    if (!stored) {
      throw new PublicationGroupApiError(
        404,
        "PUBLICATION_GROUP_VERSION_NOT_FOUND",
        "Publication group version was not found",
      );
    }
    return stored;
  });

  app.patch("/v1/publication-groups/:groupId", async (request) => {
    const principal = await authorize(options, request, "publication-groups:write");
    const groupManager = manager(options);
    const groupId = requirePathString(params(request).groupId, "groupId");
    const current = await currentOr404(groupManager, groupId);
    const body = parsePublicationGroupUpdateBody(request.body);
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication-group.update",
      resource: { type: "publication-group", id: groupId },
      evidence: {
        expectedVersion: body.expectedVersion,
        currentVersion: current.version,
        enabled: body.enabled ?? current.enabled,
        routeCount: body.routes.length,
        connectionIds: [...new Set(body.routes.map((route) => route.destination.connectionId))].sort(),
      },
      now: () => clock.now(),
      execute: () => domainCall(() => groupManager.update({
        group: {
          id: groupId,
          name: body.name,
          policySetId: body.policySetId,
          routes: body.routes,
        },
        expectedVersion: body.expectedVersion,
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      })),
      success: (result) => ({ evidence: { version: result.version, enabled: result.enabled } }),
    });
  });

  app.post("/v1/publication-groups/:groupId/activation", async (request) => {
    const principal = await authorize(options, request, "publication-groups:write");
    const groupManager = manager(options);
    const groupId = requirePathString(params(request).groupId, "groupId");
    await currentOr404(groupManager, groupId);
    const body = parsePublicationGroupActivationBody(request.body);
    return auditedMutation({
      store: options.store,
      principal,
      requestId: request.id,
      action: "publication-group.activate",
      resource: { type: "publication-group", id: groupId },
      evidence: { expectedVersion: body.expectedVersion, enabled: body.enabled },
      now: () => clock.now(),
      execute: () => domainCall(() => groupManager.setEnabled(
        groupId,
        body.expectedVersion,
        body.enabled,
      )),
    });
  });

  registerPublicationWorkspaceRoutes(app, options);
}
