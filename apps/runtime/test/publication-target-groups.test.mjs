import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicationWorkspaceManager,
  publicationTargetGroupIds,
} from "../dist/publication-workspace-manager.js";

function group(id, enabled = true, routeEnabled = true) {
  return {
    group: {
      id,
      name: `Group ${id}`,
      policySetId: "default",
      routes: [{
        id: `route-${id}`,
        destination: {
          extensionId: "blogmaatic.wordpress-rest",
          connectionId: `connection-${id}`,
          channel: "posts",
        },
        requiredCapabilities: [],
        desiredState: "present",
        enabled: routeEnabled,
      }],
    },
    version: 1,
    enabled,
    recordedAt: "2026-10-24T20:00:00.000Z",
    updatedAt: "2026-10-24T20:00:00.000Z",
  };
}

function harness(groups) {
  let entry;
  let routedEvent;
  let id = 0;
  const store = {
    async create(publication, recordedAt) {
      entry = { publication, version: 1, recordedAt, updatedAt: recordedAt };
      return entry;
    },
    async get(publicationId) {
      return entry?.publication.id === publicationId ? entry : undefined;
    },
    async update(publication, expectedVersion, updatedAt) {
      assert.equal(expectedVersion, entry.version);
      entry = {
        publication,
        version: expectedVersion + 1,
        recordedAt: updatedAt,
        updatedAt,
      };
      return entry;
    },
  };
  const byId = new Map(groups.map((candidate) => [candidate.group.id, candidate]));
  const manager = new PublicationWorkspaceManager({
    store,
    publicationGroups: {
      async get(groupId) {
        return byId.get(groupId);
      },
    },
    controlPlane: {
      async routeEvent(event) {
        routedEvent = event;
        return [{ runId: "run-1" }];
      },
    },
    now: () => "2026-10-24T22:00:00.000Z",
    id: () => `id-${++id}`,
  });
  return {
    manager,
    current: () => entry,
    routed: () => routedEvent,
    setGroup(groupEntry) {
      byId.set(groupEntry.group.id, groupEntry);
    },
  };
}

test("publication targets are canonical, normalized, immutable revision intent", async () => {
  const h = harness([group("a"), group("b")]);
  const created = await h.manager.create({
    title: "Target proof",
    targetGroupIds: [" b ", "a", "a"],
  });
  assert.deepEqual(publicationTargetGroupIds(created.publication), ["a", "b"]);
  assert.equal(created.publication.current.ordinal, 1);

  const changed = await h.manager.update(created.publication.id, {
    expectedVersion: created.version,
    targetGroupIds: ["b"],
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.publication.current.ordinal, 2);
  assert.notEqual(changed.publication.current.id, created.publication.current.id);
  assert.deepEqual(publicationTargetGroupIds(changed.publication), ["b"]);

  const titleChanged = await h.manager.update(created.publication.id, {
    expectedVersion: changed.version,
    title: "Target proof revised",
  });
  assert.equal(titleChanged.publication.current.ordinal, 3);
  assert.deepEqual(publicationTargetGroupIds(titleChanged.publication), ["b"]);
});

test("manual publication dispatch refuses legacy or explicit zero-target publications", async () => {
  const h = harness([group("a")]);
  const created = await h.manager.create({ title: "No spray" });
  assert.deepEqual(publicationTargetGroupIds(created.publication), []);

  await assert.rejects(
    () => h.manager.approveAndDispatch(created.publication.id, created.version),
    /no publishing targets/i,
  );
  assert.equal(h.routed(), undefined);
});

test("manual publication dispatch passes only the explicitly selected group subset", async () => {
  const h = harness([group("a"), group("b"), group("c")]);
  const created = await h.manager.create({
    title: "Subset only",
    status: "approved",
    targetGroupIds: ["c", "a"],
  });

  const result = await h.manager.approveAndDispatch(created.publication.id, created.version);
  assert.equal(result.runs.length, 1);
  assert.deepEqual(
    h.routed().groups.map((candidate) => candidate.id),
    ["a", "c"],
  );
  assert.equal(h.routed().groups.some((candidate) => candidate.id === "b"), false);
  assert.equal(h.routed().publication.current.id, created.publication.current.id);
});

test("manual publication dispatch fails closed for missing disabled or route-less targets", async () => {
  for (const [label, groupEntry, message] of [
    ["missing", undefined, /unavailable: missing/],
    ["disabled", group("disabled", false), /disabled: disabled/],
    ["route-less", group("route-less", true, false), /no enabled routes: route-less/],
  ]) {
    const h = harness(groupEntry ? [groupEntry] : []);
    const created = await h.manager.create({
      title: `Fail closed ${label}`,
      status: "approved",
      targetGroupIds: [label],
    });
    await assert.rejects(
      () => h.manager.approveAndDispatch(created.publication.id, created.version),
      message,
    );
    assert.equal(h.routed(), undefined);
  }
});
