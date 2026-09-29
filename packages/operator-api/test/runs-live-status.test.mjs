import assert from "node:assert/strict";
import test from "node:test";

import { listOperatorRuns } from "../dist/runs.js";

const storedRun = {
  runId: "run-visible-default",
  request: {},
  triggerEvidence: {},
  dispatchState: "started",
  runtimeId: "runtime:run-visible-default",
  createdAt: "2026-09-29T11:00:00.000Z",
  updatedAt: "2026-09-29T11:00:01.000Z",
};

test("default run listing reconciles live runtime phase before returning visible rows", async () => {
  const listCalls = [];
  const phaseUpdates = [];
  const statusCalls = [];
  const store = {
    async listRuns(query) {
      listCalls.push(query);
      return { items: [storedRun], nextCursor: "opaque-next" };
    },
    async updateRunPhase(runId, phase, updatedAt) {
      phaseUpdates.push({ runId, phase, updatedAt });
    },
  };
  const runtime = {
    async status(runId) {
      statusCalls.push(runId);
      return {
        runId,
        phase: "completed",
        updatedAt: "2026-09-29T11:00:05.000Z",
      };
    },
  };

  const page = await listOperatorRuns(store, runtime, { limit: 30 });

  assert.deepEqual(listCalls, [{ limit: 30 }]);
  assert.deepEqual(statusCalls, [storedRun.runId]);
  assert.deepEqual(phaseUpdates, [{
    runId: storedRun.runId,
    phase: "completed",
    updatedAt: "2026-09-29T11:00:05.000Z",
  }]);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].runtimePhase, "completed");
  assert.equal(page.items[0].updatedAt, "2026-09-29T11:00:05.000Z");
  assert.equal(page.nextCursor, "opaque-next");
});

test("default run listing preserves durable rows when live runtime status fails", async () => {
  const phaseUpdates = [];
  const store = {
    async listRuns() {
      return { items: [storedRun], nextCursor: "opaque-next" };
    },
    async updateRunPhase(runId, phase, updatedAt) {
      phaseUpdates.push({ runId, phase, updatedAt });
    },
  };
  const runtime = {
    async status() {
      throw new Error("Restate unavailable");
    },
  };

  const page = await listOperatorRuns(store, runtime, { limit: 30 });

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0], storedRun);
  assert.equal(page.nextCursor, "opaque-next");
  assert.deepEqual(phaseUpdates, []);
});

test("non-started rows remain store truth and do not probe runtime status", async () => {
  let statusCalls = 0;
  const prepared = { ...storedRun, runId: "run-prepared", dispatchState: "prepared" };
  const store = {
    async listRuns() {
      return { items: [prepared] };
    },
    async updateRunPhase() {
      throw new Error("prepared run must not update live phase");
    },
  };
  const runtime = {
    async status() {
      statusCalls += 1;
      return null;
    },
  };

  const page = await listOperatorRuns(store, runtime);
  assert.equal(statusCalls, 0);
  assert.equal(page.items[0], prepared);
});
