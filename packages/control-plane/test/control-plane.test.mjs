import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutomationControlPlane,
  SqliteControlPlaneStore,
  createScheduleSnapshot,
  nextScheduleFireAfter,
} from "../dist/index.js";

const publication = {
  id: "pub-control-plane",
  createdAt: "2026-09-22T18:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-1",
    ordinal: 1,
    createdAt: "2026-09-22T18:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Control plane",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Ship once." } }],
      assets: [],
      tags: ["release"],
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

function eventAutomation(version = 1) {
  return {
    id: "on-approved",
    version,
    name: "Publish approved content",
    enabled: true,
    trigger: { kind: "event", eventType: "publication.approved" },
    conditions: { statuses: ["approved"] },
    steps: [{ id: "publish", kind: "publish_group", groupId: "distribution" }],
  };
}

function scheduleAutomation() {
  return {
    id: "scheduled-release",
    version: 1,
    name: "Scheduled release",
    enabled: true,
    trigger: { kind: "schedule", scheduleId: "morning-release" },
    steps: [{ id: "publish", kind: "publish_group", groupId: "distribution" }],
  };
}

class RecordingLauncher {
  calls = [];
  failCount = 0;
  statuses = new Map();

  async start(request) {
    this.calls.push(request.runId);
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error("runtime temporarily unavailable");
    }
    this.statuses.set(request.runId, {
      runId: request.runId,
      automationId: request.definition.id,
      automationVersion: request.definition.version,
      publicationId: request.publication.id,
      revisionId: request.publication.current.id,
      phase: "running",
      completedStepIds: [],
      updatedAt: "2026-09-22T20:00:00.000Z",
    });
    return { runtimeId: `runtime:${request.runId}` };
  }

  async status(runId) {
    return this.statuses.get(runId) ?? null;
  }
}

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-control-plane-"));
  const path = join(directory, "control.sqlite");
  try {
    await fn(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("event routing is durable, deduplicated, and freezes the first routing decision", async () => {
  await withStore(async (path) => {
    const clock = { now: () => "2026-09-22T20:00:00.000Z" };
    const launcher = new RecordingLauncher();
    const store = new SqliteControlPlaneStore(path);
    const control = new AutomationControlPlane({ store, launcher, clock });
    await control.registerAutomation(eventAutomation(1));

    const event = {
      id: "evt-1",
      type: "publication.approved",
      source: "publication-kernel",
      occurredAt: "2026-09-22T19:59:00.000Z",
      publication,
      groups: [group],
    };
    const first = await control.routeEvent(event);
    assert.equal(first.length, 1);
    assert.equal(first[0].dispatchState, "started");
    assert.equal(first[0].request.definition.version, 1);
    assert.equal(launcher.calls.length, 1);

    await control.registerAutomation(eventAutomation(2));
    const duplicate = await control.routeEvent(event);
    assert.equal(duplicate.length, 1);
    assert.equal(duplicate[0].runId, first[0].runId);
    assert.equal(duplicate[0].request.definition.version, 1);
    assert.equal(launcher.calls.length, 1);

    const next = await control.routeEvent({ ...event, id: "evt-2" });
    assert.equal(next[0].request.definition.version, 2);
    assert.equal(launcher.calls.length, 2);
    store.close();

    const reopened = new SqliteControlPlaneStore(path);
    const launcherAfterRestart = new RecordingLauncher();
    const restartedControl = new AutomationControlPlane({ store: reopened, launcher: launcherAfterRestart, clock });
    const afterRestart = await restartedControl.routeEvent(event);
    assert.equal(afterRestart[0].runId, first[0].runId);
    assert.equal(launcherAfterRestart.calls.length, 0);
    reopened.close();
  });
});

test("a failed launch is retried with the same deterministic workflow id", async () => {
  await withStore(async (path) => {
    const clock = { now: () => "2026-09-22T20:00:00.000Z" };
    const launcher = new RecordingLauncher();
    launcher.failCount = 1;
    const store = new SqliteControlPlaneStore(path);
    const control = new AutomationControlPlane({ store, launcher, clock });
    await control.registerAutomation(eventAutomation());
    const event = {
      id: "evt-retry",
      type: "publication.approved",
      source: "publication-kernel",
      occurredAt: "2026-09-22T19:59:00.000Z",
      publication,
      groups: [group],
    };

    const first = await control.routeEvent(event);
    assert.equal(first[0].dispatchState, "launch_failed");
    const runId = first[0].runId;
    const second = await control.routeEvent(event);
    assert.equal(second[0].dispatchState, "started");
    assert.equal(second[0].runId, runId);
    assert.deepEqual(launcher.calls, [runId, runId]);
    store.close();
  });
});

test("daily local schedules preserve wall-clock time across daylight-saving changes", () => {
  const schedule = createScheduleSnapshot({
    id: "dst",
    automationId: "scheduled-release",
    automationVersion: 1,
    publication,
    groups: [group],
    timezone: "America/Detroit",
    localDate: "2026-03-07",
    localTime: "09:00",
    recurrence: { kind: "daily" },
    missedRunPolicy: "catch_up_once",
  }, "2026-03-01T00:00:00Z");

  assert.equal(schedule.nextFireAt, "2026-03-07T14:00:00Z");
  assert.equal(nextScheduleFireAfter(schedule, schedule.nextFireAt), "2026-03-08T13:00:00Z");
});

test("scheduler claims, launches and advances one durable fire at a time", async () => {
  await withStore(async (path) => {
    let now = "2026-03-07T14:00:00Z";
    const clock = { now: () => now };
    const launcher = new RecordingLauncher();
    const store = new SqliteControlPlaneStore(path);
    const control = new AutomationControlPlane({ store, launcher, clock, scheduleClaimLeaseMs: 10_000 });
    await control.registerAutomation(scheduleAutomation());
    await control.createSchedule({
      id: "morning-release",
      automationId: "scheduled-release",
      automationVersion: 1,
      publication,
      groups: [group],
      timezone: "America/Detroit",
      localDate: "2026-03-07",
      localTime: "09:00",
      recurrence: { kind: "daily" },
      missedRunPolicy: "catch_up_once",
    });

    const first = await control.dispatchDueSchedules({ now });
    assert.equal(first[0].outcome, "started");
    assert.equal(launcher.calls.length, 1);
    const schedule = await store.getSchedule("morning-release");
    assert.equal(schedule.nextFireAt, "2026-03-08T13:00:00Z");
    assert.equal(schedule.lastFireAt, "2026-03-07T14:00:00Z");

    now = "2026-03-08T13:00:00Z";
    const second = await control.dispatchDueSchedules({ now });
    assert.equal(second[0].outcome, "started");
    assert.equal(launcher.calls.length, 2);
    assert.notEqual(second[0].run.runId, first[0].run.runId);
    store.close();
  });
});

test("skip misfire policy advances a stale schedule without publishing", async () => {
  await withStore(async (path) => {
    const clock = { now: () => "2026-09-22T20:00:00Z" };
    const launcher = new RecordingLauncher();
    const store = new SqliteControlPlaneStore(path);
    const control = new AutomationControlPlane({ store, launcher, clock });
    await control.registerAutomation(scheduleAutomation());
    await control.createSchedule({
      id: "morning-release",
      automationId: "scheduled-release",
      automationVersion: 1,
      publication,
      groups: [group],
      timezone: "America/Detroit",
      localDate: "2026-09-20",
      localTime: "09:00",
      recurrence: { kind: "daily" },
      missedRunPolicy: "skip",
      misfireGraceMs: 60_000,
    });

    const results = await control.dispatchDueSchedules();
    assert.equal(results[0].outcome, "skipped");
    assert.equal(launcher.calls.length, 0);
    const schedule = await store.getSchedule("morning-release");
    assert.ok(Date.parse(schedule.nextFireAt) > Date.parse(clock.now()));
    store.close();
  });
});
