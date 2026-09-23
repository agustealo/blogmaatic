import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AutomationControlPlane,
  SqliteControlPlaneStore,
  SqlitePublicationGroupStore,
} from "@blogmaatic/control-plane";
import {
  JEKYLL_CONNECTION_CONTRACT,
  JEKYLL_GIT_EXTENSION_ID,
  JekyllGitPublisher,
} from "@blogmaatic/extension-jekyll-git";
import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";
import { StaticBearerAuthorizer, createOperatorApi } from "@blogmaatic/operator-api";

import { PublicationGroupManager } from "../dist/index.js";

const TOKENS = {
  reader: "groups-reader-0123456789-abcdefghijklmnopqrstuvwxyz",
  writer: "groups-writer-0123456789-abcdefghijklmnopqrstuvwxyz",
};

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function connection() {
  return {
    id: "jekyll-primary",
    extensionId: JEKYLL_GIT_EXTENSION_ID,
    displayName: "Jekyll primary",
    status: "active",
    settings: {},
    secretRefs: {},
    createdAt: "2026-09-23T18:00:00.000Z",
    updatedAt: "2026-09-23T18:00:00.000Z",
  };
}

function createBody(name = "Primary") {
  return {
    name,
    policySetId: "default",
    routes: [{
      id: "route-primary",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: JEKYLL_GIT_EXTENSION_ID,
        connectionId: "jekyll-primary",
        channel: "primary",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
}

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-group-api-"));
  const databasePath = join(directory, "control.sqlite");
  const store = new SqliteControlPlaneStore(databasePath);
  const groupStore = new SqlitePublicationGroupStore(databasePath);
  const connections = new ConnectionAuthority([connection()]);
  const extensions = new ExtensionRuntime(connections);
  extensions.registerPublisher(new JekyllGitPublisher(connections), JEKYLL_CONNECTION_CONTRACT);
  let tick = 0;
  const clock = { now: () => `2026-09-23T18:${String(tick++).padStart(2, "0")}:00.000Z` };
  const publicationGroups = new PublicationGroupManager({
    store: groupStore,
    connections,
    extensions,
    policySetIds: ["default"],
    now: clock.now,
  });
  const launcher = {
    async start(request) {
      return { runtimeId: `unused:${request.runId}` };
    },
  };
  const controlPlane = new AutomationControlPlane({ store, launcher, clock });
  const runtime = {
    async status() { return null; },
    async approve() { return { accepted: false, reason: "unused" }; },
    async result() { throw new Error("unused"); },
  };
  const authorizer = new StaticBearerAuthorizer([
    {
      id: "reader",
      token: TOKENS.reader,
      permissions: ["publication-groups:read", "audit:read"],
    },
    {
      id: "writer",
      token: TOKENS.writer,
      permissions: ["publication-groups:write", "publication-groups:read", "audit:read"],
    },
  ]);
  const app = createOperatorApi({
    controlPlane,
    store,
    runtime,
    publicationGroups,
    authorizer,
    clock,
  });
  try {
    await fn({ app, store, publicationGroups });
  } finally {
    await app.close();
    groupStore.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("publication group API owns identifiers, permissions, versions, and immutable history", async () => {
  await withApi(async ({ app, store }) => {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.reader),
      payload: createBody(),
    });
    assert.equal(denied.statusCode, 403);

    const spoofedId = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: { id: "client-owned", ...createBody() },
    });
    assert.equal(spoofedId.statusCode, 400);
    assert.equal(spoofedId.json().error.code, "INVALID_REQUEST");

    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: createBody(),
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = createdResponse.json();
    assert.match(created.group.id, /^group_[0-9a-f-]{36}$/);
    assert.equal(created.version, 1);
    assert.equal(created.enabled, true);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/publication-groups?enabled=true&limit=10",
      headers: bearer(TOKENS.reader),
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(listed.json().items[0].group.id, created.group.id);

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/v1/publication-groups/${encodeURIComponent(created.group.id)}`,
      headers: bearer(TOKENS.writer),
      payload: { expectedVersion: 1, ...createBody("Primary v2") },
    });
    assert.equal(updatedResponse.statusCode, 200, updatedResponse.body);
    const updated = updatedResponse.json();
    assert.equal(updated.version, 2);
    assert.equal(updated.group.name, "Primary v2");

    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/publication-groups/${encodeURIComponent(created.group.id)}`,
      headers: bearer(TOKENS.writer),
      payload: { expectedVersion: 1, ...createBody("Stale overwrite") },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, "PUBLICATION_GROUP_VERSION_CONFLICT");

    const firstVersion = await app.inject({
      method: "GET",
      url: `/v1/publication-groups/${encodeURIComponent(created.group.id)}/versions/1`,
      headers: bearer(TOKENS.reader),
    });
    assert.equal(firstVersion.statusCode, 200);
    assert.equal(firstVersion.json().group.name, "Primary");
    assert.equal(firstVersion.json().isActiveVersion, false);

    const activation = await app.inject({
      method: "POST",
      url: `/v1/publication-groups/${encodeURIComponent(created.group.id)}/activation`,
      headers: bearer(TOKENS.writer),
      payload: { expectedVersion: 2, enabled: false },
    });
    assert.equal(activation.statusCode, 200);
    assert.equal(activation.json().enabled, false);
    assert.equal(activation.json().version, 3);

    const staleActivation = await app.inject({
      method: "POST",
      url: `/v1/publication-groups/${encodeURIComponent(created.group.id)}/activation`,
      headers: bearer(TOKENS.writer),
      payload: { expectedVersion: 2, enabled: true },
    });
    assert.equal(staleActivation.statusCode, 409);
    assert.equal(staleActivation.json().error.code, "PUBLICATION_GROUP_VERSION_CONFLICT");

    const audit = await store.listAudit({ resourceType: "publication-group", resourceId: created.group.id });
    assert.deepEqual(
      audit.items.map((entry) => `${entry.action}:${entry.phase}`).sort(),
      [
        "publication-group.activate:failed",
        "publication-group.activate:intent",
        "publication-group.activate:intent",
        "publication-group.activate:succeeded",
        "publication-group.create:intent",
        "publication-group.create:succeeded",
        "publication-group.update:failed",
        "publication-group.update:intent",
        "publication-group.update:intent",
        "publication-group.update:succeeded",
      ].sort(),
    );
  });
});

test("publication group API rejects non-runnable policy and route configurations", async () => {
  await withApi(async ({ app }) => {
    const unsupported = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: {
        ...createBody(),
        routes: [{ ...createBody().routes[0], requiredCapabilities: ["article.delete"] }],
      },
    });
    assert.equal(unsupported.statusCode, 422, unsupported.body);
    assert.equal(unsupported.json().error.code, "DOMAIN_REJECTED");
    assert.match(unsupported.json().error.message, /unsupported capabilities/);

    const unknownPolicy = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: { ...createBody(), policySetId: "missing-policy" },
    });
    assert.equal(unknownPolicy.statusCode, 422, unknownPolicy.body);
    assert.match(unknownPolicy.json().error.message, /unknown policy set/);

    const emptyEnabledGroup = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: { ...createBody(), routes: [] },
    });
    assert.equal(emptyEnabledGroup.statusCode, 422, emptyEnabledGroup.body);
    assert.match(emptyEnabledGroup.json().error.message, /at least one enabled route/);

    const parked = await app.inject({
      method: "POST",
      url: "/v1/publication-groups",
      headers: bearer(TOKENS.writer),
      payload: { ...createBody("Parked"), routes: [], enabled: false },
    });
    assert.equal(parked.statusCode, 201, parked.body);
    assert.equal(parked.json().enabled, false);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/publication-groups/group_missing",
      headers: bearer(TOKENS.reader),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "PUBLICATION_GROUP_NOT_FOUND");
  });
});
