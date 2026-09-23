import assert from "node:assert/strict";
import test from "node:test";

import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKENS = {
  reader: "connections-reader-0123456789-abcdefghijklmnopqrstuvwxyz",
  writer: "connections-writer-0123456789-abcdefghijklmnopqrstuvwxyz",
};

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function connectionView(input) {
  return {
    id: input.id,
    extensionId: input.extensionId,
    displayName: input.displayName,
    status: input.status ?? "active",
    settings: input.settings,
    configuredSecrets: Object.keys(input.secrets ?? {}).sort(),
    createdAt: "2026-09-23T17:00:00.000Z",
    updatedAt: "2026-09-23T17:00:00.000Z",
  };
}

class RecordingConnections {
  records = new Map();
  creates = [];
  updates = [];

  listTypes() {
    return [{
      manifest: {
        apiVersion: 1,
        kind: "publisher",
        connectionSchemaVersion: 1,
        id: "blogmaatic.wordpress-rest",
        displayName: "WordPress REST",
        version: "1.0.0",
        capabilities: ["article.create", "article.inspect"],
      },
      connectionContract: {
        schemaVersion: 1,
        settingsFields: [
          { key: "siteUrl", label: "Site URL", kind: "url", required: true },
          { key: "username", label: "Username", kind: "text", required: true },
        ],
        secretFields: [
          { key: "applicationPassword", label: "Application Password", required: true },
        ],
      },
    }];
  }

  list() {
    return [...this.records.values()];
  }

  get(connectionId) {
    const record = this.records.get(connectionId);
    if (!record) throw new Error("not found");
    return record;
  }

  async create(input) {
    this.creates.push(input);
    const record = connectionView(input);
    this.records.set(record.id, record);
    return record;
  }

  async update(connectionId, input) {
    this.updates.push({ connectionId, input });
    const current = this.get(connectionId);
    const record = {
      ...current,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.settings === undefined ? {} : { settings: input.settings }),
      configuredSecrets: [...new Set([
        ...current.configuredSecrets,
        ...Object.keys(input.secrets ?? {}),
      ])].sort(),
      updatedAt: "2026-09-23T17:01:00.000Z",
    };
    this.records.set(connectionId, record);
    return record;
  }

  async remove(connectionId) {
    const current = this.get(connectionId);
    this.records.delete(connectionId);
    return current;
  }

  async test(connectionId) {
    this.get(connectionId);
    return {
      validation: { valid: true, errors: [] },
      health: {
        state: "healthy",
        checkedAt: "2026-09-23T17:02:00.000Z",
        detail: "Connection reachable",
      },
    };
  }
}

function createHarness() {
  const audits = [];
  const connections = new RecordingConnections();
  const app = createOperatorApi({
    controlPlane: {},
    runtime: {},
    store: {
      async appendAudit(entry) {
        audits.push(entry);
      },
    },
    connections,
    authorizer: new StaticBearerAuthorizer([
      {
        id: "reader",
        token: TOKENS.reader,
        permissions: ["connections:read"],
      },
      {
        id: "writer",
        token: TOKENS.writer,
        permissions: ["connections:read", "connections:write"],
      },
    ]),
    clock: { now: () => "2026-09-23T17:00:00.000Z" },
  });
  return { app, audits, connections };
}

test("connection surfaces are permissioned and extension contracts remain the form authority", async () => {
  const { app, connections } = createHarness();
  try {
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/connection-types" });
    assert.equal(unauthenticated.statusCode, 401);

    const types = await app.inject({
      method: "GET",
      url: "/v1/connection-types",
      headers: bearer(TOKENS.reader),
    });
    assert.equal(types.statusCode, 200, types.body);
    assert.equal(types.json().items[0].connectionContract.secretFields[0].key, "applicationPassword");

    const denied = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: bearer(TOKENS.reader),
      payload: {
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        secrets: { applicationPassword: "secret" },
      },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(connections.creates.length, 0);
  } finally {
    await app.close();
  }
});

test("connection create is server-identified, redacted, and secret-free in audit evidence", async () => {
  const { app, audits, connections } = createHarness();
  const secret = "wordpress-application-password-super-secret";
  try {
    const browserId = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: bearer(TOKENS.writer),
      payload: {
        id: "browser-controlled",
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        secrets: { applicationPassword: secret },
      },
    });
    assert.equal(browserId.statusCode, 400);
    assert.equal(connections.creates.length, 0);

    const created = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: bearer(TOKENS.writer),
      payload: {
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        secrets: { applicationPassword: secret },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json();
    assert.match(body.id, /^connection_[0-9a-f-]{36}$/);
    assert.deepEqual(body.configuredSecrets, ["applicationPassword"]);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes("vault:"), false);
    assert.equal(connections.creates[0].id, body.id);
    assert.equal(connections.creates[0].secrets.applicationPassword, secret);

    const auditJson = JSON.stringify(audits);
    assert.equal(auditJson.includes(secret), false);
    assert.equal(auditJson.includes("vault:"), false);
    assert.match(auditJson, /applicationPassword/);
    assert.equal(audits.length, 2);
    assert.equal(audits[0].phase, "intent");
    assert.equal(audits[1].phase, "succeeded");
  } finally {
    await app.close();
  }
});

test("connection update, test, and removal preserve redacted control-plane semantics", async () => {
  const { app, audits } = createHarness();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/connections",
      headers: bearer(TOKENS.writer),
      payload: {
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        secrets: { applicationPassword: "first-secret" },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const connectionId = created.json().id;
    audits.length = 0;

    const illegalOwnerChange = await app.inject({
      method: "PATCH",
      url: `/v1/connections/${connectionId}`,
      headers: bearer(TOKENS.writer),
      payload: { extensionId: "blogmaatic.facebook-pages" },
    });
    assert.equal(illegalOwnerChange.statusCode, 400);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/connections/${connectionId}`,
      headers: bearer(TOKENS.writer),
      payload: { status: "disabled", secrets: { applicationPassword: "rotated-secret" } },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().status, "disabled");
    assert.deepEqual(updated.json().configuredSecrets, ["applicationPassword"]);
    assert.equal(JSON.stringify(updated.json()).includes("rotated-secret"), false);

    const tested = await app.inject({
      method: "POST",
      url: `/v1/connections/${connectionId}/test`,
      headers: bearer(TOKENS.reader),
    });
    assert.equal(tested.statusCode, 200, tested.body);
    assert.equal(tested.json().health.state, "healthy");

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/connections/${connectionId}`,
      headers: bearer(TOKENS.writer),
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const missing = await app.inject({
      method: "GET",
      url: `/v1/connections/${connectionId}`,
      headers: bearer(TOKENS.reader),
    });
    assert.equal(missing.statusCode, 404);

    const auditJson = JSON.stringify(audits);
    assert.equal(auditJson.includes("rotated-secret"), false);
    assert.match(auditJson, /changedSecretFields/);
    assert.match(auditJson, /connection.remove/);
  } finally {
    await app.close();
  }
});
