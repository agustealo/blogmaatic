import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutomationControlPlane,
  SqliteControlPlaneStore,
} from "@blogmaatic/control-plane";

import {
  StaticBearerAuthorizer,
  createOperatorApi,
} from "../dist/index.js";

const publication = {
  id: "pub-operator-api",
  createdAt: "2026-09-22T21:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-1",
    ordinal: 1,
    createdAt: "2026-09-22T21:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Operator API",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Operate the real control plane." } }],
      assets: [],
      tags: ["operator-api"],
      attributes: {},
    },
  },
  provenance: {},
};

const group = {
  id: "distribution",
  name: "Distribution",
  policySetId: "default",
  routes: [{
    id: "route-1",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "contract.publisher",
      connectionId: "connection-1",
      channel: "primary",
    },
    requiredCapabilities: ["article.create", "article.inspect"],
  }],
};

const TOKENS = {
  operator: "operator-main-0123456789-abcdefghijklmnopqrstuvwxyz",
  operator2: "operator-second-0123456789-abcdefghijklmnopqrstuvwxyz",
  reviewer: "reviewer-editor-0123456789-abcdefghijklmnopqrstuvwxyz",
  outsider: "reviewer-outsider-0123456789-abcdefghijklmnopqrstuvwxyz",
  sourceA: "integration-a-0123456789-abcdefghijklmnopqrstuvwxyz",
  sourceB: "integration-b-0123456789-abcdefghijklmnopqrstuvwxyz",
};

class RecordingRuntime {
  starts = [];
  approvals = [];
  statuses = new Map();
  results = new Map();
  statusError = null;

  async start(request) {
    this.starts.push(request);
    const approval = request.definition.steps.find((step) => step.kind === "approval");
    this.statuses.set(request.runId, {
      runId: request.runId,
      automationId: request.definition.id,
      automationVersion: request.definition.version,
      publicationId: request.publication.id,
      revisionId: request.publication.current.id,
      phase: approval ? "waiting_approval" : "running",
      completedStepIds: [],
      ...(approval ? {
        currentStepId: approval.id,
        expectedApproval: {
          stepId: approval.id,
          role: approval.role,
          revisionId: request.publication.current.id,
        },
      } : {}),
      updatedAt: "2026-09-22T21:30:00.000Z",
    });
    return { runtimeId: `runtime:${request.runId}` };
  }

  async status(runId) {
    if (this.statusError) throw this.statusError;
    return this.statuses.get(runId) ?? null;
  }

  async approve(approval) {
    const status = this.statuses.get(approval.runId);
    if (!status?.expectedApproval) return { accepted: false, reason: "No approval expected" };
    if (
      status.expectedApproval.stepId !== approval.stepId ||
      status.expectedApproval.revisionId !== approval.revisionId ||
      status.expectedApproval.role !== approval.role
    ) {
      return { accepted: false, reason: "Approval does not match expected evidence" };
    }
    this.approvals.push(approval);
    this.statuses.set(approval.runId, {
      ...status,
      phase: approval.decision === "approve" ? "completed" : "rejected",
      completedStepIds: [approval.stepId],
      currentStepId: undefined,
      expectedApproval: undefined,
      updatedAt: approval.decidedAt,
    });
    const result = {
      runId: approval.runId,
      automationId: status.automationId,
      publicationId: status.publicationId,
      revisionId: status.revisionId,
      outcome: approval.decision === "approve" ? "completed" : "rejected",
      stepResults: [{
        stepId: approval.stepId,
        kind: "approval",
        outcome: approval.decision === "approve" ? "approved" : "rejected",
        approval,
      }],
      completedAt: approval.decidedAt,
    };
    this.results.set(approval.runId, result);
    return { accepted: true };
  }

  async result(runId) {
    const result = this.results.get(runId);
    if (!result) throw new Error("Run has no terminal result");
    return result;
  }
}

function authorizer() {
  return new StaticBearerAuthorizer([
    {
      id: "operator-1",
      token: TOKENS.operator,
      permissions: ["automations:read", "automations:write", "runs:read", "runs:write", "schedules:read", "schedules:write", "schedules:dispatch"],
      roles: ["publisher"],
    },
    {
      id: "operator-2",
      token: TOKENS.operator2,
      permissions: ["runs:read", "runs:write"],
      roles: ["publisher"],
    },
    {
      id: "reviewer-1",
      token: TOKENS.reviewer,
      permissions: ["approvals:write", "runs:read"],
      roles: ["editor"],
    },
    {
      id: "reviewer-outsider",
      token: TOKENS.outsider,
      permissions: ["approvals:write"],
      roles: ["legal"],
    },
    {
      id: "integration-a",
      kind: "integration",
      source: "wordpress-primary",
      token: TOKENS.sourceA,
      permissions: ["events:ingest"],
    },
    {
      id: "integration-b",
      kind: "integration",
      source: "wordpress-secondary",
      token: TOKENS.sourceB,
      permissions: ["events:ingest"],
    },
  ]);
}

async function withApi(fn, apiOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-operator-api-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const runtime = new RecordingRuntime();
  const clock = { now: () => "2026-09-22T21:30:00.000Z" };
  const controlPlane = new AutomationControlPlane({ store, launcher: runtime, clock });
  const app = createOperatorApi({
    controlPlane,
    store,
    runtime,
    authorizer: authorizer(),
    clock,
    ...apiOptions,
  });
  try {
    await fn({ app, store, runtime, controlPlane, clock });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function register(app, definition) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/automations",
    headers: bearer(TOKENS.operator),
    payload: definition,
  });
  assert.equal(response.statusCode, 201, response.body);
}

test("health is public while operator resources fail closed without bearer authority", async () => {
  await withApi(async ({ app }) => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["cache-control"], "no-store");

    const denied = await app.inject({ method: "GET", url: "/v1/automations/anything" });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers["www-authenticate"], "Bearer");
    assert.equal(denied.json().error.code, "UNAUTHORIZED");
  });
});

test("manual-run and approval audit identities are derived from authenticated principals", async () => {
  await withApi(async ({ app, runtime }) => {
    const definition = {
      id: "editorial-release",
      version: 1,
      name: "Editorial release",
      enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "editor-approval", kind: "approval", role: "editor", prompt: "Approve release" }],
    };
    await register(app, definition);

    const manualPayload = {
      automationId: definition.id,
      publication,
      groups: [group],
      initiatedBy: "spoofed-client-value",
    };
    const manual = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: {
        ...bearer(TOKENS.operator),
        "idempotency-key": "manual-release-1",
      },
      payload: manualPayload,
    });
    assert.equal(manual.statusCode, 202);
    const run = manual.json();
    assert.equal(run.request.trigger.initiatedBy, "operator-1");
    assert.match(run.request.trigger.commandId, /^api_[0-9a-f]{40}$/);
    assert.notEqual(run.request.trigger.commandId, "manual-release-1");
    assert.equal(runtime.starts.length, 1);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: {
        ...bearer(TOKENS.operator),
        "idempotency-key": "manual-release-1",
      },
      payload: manualPayload,
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().runId, run.runId);
    assert.equal(runtime.starts.length, 1);

    const otherPrincipal = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: {
        ...bearer(TOKENS.operator2),
        "idempotency-key": "manual-release-1",
      },
      payload: manualPayload,
    });
    assert.equal(otherPrincipal.statusCode, 202);
    assert.notEqual(otherPrincipal.json().runId, run.runId);
    assert.equal(otherPrincipal.json().request.trigger.initiatedBy, "operator-2");
    assert.equal(runtime.starts.length, 2);

    const wrongRole = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.runId}/approvals`,
      headers: bearer(TOKENS.outsider),
      payload: { decision: "approve", approvedBy: "spoofed" },
    });
    assert.equal(wrongRole.statusCode, 403);

    const approval = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.runId}/approvals`,
      headers: bearer(TOKENS.reviewer),
      payload: { decision: "approve", approvedBy: "spoofed", role: "owner" },
    });
    assert.equal(approval.statusCode, 202);
    const accepted = approval.json();
    assert.equal(accepted.approval.approvedBy, "reviewer-1");
    assert.equal(accepted.approval.role, "editor");
    assert.equal(accepted.approval.revisionId, publication.current.id);
    assert.equal(runtime.approvals.length, 1);

    const result = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.runId}/result`,
      headers: bearer(TOKENS.operator),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().stepResults[0].approval.approvedBy, "reviewer-1");
  });
});

test("event source identity comes from the integration credential and prevents cross-source deduplication", async () => {
  await withApi(async ({ app, runtime }) => {
    const definition = {
      id: "approved-event",
      version: 1,
      name: "Approved event",
      enabled: true,
      trigger: { kind: "event", eventType: "publication.approved" },
      steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    };
    await register(app, definition);

    const payload = {
      id: "provider-event-42",
      type: "publication.approved",
      source: "spoofed-source",
      occurredAt: "2026-09-22T21:29:00.000Z",
      publication,
      groups: [group],
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: bearer(TOKENS.sourceA),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: bearer(TOKENS.sourceB),
      payload,
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.equal(runtime.starts.length, 2);
    assert.notEqual(first.json().runs[0].runId, second.json().runs[0].runId);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: bearer(TOKENS.sourceA),
      payload,
    });
    assert.equal(replay.statusCode, 202);
    assert.equal(replay.json().runs[0].runId, first.json().runs[0].runId);
    assert.equal(runtime.starts.length, 2);
  });
});

test("incomplete publication and group snapshots are rejected before durable launch", async () => {
  await withApi(async ({ app, runtime }) => {
    const definition = {
      id: "snapshot-validation",
      version: 1,
      name: "Snapshot validation",
      enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "approval", kind: "approval", role: "editor" }],
    };
    await register(app, definition);

    const invalidPublication = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: { ...bearer(TOKENS.operator), "idempotency-key": "invalid-publication" },
      payload: {
        automationId: definition.id,
        publication: { id: publication.id, current: { id: publication.current.id } },
        groups: [group],
      },
    });
    assert.equal(invalidPublication.statusCode, 400);
    assert.equal(invalidPublication.json().error.code, "INVALID_REQUEST");

    const invalidGroup = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: { ...bearer(TOKENS.operator), "idempotency-key": "invalid-group" },
      payload: {
        automationId: definition.id,
        publication,
        groups: [{ id: group.id }],
      },
    });
    assert.equal(invalidGroup.statusCode, 400);
    assert.equal(invalidGroup.json().error.code, "INVALID_REQUEST");
    assert.equal(runtime.starts.length, 0);
  });
});

test("Fastify parser errors preserve client status codes", async () => {
  await withApi(async ({ app }) => {
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: {
        ...bearer(TOKENS.operator),
        "content-type": "application/json",
      },
      payload: '{"automationId":',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, "INVALID_REQUEST");
  });

  await withApi(async ({ app }) => {
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: bearer(TOKENS.operator),
      payload: { padding: "x".repeat(2048) },
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, "PAYLOAD_TOO_LARGE");
  }, { bodyLimit: 1024 });
});

test("run inspection maps durable runtime transport failures to opaque 503", async () => {
  await withApi(async ({ app, runtime }) => {
    const definition = {
      id: "runtime-outage",
      version: 1,
      name: "Runtime outage",
      enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "pause", kind: "delay", durationMs: 1 }],
    };
    await register(app, definition);
    const started = await app.inject({
      method: "POST",
      url: "/v1/runs/manual",
      headers: { ...bearer(TOKENS.operator), "idempotency-key": "runtime-outage-1" },
      payload: { automationId: definition.id, publication, groups: [group] },
    });
    assert.equal(started.statusCode, 202);

    runtime.statusError = new Error("internal Restate endpoint http://secret-runtime:8080 unavailable");
    const inspection = await app.inject({
      method: "GET",
      url: `/v1/runs/${started.json().runId}`,
      headers: bearer(TOKENS.operator),
    });
    assert.equal(inspection.statusCode, 503);
    assert.equal(inspection.json().error.code, "RUNTIME_UNAVAILABLE");
    assert.equal(inspection.body.includes("secret-runtime"), false);
  });
});

test("schedule replacement is rejected while the current fire is actively leased", async () => {
  await withApi(async ({ app, store }) => {
    const definition = {
      id: "scheduled-release",
      version: 1,
      name: "Scheduled release",
      enabled: true,
      trigger: { kind: "schedule", scheduleId: "morning-release" },
      steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    };
    await register(app, definition);

    const schedulePayload = {
      id: "morning-release",
      automationId: definition.id,
      automationVersion: 1,
      publication,
      groups: [group],
      timezone: "UTC",
      localDate: "2026-09-22",
      localTime: "21:00",
      recurrence: { kind: "once" },
      missedRunPolicy: "catch_up_once",
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: bearer(TOKENS.operator),
      payload: schedulePayload,
    });
    assert.equal(created.statusCode, 201, created.body);

    const claims = await store.claimDueSchedules(
      "2026-09-22T21:30:00Z",
      "2026-09-22T21:35:00Z",
      1,
    );
    assert.equal(claims.length, 1);

    const replacement = await app.inject({
      method: "POST",
      url: "/v1/schedules",
      headers: bearer(TOKENS.operator),
      payload: { ...schedulePayload, localTime: "22:00" },
    });
    assert.equal(replacement.statusCode, 422);
    assert.equal(replacement.json().error.code, "DOMAIN_REJECTED");

    const unchanged = await store.getSchedule(schedulePayload.id);
    assert.equal(unchanged.localTime, "21:00");
    await store.releaseScheduleClaim(schedulePayload.id, claims[0].token, "2026-09-22T21:30:00Z");
  });
});
