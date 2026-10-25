import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicationWorkspaceManager,
  publicationTargetGroupIds,
} from "../dist/publication-workspace-manager.js";

function group(id, enabledRoutes = true) {
  return {
    id,
    name: id === "group-a" ? "Alpha" : id === "group-b" ? "Beta" : id,
    policySetId: "default",
    routes: [{
      id: `route-${id}`,
      enabled: enabledRoutes,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId: `connection-${id}`,
        channel: "posts",
      },
      requiredCapabilities: ["article.create"],
    }],
  };
}

function harness(groupEntries = {}) {
  let current;
  let idIndex = 0;
  const events = [];
  const store = {
    async create(publication, recordedAt) {
      current = {
        publication,
        version: 1,
        recordedAt,
        updatedAt: recordedAt,
      };
      return current;
    },
    async get(id) {
      return current?.publication.id === id ? current : undefined;
    },
    async update(publication, expectedVersion, updatedAt) {
      assert.equal(expectedVersion, current.version);
      current = {
        publication,
        version: expectedVersion + 1,
        recordedAt: current.recordedAt,
        updatedAt,
      };
      return current;
    },
  };
  const publicationGroups = {
    async get(groupId) {
      return groupEntries[groupId];
    },
    async list() {
      throw new Error("global publication group enumeration is forbidden during dispatch");
    },
  };
  const controlPlane = {
    async routeEvent(event) {
      events.push(event);
      return [];
    },
  };
  const manager = new PublicationWorkspaceManager({
    store,
    publicationGroups,
    controlPlane,
    now: () => "2026-10-24T23:30:00.000Z",
    id: () => ["publication-targeting", "revision-1", "revision-2", "revision-3", "revision-4"][idIndex++] ?? `id-${idIndex}`,
  });
  return {
    manager,
    events,
    current: () => current,
  };
}

test("publication targets normalize on revision 1 and target edits create immutable revisions", async () => {
  const { manager } = harness();
  const created = await manager.create({
    title: "Targeted publication",
    publishingTargetGroupIds: [" group-b ", "group-a", "group-b"],
  });
  assert.deepEqual(publicationTargetGroupIds(created.publication), ["group-a", "group-b"]);
  assert.deepEqual(created.publication.current.content.attributes.publishingTargets, {
    groupIds: ["group-a", "group-b"],
  });

  const updated = await manager.update(created.publication.id, {
    expectedVersion: created.version,
    publishingTargetGroupIds: ["group-b"],
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.publication.current.ordinal, 2);
  assert.notEqual(updated.publication.current.id, created.publication.current.id);
  assert.deepEqual(publicationTargetGroupIds(updated.publication), ["group-b"]);

  const cleared = await manager.update(updated.publication.id, {
    expectedVersion: updated.version,
    publishingTargetGroupIds: [],
  });
  assert.equal(cleared.version, 3);
  assert.equal(cleared.publication.current.ordinal, 3);
  assert.deepEqual(publicationTargetGroupIds(cleared.publication), []);
  assert.equal("publishingTargets" in cleared.publication.current.content.attributes, false);
});

test("no targets means no publish and never falls back to globally enabled groups", async () => {
  const { manager, events, current } = harness({
    "group-a": { group: group("group-a"), version: 1, enabled: true },
    "group-b": { group: group("group-b"), version: 1, enabled: true },
  });
  const created = await manager.create({ title: "Untargeted" });

  await assert.rejects(
    () => manager.approveAndDispatch(created.publication.id, created.version),
    /no publishing targets/i,
  );
  assert.equal(events.length, 0);
  assert.equal(current().version, 1);
  assert.equal(current().publication.status, "draft");
});

test("dispatch passes only selected groups even when other groups are enabled", async () => {
  const { manager, events } = harness({
    "group-a": { group: group("group-a"), version: 1, enabled: true },
    "group-b": { group: group("group-b"), version: 1, enabled: true },
  });
  const created = await manager.create({
    title: "Subset",
    publishingTargetGroupIds: ["group-b"],
  });

  const result = await manager.approveAndDispatch(created.publication.id, created.version);
  assert.equal(result.publication.status, "approved");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].groups.map((candidate) => candidate.id), ["group-b"]);
});

test("missing disabled and unroutable targets fail closed before approval or dispatch", async () => {
  for (const scenario of [
    {
      name: "missing",
      groupId: "missing",
      entries: {},
      message: /not registered: missing/,
    },
    {
      name: "disabled",
      groupId: "group-a",
      entries: { "group-a": { group: group("group-a"), version: 1, enabled: false } },
      message: /disabled: group-a/,
    },
    {
      name: "no enabled routes",
      groupId: "group-a",
      entries: { "group-a": { group: group("group-a", false), version: 1, enabled: true } },
      message: /no enabled routes: group-a/,
    },
  ]) {
    const { manager, events, current } = harness(scenario.entries);
    const created = await manager.create({
      title: scenario.name,
      publishingTargetGroupIds: [scenario.groupId],
    });
    await assert.rejects(
      () => manager.approveAndDispatch(created.publication.id, created.version),
      scenario.message,
    );
    assert.equal(events.length, 0);
    assert.equal(current().publication.status, "draft");
    assert.equal(current().version, 1);
  }
});

test("publishing targets survive unrelated content revisions", async () => {
  const { manager } = harness();
  const created = await manager.create({
    title: "Persistent targets",
    body: "Original body",
    publishingTargetGroupIds: ["group-a", "group-b"],
  });
  const updated = await manager.update(created.publication.id, {
    expectedVersion: created.version,
    title: "Persistent targets revised",
    body: "Revised body",
  });
  assert.equal(updated.publication.current.ordinal, 2);
  assert.deepEqual(publicationTargetGroupIds(updated.publication), ["group-a", "group-b"]);
});
