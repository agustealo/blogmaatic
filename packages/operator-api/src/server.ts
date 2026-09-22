import { createHash } from "node:crypto";

import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { AutomationApproval, AutomationRunPhase } from "@blogmaatic/automation";
import {
  stableJson,
  type ManualAutomationCommand,
  type PublicationAutomationEvent,
} from "@blogmaatic/control-plane";

import {
  OperatorAuthError,
  type OperatorPermission,
  type OperatorPrincipal,
} from "./auth.js";
import type { ManualRunBody, OperatorApiListenOptions, OperatorApiOptions } from "./types.js";
import {
  OperatorRequestError,
  parseActivationBody,
  parseApprovalBody,
  parseAutomationRegistration,
  parseEventBody,
  parseManualRunBody,
  parseScheduleBody,
  parseScheduleDispatchBody,
  requireIdempotencyKey,
  requirePathString,
  requirePathVersion,
} from "./validation.js";

class OperatorApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorApiError";
  }
}

const terminalPhases = new Set<AutomationRunPhase>(["completed", "stopped", "rejected"]);
const systemClock = { now: () => new Date().toISOString() };

function params(request: FastifyRequest): Record<string, unknown> {
  return request.params as Record<string, unknown>;
}

function errorBody(request: FastifyRequest, code: string, message: string) {
  return { error: { code, message, requestId: request.id } };
}

function manualCommandId(principalId: string, idempotencyKey: string, body: ManualRunBody): string {
  const requestFingerprint = stableJson({
    automationId: body.automationId,
    automationVersion: body.automationVersion ?? null,
    publication: body.publication,
    groups: body.groups,
  });
  const digest = createHash("sha256")
    .update(stableJson([principalId, idempotencyKey, requestFingerprint]))
    .digest("hex");
  return `api_${digest.slice(0, 40)}`;
}

async function domainCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OperatorApiError || error instanceof OperatorRequestError || error instanceof OperatorAuthError) {
      throw error;
    }
    throw new OperatorApiError(422, "DOMAIN_REJECTED", "The requested operation was rejected");
  }
}

async function runtimeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new OperatorApiError(503, "RUNTIME_UNAVAILABLE", "The durable automation runtime is unavailable");
  }
}

export function createOperatorApi(options: OperatorApiOptions): FastifyInstance {
  const bodyLimit = options.bodyLimit ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1024 || bodyLimit > 10 * 1024 * 1024) {
    throw new Error("Operator API bodyLimit must be an integer from 1024 through 10485760 bytes");
  }
  const clock = options.clock ?? systemClock;
  const app = fastify({
    logger: options.logger ?? false,
    bodyLimit,
    trustProxy: false,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OperatorAuthError) {
      if (error.statusCode === 401) reply.header("www-authenticate", "Bearer");
      void reply.code(error.statusCode).send(errorBody(request, error.code, error.message));
      return;
    }
    if (error instanceof OperatorRequestError) {
      void reply.code(400).send(errorBody(request, "INVALID_REQUEST", error.message));
      return;
    }
    if (error instanceof OperatorApiError) {
      void reply.code(error.statusCode).send(errorBody(request, error.code, error.message));
      return;
    }
    const clientStatus = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : undefined;
    if (clientStatus !== undefined) {
      const code = clientStatus === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST";
      const message = clientStatus === 413
        ? "Request payload exceeds the configured limit"
        : "Request could not be parsed";
      void reply.code(clientStatus).send(errorBody(request, code, message));
      return;
    }
    request.log.error({ err: error }, "operator API request failed");
    void reply.code(500).send(errorBody(request, "INTERNAL_ERROR", "Internal server error"));
  });

  const authorize = async (request: FastifyRequest, permission: OperatorPermission): Promise<OperatorPrincipal> =>
    options.authorizer.authorize(request.headers.authorization, permission);

  app.get("/healthz", async () => ({
    status: "ok",
    service: "blogmaatic-operator-api",
  }));

  app.post("/v1/automations", async (request, reply) => {
    await authorize(request, "automations:write");
    const definition = parseAutomationRegistration(request.body);
    await domainCall(() => options.controlPlane.registerAutomation(definition));
    const stored = await options.store.getAutomationVersion(definition.id, definition.version);
    if (!stored) throw new OperatorApiError(500, "REGISTRY_INCONSISTENT", "Registered automation could not be read back");
    return reply.code(201).send(stored);
  });

  app.get("/v1/automations/:automationId", async (request) => {
    await authorize(request, "automations:read");
    const automationId = requirePathString(params(request).automationId, "automationId");
    const stored = await options.store.getActiveAutomation(automationId);
    if (!stored) throw new OperatorApiError(404, "AUTOMATION_NOT_FOUND", "Automation was not found");
    return stored;
  });

  app.get("/v1/automations/:automationId/versions/:version", async (request) => {
    await authorize(request, "automations:read");
    const routeParams = params(request);
    const automationId = requirePathString(routeParams.automationId, "automationId");
    const version = requirePathVersion(routeParams.version);
    const stored = await options.store.getAutomationVersion(automationId, version);
    if (!stored) throw new OperatorApiError(404, "AUTOMATION_VERSION_NOT_FOUND", "Automation version was not found");
    return stored;
  });

  app.post("/v1/automations/:automationId/versions/:version/activate", async (request) => {
    await authorize(request, "automations:write");
    const routeParams = params(request);
    const automationId = requirePathString(routeParams.automationId, "automationId");
    const version = requirePathVersion(routeParams.version);
    const body = parseActivationBody(request.body);
    await domainCall(() => options.controlPlane.activateAutomation(automationId, version, body.enabled));
    const stored = await options.store.getAutomationVersion(automationId, version);
    if (!stored) throw new OperatorApiError(500, "REGISTRY_INCONSISTENT", "Activated automation could not be read back");
    return stored;
  });

  app.post("/v1/events", async (request, reply) => {
    const principal = await authorize(request, "events:ingest");
    const body = parseEventBody(request.body);
    const event: PublicationAutomationEvent = {
      ...body,
      source: principal.source ?? principal.id,
    };
    const runs = await domainCall(() => options.controlPlane.routeEvent(event));
    return reply.code(202).send({ runs });
  });

  app.post("/v1/runs/manual", async (request, reply) => {
    const principal = await authorize(request, "runs:write");
    const body = parseManualRunBody(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    const command: ManualAutomationCommand = {
      id: manualCommandId(principal.id, idempotencyKey, body),
      automationId: body.automationId,
      ...(body.automationVersion === undefined ? {} : { automationVersion: body.automationVersion }),
      initiatedBy: principal.id,
      occurredAt: clock.now(),
      publication: body.publication,
      groups: body.groups,
    };
    const run = await domainCall(() => options.controlPlane.startManual(command));
    return reply.code(202).send(run);
  });

  app.get("/v1/runs/:runId", async (request) => {
    await authorize(request, "runs:read");
    const runId = requirePathString(params(request).runId, "runId");
    const run = await runtimeCall(() => options.controlPlane.inspectRun(runId));
    if (!run) throw new OperatorApiError(404, "RUN_NOT_FOUND", "Automation run was not found");
    return run;
  });

  app.post("/v1/runs/:runId/approvals", async (request, reply) => {
    const principal = await authorize(request, "approvals:write");
    const runId = requirePathString(params(request).runId, "runId");
    const body = parseApprovalBody(request.body);
    const run = await options.store.getRun(runId);
    if (!run) throw new OperatorApiError(404, "RUN_NOT_FOUND", "Automation run was not found");
    const status = await runtimeCall(() => options.runtime.status(runId));
    if (!status) throw new OperatorApiError(409, "RUNTIME_STATUS_MISSING", "Runtime status is not available for this run");
    if (status.phase !== "waiting_approval" || !status.expectedApproval) {
      throw new OperatorApiError(409, "APPROVAL_NOT_EXPECTED", "This run is not waiting for an approval");
    }
    const expected = status.expectedApproval;
    if (!principal.roles.includes("*") && !principal.roles.includes(expected.role)) {
      throw new OperatorAuthError(403, "FORBIDDEN", `Approval role ${expected.role} is required`);
    }
    const approval: AutomationApproval = {
      runId,
      stepId: expected.stepId,
      revisionId: expected.revisionId,
      role: expected.role,
      approvedBy: principal.id,
      decision: body.decision,
      decidedAt: clock.now(),
      ...(body.note === undefined ? {} : { note: body.note }),
    };
    const response = await runtimeCall(() => options.runtime.approve(approval));
    if (!response.accepted) {
      throw new OperatorApiError(409, "APPROVAL_REJECTED", response.reason ?? "The runtime rejected this approval");
    }
    return reply.code(202).send({ accepted: true, approval });
  });

  app.get("/v1/runs/:runId/result", async (request) => {
    await authorize(request, "runs:read");
    const runId = requirePathString(params(request).runId, "runId");
    const run = await options.store.getRun(runId);
    if (!run) throw new OperatorApiError(404, "RUN_NOT_FOUND", "Automation run was not found");
    const status = await runtimeCall(() => options.runtime.status(runId));
    if (!status) throw new OperatorApiError(409, "RUNTIME_STATUS_MISSING", "Runtime status is not available for this run");
    if (!terminalPhases.has(status.phase)) {
      throw new OperatorApiError(409, "RUN_NOT_TERMINAL", `Run is currently ${status.phase}`);
    }
    return runtimeCall(() => options.runtime.result(runId));
  });

  app.post("/v1/schedules", async (request, reply) => {
    await authorize(request, "schedules:write");
    const input = parseScheduleBody(request.body);
    const schedule = await domainCall(() => options.controlPlane.createSchedule(input));
    return reply.code(201).send(schedule);
  });

  app.get("/v1/schedules/:scheduleId", async (request) => {
    await authorize(request, "schedules:read");
    const scheduleId = requirePathString(params(request).scheduleId, "scheduleId");
    const schedule = await options.store.getSchedule(scheduleId);
    if (!schedule) throw new OperatorApiError(404, "SCHEDULE_NOT_FOUND", "Schedule was not found");
    return schedule;
  });

  app.post("/v1/scheduler/dispatch", async (request) => {
    await authorize(request, "schedules:dispatch");
    const body = parseScheduleDispatchBody(request.body);
    const results = await domainCall(() => options.controlPlane.dispatchDueSchedules(body));
    return { results };
  });

  return app;
}

export async function startOperatorApi(
  options: OperatorApiOptions,
  listen: OperatorApiListenOptions,
): Promise<{ readonly app: FastifyInstance; readonly address: string }> {
  if (!Number.isSafeInteger(listen.port) || listen.port < 1 || listen.port > 65535) {
    throw new Error("Operator API port must be an integer from 1 through 65535");
  }
  const app = createOperatorApi(options);
  const address = await app.listen({
    port: listen.port,
    host: listen.host ?? "127.0.0.1",
  });
  return { app, address };
}

export async function closeOperatorApi(app: FastifyInstance): Promise<void> {
  await app.close();
}

export type OperatorApiReply = FastifyReply;
