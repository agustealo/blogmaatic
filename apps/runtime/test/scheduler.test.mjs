import assert from "node:assert/strict";
import test from "node:test";

import { SchedulerLoop } from "../dist/scheduler.js";

test("scheduler close waits for an active dispatch before returning", async () => {
  let releaseDispatch;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseDispatch = resolve; });
  let calls = 0;

  const controlPlane = {
    async dispatchDueSchedules() {
      calls += 1;
      markStarted();
      await release;
      return [];
    },
  };

  const scheduler = new SchedulerLoop({
    controlPlane,
    pollMs: 1000,
    batchSize: 10,
  });
  scheduler.start();
  await started;

  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "close must wait while dispatch is still active");

  releaseDispatch();
  await closing;
  assert.equal(closed, true);
  assert.equal(calls, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "closing must prevent a follow-up timer from dispatching again");
});
