import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqlitePublicationGroupStore } from "../dist/index.js";

function group(connectionId = "connection-primary", routeEnabled = true, name = "Primary distribution") {
  return {
    id: "primary",
    name,
    policySetId: "default",
    routes: [{
      id: "jekyll-primary",
      enabled: routeEnabled,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId,
        channel: "primary",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
}

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-publication-groups-"));
  const path = join(directory, "control.sqlite");
  const store = new SqlitePublicationGroupStore(path);
  try {
    await fn({ store, path });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("publication groups are versioned, optimistic, and preserve immutable historical snapshots", async () => {
  await withStore(async ({ store }) => {
    const created = await store.createPublicationGroup(group(), true, "2026-09-23T17:10:00.000Z");
    assert.equal(created.version, 1);
    assert.equal(created.activeVersion, 1);
    assert.equal(created.enabled, true);
    assert.equal(created.group.name, "Primary distribution");

    await assert.rejects(
      () => store.createPublicationGroup(group(), true, "2026-09-23T17:10:01.000Z"),
      /already exists/,
    );

    const updated = await store.updatePublicationGroup(
      group("connection-primary", true, "Primary distribution v2"),
      1,
      true,
      "2026-09-23T17:11:00.000Z",
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.activeVersion, 2);
    assert.equal(updated.group.name, "Primary distribution v2");

    const first = await store.getPublicationGroupVersion("primary", 1);
    assert.equal(first.version, 1);
    assert.equal(first.isActiveVersion, false);
    assert.equal(first.enabled, false);
    assert.equal(first.group.name, "Primary distribution");

    await assert.rejects(
      () => store.updatePublicationGroup(group(), 1, true, "2026-09-23T17:12:00.000Z"),
      /changed from version 1 to 2/,
    );

    const versions = await store.listPublicationGroupVersions("primary");
    assert.deepEqual(versions.items.map((entry) => entry.version), [2, 1]);
  });
});

test("enabled route references block connection removal while disabled groups and routes do not", async () => {
  await withStore(async ({ store }) => {
    await store.createPublicationGroup(group(), true, "2026-09-23T17:20:00.000Z");
    assert.deepEqual(
      (await store.listEnabledPublicationGroupsByConnection("connection-primary")).map((entry) => entry.group.id),
      ["primary"],
    );

    const disabled = await store.setPublicationGroupEnabled(
      "primary",
      1,
      false,
      "2026-09-23T17:21:00.000Z",
    );
    assert.equal(disabled.enabled, false);
    assert.equal((await store.listEnabledPublicationGroupsByConnection("connection-primary")).length, 0);

    const reenabled = await store.setPublicationGroupEnabled(
      "primary",
      1,
      true,
      "2026-09-23T17:22:00.000Z",
    );
    assert.equal(reenabled.enabled, true);

    const routeDisabled = await store.updatePublicationGroup(
      group("connection-primary", false, "Route disabled"),
      1,
      true,
      "2026-09-23T17:23:00.000Z",
    );
    assert.equal(routeDisabled.version, 2);
    assert.equal(routeDisabled.enabled, true);
    assert.equal((await store.listEnabledPublicationGroupsByConnection("connection-primary")).length, 0);
  });
});

test("managed publication groups survive a fresh store instance on the same control-plane database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-publication-groups-restart-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = new SqlitePublicationGroupStore(path);
    await first.createPublicationGroup(group(), true, "2026-09-23T17:30:00.000Z");
    first.close();

    const second = new SqlitePublicationGroupStore(path);
    try {
      const restored = await second.getActivePublicationGroup("primary");
      assert.equal(restored.version, 1);
      assert.equal(restored.enabled, true);
      assert.equal(restored.group.routes[0].destination.connectionId, "connection-primary");
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
