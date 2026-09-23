import assert from "node:assert/strict";
import test from "node:test";

import { listOperatorOperations } from "../dist/index.js";

function run(id, createdAt) {
  return {
    runId: id,
    triggerKey: `trigger:${id}`,
    request: {
      runId: id,
      definition: {
        id: "publish",
        version: 1,
        name: "Publish",
        enabled: true,
        trigger: { kind: "manual" },
        steps: [{ id: "publish", kind: "publish_group", groupId: "group" }],
      },
      trigger: { kind: "manual", commandId: id, initiatedBy: "operator", occurredAt: createdAt },
      publication: {
        id: "pub",
        createdAt,
        status: "approved",
        current: {
          id: "rev",
          ordinal: 1,
          createdAt,
          content: { schemaVersion: 1, title: "Post", language: "en", blocks: [], assets: [], tags: [], attributes: {} },
        },
        provenance: {},
      },
      groups: [],
    },
    dispatchState: "started",
    runtimeId: `runtime:${id}`,
    createdAt,
    updatedAt: createdAt,
  };
}

const runs = [
  run("run-newer", "2026-09-22T23:00:02.000Z"),
  run("run-older", "2026-09-22T23:00:01.000Z"),
];

const store = {
  async listRuns(query = {}) {
    let start = 0;
    if (query.cursor) {
      const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      const runId = parsed.values[1];
      start = runs.findIndex((item) => item.runId === runId) + 1;
    }
    return { items: runs.slice(start) };
  },
  async getRun(runId) {
    return runs.find((item) => item.runId === runId);
  },
  async updateRunPhase() {},
};

const runtime = {
  async status(runId) {
    return {
      runId,
      automationId: "publish",
      automationVersion: 1,
      publicationId: "pub",
      revisionId: "rev",
      phase: "completed",
      completedStepIds: ["publish"],
      updatedAt: "2026-09-22T23:05:00.000Z",
    };
  },
  async result(runId) {
    const routes = runId === "run-newer" ? ["a", "b", "c"] : ["d"];
    return {
      runId,
      automationId: "publish",
      publicationId: "pub",
      revisionId: "rev",
      outcome: "completed",
      stepResults: [{
        stepId: "publish",
        kind: "publish_group",
        groupId: "group",
        outcome: "business_failure",
        receipts: routes.map((routeId) => ({
          publicationId: "pub",
          revisionId: "rev",
          groupId: "group",
          routeId,
          projectionId: `pub:${routeId}`,
          status: "drifted",
          policy: { effect: "allow", reason: "Allowed" },
          observed: { state: "drifted", observedAt: "2026-09-22T23:05:00.000Z" },
          completedAt: "2026-09-22T23:05:00.000Z",
        })),
      }],
      completedAt: "2026-09-22T23:05:00.000Z",
    };
  },
};

test("operations pagination resumes inside a run and honors the requested result limit", async () => {
  const first = await listOperatorOperations(store, runtime, { kind: "delivery_drifted", limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.items.map((item) => item.routeId), ["a", "b"]);

  const second = await listOperatorOperations(store, runtime, {
    kind: "delivery_drifted",
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.items.map((item) => item.routeId), ["c", "d"]);
  assert.equal(second.nextCursor, undefined);
});
