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
  id: "pub-query-audit",
  createdAt: "2026-09-22T22:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-1",
    ordinal: 1,
    createdAt: "2026-09-22T22:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Query and audit",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Observable control plane." } }],
      assets: [],
      tags: ["query"],
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

const TOKEN = "operator-query-audit-0123456789-abcdefghijklmnopqrstuvwxyz";

class QueryRuntime {
  starts = [];
  statuses = new Map();
  results = new Map();

  async start(request) {
    this.starts.push(request);
    const approval = request.definition.steps.find((step) => step.kind === "approval");
    const publish = request.definition.steps.find((step) => step.kind === "publish_group");
    if (approval) {
      this.statuses.set(request.runId, {
        runId: request.runId,
        automationId: request.definition.id,
        automationVersion: request.definition.version,
        publicationId: request.publication.id,
        revisionId: request.publication.current.id,
        phase: "waiting_approval",
        completedStepIds: [],
        currentStepId: approval.id,
        expectedApproval: {
          stepId: approval.id,
          role: approval.role,
          revisionId: request.publication.current.id,
        },
        updatedAt: "2026-09-22T22:30:00.000Z",
      });
    } else {
      this.statuses.set(request.runId, {
        runId: request.runId,
        automationId: request.definition.id,
        automationVersion: request.definition.version,
        publicationId: request.publication.id,
        revisionId: request.publication.current.id,
        phase: "completed",
        completedStepIds: publish ? [publish.id] : [],
        updatedAt: "2026-09-22T22:30:00.000Z",
      });
      this.results.set(request.runId, {
        runId: request.runId,
        automationId: request.definition.id,
        publicationId: request.publication.id,
        revisionId: request.publication.current.id,
        outcome: "completed",
        stepResults: publish ? [{
          stepId: publish.id,
          kind: "publish_group",
          groupId: publish.groupId,
          outcome: "business_failure",
          receipts: [{
            publicationId: request.publication.id,
            revisionId: request.publication.current.id,
            groupId: publish.groupId,
            routeId: "route-1",
            projectionId: `${request.publication.id}:route-1`,
            status: "drifted",
            policy: { effect: "allow", reason: "Allowed" },
            observed: {
              state: "drifted",
              observedAt: "2026-09-22T22:30:00.000Z",
              detail: "Remote post changed outside Blogmaatic",
            },
            completedAt: "2026-09-22T22:30:00.000Z",
          }],
        }] : [],
        completedAt: "2026-09-22T22:30:00.000Z",
      });
    }
    return { runtimeId: `runtime:${request.runId}` };
  }

  async status(runId) {
    return this.statuses.get(runId) ?? null;
  }

  async approve() {
    return { accepted: true };
  }

  async result(runId) {
    const result = this.results.get(runId);
    if (!result) throw new Error("Result unavailable");
    return result;
  }
}

function authorizer() {
  return new StaticBearerAuthorizer([{
    id: "operator-query",
    token: TOKEN,
    permissions: [
      "automations:read",
      "automations:write",
      "runs:read",
      "runs:write",
      "schedules:read",
      "schedules:write",
      "operations:read",
      "audit:read",
    ],
    roles: ["editor"],
  }]);
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-query-audit-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const runtime = new QueryRuntime();
  let tick = 0;
  const clock = {
    now: () => new Date(Date.parse("2026-09-22T22:30:00.000Z") + tick++).toISOString(),
  };
  const controlPlane = new AutomationControlPlane({ store, launcher: runtime, clock });
  const app = createOperatorApi({
    controlPlane,
    store,
    runtime,
    authorizer: authorizer(),
    clock,
  });
  try {
    await fn({ app, store, runtime });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function register(app, definition) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/automations",
    headers: bearer(),
    payload: definition,
  });
  assert.equal(response.statusCode, 201, response.body);
}

async function manual(app, automationId, key) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/runs/manual",
    headers: { ...bearer(), "idempotency-key": key },
    payload: { automationId, publication, groups: [group] },
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json();
}

test("operator lists automations and versions with opaque stable cursors", async () => {
  await withApi(async ({ app }) => {
    await register(app, {
      id: "alpha", version: 1, name: "Alpha v1", enabled: true,
      trigger: { kind: "manual" }, steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    });
    await register(app, {
      id: "alpha", version: 2, name: "Alpha v2", enabled: true,
      trigger: { kind: "manual" }, steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    });
    await register(app, {
      id: "beta", version: 1, name: "Beta", enabled: false,
      trigger: { kind: "manual" }, steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    });

    const first = await app.inject({ method: "GET", url: "/v1/automations?limit=1", headers: bearer() });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().items.length, 1);
    assert.equal(first.json().items[0].definition.id, "alpha");
    assert.ok(first.json().nextCursor);

    const second = await app.inject({
      method: "GET",
      url: `/v1/automations?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: bearer(),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().items[0].definition.id, "beta");

    const versions = await app.inject({ method: "GET", url: "/v1/automations/alpha/versions", headers: bearer() });
    assert.equal(versions.statusCode, 200);
    assert.deepEqual(versions.json().items.map((entry) => entry.definition.version), [2, 1]);

    const badCursor = await app.inject({ method: "GET", url: "/v1/automations?cursor=not-a-cursor", headers: bearer() });
    assert.equal(badCursor.statusCode, 400);
    assert.equal(badCursor.json().error.code, "INVALID_REQUEST");
  });
});

test("run queries and operations expose current approval and delivery drift truth", async () => {
  await withApi(async ({ app }) => {
    await register(app, {
      id: "needs-review", version: 1, name: "Needs review", enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "approval", kind: "approval", role: "editor" }],
    });
    await register(app, {
      id: "drift-release", version: 1, name: "Drift release", enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    });
    const approvalRun = await manual(app, "needs-review", "approval-1");
    const driftRun = await manual(app, "drift-release", "drift-1");

    const phaseFiltered = await app.inject({
      method: "GET",
      url: "/v1/runs?runtimePhase=waiting_approval",
      headers: bearer(),
    });
    assert.equal(phaseFiltered.statusCode, 200, phaseFiltered.body);
    assert.equal(phaseFiltered.json().items.length, 1);
    assert.equal(phaseFiltered.json().items[0].runId, approvalRun.runId);
    assert.equal(phaseFiltered.json().items[0].runtimePhase, "waiting_approval");

    const filtered = await app.inject({
      method: "GET",
      url: `/v1/runs?automationId=needs-review&publicationId=${publication.id}`,
      headers: bearer(),
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().items.length, 1);
    assert.equal(filtered.json().items[0].runId, approvalRun.runId);

    const approvals = await app.inject({
      method: "GET",
      url: "/v1/operations?kind=approval_required",
      headers: bearer(),
    });
    assert.equal(approvals.statusCode, 200, approvals.body);
    assert.equal(approvals.json().items.length, 1);
    assert.equal(approvals.json().items[0].runId, approvalRun.runId);
    assert.equal(approvals.json().items[0].evidence.role, "editor");

    const drift = await app.inject({
      method: "GET",
      url: "/v1/operations?kind=delivery_drifted",
      headers: bearer(),
    });
    assert.equal(drift.statusCode, 200, drift.body);
    assert.equal(drift.json().items.length, 1);
    assert.equal(drift.json().items[0].runId, driftRun.runId);
    assert.equal(drift.json().items[0].routeId, "route-1");
    assert.match(drift.json().items[0].detail, /changed outside Blogmaatic/);
  });
});

test("audit ledger records immutable intent and outcome with authenticated actor evidence", async () => {
  await withApi(async ({ app }) => {
    await register(app, {
      id: "audited-release", version: 1, name: "Audited release", enabled: true,
      trigger: { kind: "manual" },
      steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    });
    const run = await manual(app, "audited-release", "audit-run-1");

    const audit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=run.start.manual",
      headers: bearer(),
    });
    assert.equal(audit.statusCode, 200, audit.body);
    const entries = audit.json().items;
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    assert.equal(entries[0].actor.id, "operator-query");
    assert.equal(entries[1].actor.id, "operator-query");
    assert.equal(entries.find((entry) => entry.phase === "succeeded").runId, run.runId);
    assert.equal(entries[0].correlationId, entries[1].correlationId);

    const all = await app.inject({ method: "GET", url: "/v1/audit?limit=2", headers: bearer() });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().items.length, 2);
    assert.ok(all.json().nextCursor);
  });
});

test("failed authenticated mutation retains intent plus failed evidence without raw error text", async () => {
  await withApi(async ({ app }) => {
    const original = {
      id: "immutable", version: 1, name: "Immutable", enabled: true,
      trigger: { kind: "manual" }, steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    };
    await register(app, original);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/automations",
      headers: bearer(),
      payload: { ...original, name: "Mutated same version" },
    });
    assert.equal(conflict.statusCode, 422);

    const audit = await app.inject({
      method: "GET",
      url: "/v1/audit?action=automation.register&resourceId=immutable",
      headers: bearer(),
    });
    assert.equal(audit.statusCode, 200);
    const entries = audit.json().items;
    const failed = entries.find((entry) => entry.phase === "failed");
    assert.ok(failed);
    const failedPair = entries.filter((entry) => entry.correlationId === failed.correlationId);
    assert.deepEqual(new Set(failedPair.map((entry) => entry.phase)), new Set(["intent", "failed"]));
    assert.equal(failed.evidence.errorType, "OperatorApiError");
    assert.equal(JSON.stringify(failed).includes("immutable"), true);
    assert.equal(JSON.stringify(failed).includes("same version"), false);
  });
});
