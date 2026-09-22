import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionAuthority, ExtensionRuntime } from "../dist/index.js";

function connection(overrides = {}) {
  return {
    id: "conn-1",
    extensionId: "example.publisher",
    displayName: "Example",
    status: "active",
    settings: {},
    secretRefs: {},
    createdAt: "2026-09-22T17:00:00.000Z",
    updatedAt: "2026-09-22T17:00:00.000Z",
    ...overrides,
  };
}

class ManagedPublisher {
  manifest = {
    apiVersion: 1,
    kind: "publisher",
    connectionSchemaVersion: 1,
    id: "example.publisher",
    displayName: "Example Publisher",
    version: "1.0.0",
    capabilities: ["article.create", "article.inspect"],
  };
  async validateConnection(item) {
    return {
      valid: item.settings.invalid !== true,
      errors: item.settings.invalid === true ? ["invalid"] : [],
    };
  }
  async checkHealth() {
    return {
      state: "healthy",
      checkedAt: "2026-09-22T17:00:00.000Z",
      detail: "ready",
    };
  }
  async compile() {
    throw new Error("not used");
  }
  async deliver() {
    throw new Error("not used");
  }
  async inspect() {
    throw new Error("not used");
  }
}

test("connection authority preserves extension ownership and active status", () => {
  const authority = new ConnectionAuthority([connection()]);
  assert.equal(authority.requireActive("example.publisher", "conn-1").id, "conn-1");
  assert.throws(
    () => authority.requireActive("other.publisher", "conn-1"),
    /belongs to example.publisher/,
  );

  authority.replace(
    connection({ status: "disabled", updatedAt: "2026-09-22T18:00:00.000Z" }),
  );
  assert.throws(
    () => authority.requireActive("example.publisher", "conn-1"),
    /disabled/,
  );
  assert.throws(
    () => authority.replace(connection({ extensionId: "other.publisher" })),
    /cannot change extension ownership/,
  );
});

test("runtime validates extension manifests and reports disabled connections unhealthy", async () => {
  const authority = new ConnectionAuthority([connection({ status: "disabled" })]);
  const runtime = new ExtensionRuntime(authority);
  runtime.registerPublisher(new ManagedPublisher());

  const health = await runtime.checkHealth("conn-1");
  assert.equal(health.state, "unhealthy");
  assert.match(health.detail, /disabled/);
});
