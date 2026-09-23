import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqlitePublicationGroupStore } from "@blogmaatic/control-plane";
import {
  JEKYLL_CONNECTION_CONTRACT,
  JEKYLL_GIT_EXTENSION_ID,
  JekyllGitPublisher,
} from "@blogmaatic/extension-jekyll-git";
import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";

import {
  ConnectionManager,
  PublicationGroupManager,
  defaultRuntimeConfig,
} from "../dist/index.js";

function connection(id, status = "active") {
  return {
    id,
    extensionId: JEKYLL_GIT_EXTENSION_ID,
    displayName: id,
    status,
    settings: {},
    secretRefs: {},
    createdAt: "2026-09-23T17:40:00.000Z",
    updatedAt: "2026-09-23T17:40:00.000Z",
  };
}

function group({ connectionId = "jekyll-active", extensionId = JEKYLL_GIT_EXTENSION_ID, capabilities = ["article.create"], enabled = true } = {}) {
  return {
    id: "primary",
    name: "Primary",
    policySetId: "default",
    routes: [{
      id: "route-primary",
      enabled,
      desiredState: "present",
      destination: { extensionId, connectionId, channel: "primary" },
      requiredCapabilities: capabilities,
    }],
  };
}

async function withManager(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-group-manager-"));
  const store = new SqlitePublicationGroupStore(join(directory, "control.sqlite"));
  const connections = new ConnectionAuthority([
    connection("jekyll-active", "active"),
    connection("jekyll-disabled", "disabled"),
  ]);
  const extensions = new ExtensionRuntime(connections);
  extensions.registerPublisher(new JekyllGitPublisher(connections), JEKYLL_CONNECTION_CONTRACT);
  let tick = 0;
  const manager = new PublicationGroupManager({
    store,
    connections,
    extensions,
    policySetIds: ["default"],
    now: () => `2026-09-23T17:4${tick++}:00.000Z`,
  });
  try {
    await fn({ manager, store, connections, extensions });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("enabled publication groups require live connection ownership and supported publisher capabilities", async () => {
  await withManager(async ({ manager }) => {
    const created = await manager.create({ group: group() });
    assert.equal(created.enabled, true);
    assert.equal(created.version, 1);

    await assert.rejects(
      () => manager.create({ group: { ...group({ connectionId: "jekyll-disabled" }), id: "disabled-connection" } }),
      /cannot use disabled connection/,
    );

    await assert.rejects(
      () => manager.create({
        group: { ...group({ capabilities: ["article.delete"] }), id: "unsupported-capability" },
      }),
      /requires unsupported capabilities/,
    );

    await assert.rejects(
      () => manager.create({
        group: { ...group({ extensionId: "blogmaatic.wordpress-rest" }), id: "wrong-owner" },
      }),
      /expects blogmaatic.wordpress-rest but connection jekyll-active belongs to blogmaatic.jekyll-git/,
    );
  });
});

test("enabled publication groups reject missing policies and empty enabled routing", async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(
      () => manager.create({
        group: { ...group(), id: "unknown-policy", policySetId: "missing" },
      }),
      /references unknown policy set missing/,
    );

    await assert.rejects(
      () => manager.create({
        group: { ...group(), id: "empty", routes: [] },
      }),
      /must contain at least one enabled route/,
    );

    const parked = await manager.create({
      group: { ...group(), id: "parked-empty", routes: [] },
      enabled: false,
    });
    assert.equal(parked.enabled, false);
  });
});

test("disabled groups may retain configuration but cannot be re-enabled against a disabled connection", async () => {
  await withManager(async ({ manager }) => {
    const created = await manager.create({
      group: { ...group({ connectionId: "jekyll-disabled" }), id: "parked" },
      enabled: false,
    });
    assert.equal(created.enabled, false);

    await assert.rejects(
      () => manager.setEnabled("parked", 1, true),
      /cannot use disabled connection/,
    );
  });
});

test("connection reference guard blocks disabling or removing a connection used by an enabled group", async () => {
  await withManager(async ({ manager, connections, extensions }) => {
    await manager.create({ group: group() });
    const writes = [];
    const connectionManager = new ConnectionManager({
      config: { ...defaultRuntimeConfig(), connections: connections.list() },
      configPath: "/runtime.json",
      connections,
      extensions,
      secrets: new SecretAuthority(),
      referenceGuard: (record) => manager.assertConnectionRemovable(record.id),
      writeConfig: async (_path, config) => { writes.push(config); },
    });

    await assert.rejects(
      () => connectionManager.update("jekyll-active", { status: "disabled" }),
      /referenced by enabled publication group: primary/,
    );
    assert.equal(connections.get("jekyll-active").status, "active");
    assert.equal(writes.length, 0);

    await assert.rejects(
      () => connectionManager.remove("jekyll-active"),
      /referenced by enabled publication group: primary/,
    );
    assert.equal(connections.has("jekyll-active"), true);
    assert.equal(writes.length, 0);

    const disabledGroup = await manager.setEnabled("primary", 1, false);
    assert.equal(disabledGroup.version, 2);

    const disabledConnection = await connectionManager.update("jekyll-active", { status: "disabled" });
    assert.equal(disabledConnection.status, "disabled");
    assert.equal(writes.length, 1);

    const reactivatedConnection = await connectionManager.update("jekyll-active", { status: "active" });
    assert.equal(reactivatedConnection.status, "active");
    assert.equal(writes.length, 2);

    const removed = await connectionManager.remove("jekyll-active");
    assert.equal(removed.id, "jekyll-active");
    assert.equal(connections.has("jekyll-active"), false);
    assert.equal(writes.length, 3);
    assert.equal(writes[2].connections.some((entry) => entry.id === "jekyll-active"), false);
  });
});

test("disabled publication groups may park disabled routes without blocking connection removal", async () => {
  await withManager(async ({ manager }) => {
    await manager.create({ group: group() });
    const disabled = await manager.setEnabled("primary", 1, false);
    assert.equal(disabled.version, 2);
    await manager.assertConnectionRemovable("jekyll-active");

    const parkedRoute = await manager.update({
      group: group({ enabled: false }),
      expectedVersion: 2,
      enabled: false,
    });
    assert.equal(parkedRoute.version, 3);
    assert.equal(parkedRoute.enabled, false);
    await manager.assertConnectionRemovable("jekyll-active");

    await assert.rejects(
      () => manager.setEnabled("primary", 3, true),
      /must contain at least one enabled route/,
    );
  });
});
