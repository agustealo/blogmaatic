import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutomationControlPlane,
  SqliteControlPlaneStore,
} from "@blogmaatic/control-plane";

import { ScheduleManager } from "../dist/schedule-manager.js";

const publication = {
  id: "pub-schedule-manager",
  createdAt: "2026-10-01T00:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-schedule-manager-1",
    ordinal: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Scheduled publishing",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Durable schedule proof." } }],
      assets: [],
      tags: ["schedule"],
      attributes: {},
    },
  },
  provenance: {},
};

const group = {
  id: "group-schedule-manager",
  name: "Scheduled destinations",
  policySetId: "default",
  routes: [{
    id: "route-schedule-manager",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "contract.publisher",
      connectionId: "connection-schedule-manager",
      channel: "posts",
    },
    requiredCapabilities: ["article.create", "article.inspect"],
  }],
};

async function withHarness(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-schedule-manager-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  let now = "2026-10-01T00:00:00.000Z";
  const clock = { now: () => now };
  const launcher = { start: async (request) => ({ runtimeId: `runtime:${request.runId}` }) };
  const controlPlane = new AutomationControlPlane({ store, launcher, clock });
  const manager = new ScheduleManager({ store, now: () => now });
  try {
    await fn({
      store,
      controlPlane,
      manager,
      setNow(value) { now = value; },
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("schedule activation uses optimistic concurrency and validates the pinned automation", async () => {
  await withHarness(async ({ store, controlPlane, manager, setNow }) => {
    const definition = {
      id: "automation-schedule-manager",
      version: 1,
      name: "Scheduled publishing",
      enabled: true,
      trigger: { kind: "schedule", scheduleId: "schedule-manager" },
      steps: [{ id: "publish", kind: "publish_group", groupId: group.id }],
    };
    await controlPlane.registerAutomation(definition);
    const schedule = await controlPlane.createSchedule({
      id: "schedule-manager",
      automationId: definition.id,
      automationVersion: definition.version,
      publication,
      groups: [group],
      timezone: "UTC",
      localDate: "2026-10-02",
      localTime: "09:00",
      recurrence: { kind: "daily" },
      missedRunPolicy: "skip",
      enabled: true,
    });

    await assert.rejects(
      () => manager.setEnabled(schedule.id, "2026-09-30T23:59:59.000Z", false),
      /changed from .* to/,
    );
    assert.equal((await store.getSchedule(schedule.id)).enabled, true);

    setNow("2026-10-01T00:01:00.000Z");
    const disabled = await manager.setEnabled(schedule.id, schedule.updatedAt, false);
    assert.equal(disabled.enabled, false);
    assert.notEqual(disabled.updatedAt, schedule.updatedAt);

    setNow("2026-10-01T00:02:00.000Z");
    await controlPlane.activateAutomation(definition.id, definition.version, false);
    await assert.rejects(
      () => manager.setEnabled(schedule.id, disabled.updatedAt, true),
      /not the enabled active version/,
    );
    assert.equal((await store.getSchedule(schedule.id)).enabled, false);

    setNow("2026-10-01T00:03:00.000Z");
    await controlPlane.activateAutomation(definition.id, definition.version, true);
    const reenabled = await manager.setEnabled(schedule.id, disabled.updatedAt, true);
    assert.equal(reenabled.enabled, true);

    const claims = await store.claimDueSchedules(
      "2026-10-02T09:00:00.000Z",
      "2026-10-02T09:05:00.000Z",
      1,
    );
    assert.equal(claims.length, 1);

    setNow("2026-10-02T09:01:00.000Z");
    await assert.rejects(
      () => manager.setEnabled(schedule.id, claims[0].schedule.updatedAt, false),
      /actively claimed/,
    );
    assert.equal((await store.getSchedule(schedule.id)).enabled, true);

    await store.releaseScheduleClaim(
      schedule.id,
      claims[0].token,
      "2026-10-02T09:01:00.000Z",
    );
  });
});
