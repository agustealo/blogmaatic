import assert from "node:assert/strict";
import test from "node:test";

import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "runs-live-route-0123456789-abcdefghijklmnopqrstuvwxyz";
const storedRun = {
  runId: "run-browser-visible",
  request: {
    definition: { id: "automation-event", version: 1, name: "Event", enabled: true, trigger: { kind: "event", eventType: "publication.approved" }, steps: [{ id: "publish", kind: "publish_group", groupId: "group-1" }] },
    trigger: { kind: "event", eventType: "publication.approved", eventId: "event-1", occurredAt: "2026-09-29T11:00:00.000Z" },
    publication: { id: "publication-1", createdAt: "2026-09-29T11:00:00.000Z", status: "approved", current: { id: "revision-1", ordinal: 1, createdAt: "2026-09-29T11:00:00.000Z", content: { schemaVersion: 1, title: "Browser visible", language: "en", blocks: [], assets: [], tags: [], attributes: {} } }, provenance: {} },
    groups: [],
    runId: "run-browser-visible",
  },
  triggerEvidence: { key: "evt-test", kind: "event", payload: {} },
  dispatchState: "started",
  runtimeId: "runtime-invocation",
  createdAt: "2026-09-29T11:00:00.000Z",
  updatedAt: "2026-09-29T11:00:01.000Z",
};

function authorizer() {
  return new StaticBearerAuthorizer([{
    id: "runs-reader",
    token: TOKEN,
    permissions: ["runs:read"],
    roles: [],
  }]);
}

test("GET /v1/runs without a phase filter returns reconciled live runtime state", async () => {
  const phaseUpdates = [];
  let statusCalls = 0;
  const store = {
    async listRuns(query) {
      assert.deepEqual(query, { limit: 30 });
      return { items: [storedRun] };
    },
    async updateRunPhase(runId, phase, updatedAt) {
      phaseUpdates.push({ runId, phase, updatedAt });
    },
  };
  const runtime = {
    async status(runId) {
      statusCalls += 1;
      assert.equal(runId, storedRun.runId);
      return { runId, phase: "completed", updatedAt: "2026-09-29T11:00:05.000Z" };
    },
  };
  const app = createOperatorApi({
    store,
    runtime,
    controlPlane: {},
    authorizer: authorizer(),
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs?limit=30",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json();
    assert.equal(statusCalls, 1);
    assert.equal(page.items[0].runtimePhase, "completed");
    assert.equal(page.items[0].updatedAt, "2026-09-29T11:00:05.000Z");
    assert.deepEqual(phaseUpdates, [{
      runId: storedRun.runId,
      phase: "completed",
      updatedAt: "2026-09-29T11:00:05.000Z",
    }]);
  } finally {
    await app.close();
  }
});
