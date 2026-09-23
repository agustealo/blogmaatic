import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";
import { SecretAuthority } from "@blogmaatic/secrets";
import { ConnectionManager } from "../dist/connection-manager.js";
import { defaultRuntimeConfig } from "../dist/config.js";

class MemoryVaultProvider {
  scheme = "vault";
  values = new Map();

  async resolve(locator) {
    const value = this.values.get(locator);
    return value ? Uint8Array.from(value) : undefined;
  }

  async store(locator, material) {
    this.values.set(locator, Uint8Array.from(material));
  }

  async delete(locator) {
    return this.values.delete(locator);
  }
}

function publisher(secrets) {
  return {
    manifest: {
      apiVersion: 1,
      kind: "publisher",
      connectionSchemaVersion: 1,
      id: "test.publisher",
      displayName: "Test Publisher",
      version: "1.0.0",
      capabilities: ["article.create"],
    },
    async validateConnection(connection) {
      const errors = [];
      if (typeof connection.settings.endpoint !== "string") errors.push("endpoint is required");
      if (!connection.secretRefs.token) errors.push("token is required");
      return { valid: errors.length === 0, errors };
    },
    async checkHealth(connection) {
      const readable = await secrets.withUtf8(connection.secretRefs.token, (value) => value.length > 0);
      return {
        state: readable ? "healthy" : "unhealthy",
        checkedAt: "2026-09-23T12:00:00.000Z",
        detail: readable ? "Credential is readable" : "Credential is unavailable",
      };
    },
    async compile() { throw new Error("not used"); },
    async deliver() { throw new Error("not used"); },
    async inspect() { throw new Error("not used"); },
  };
}

const contract = {
  schemaVersion: 1,
  settingsFields: [
    { key: "endpoint", label: "Endpoint", kind: "url", required: true },
  ],
  secretFields: [
    { key: "token", label: "Token", required: true },
  ],
};

test("connection manager persists live authority and rotates vault secrets without exposing plaintext", async () => {
  const vault = new MemoryVaultProvider();
  const secrets = new SecretAuthority([vault]);
  const connections = new ConnectionAuthority();
  const extensions = new ExtensionRuntime(connections);
  extensions.registerPublisher(publisher(secrets), contract);
  const writes = [];
  let failWrite = false;
  const manager = new ConnectionManager({
    config: defaultRuntimeConfig(),
    configPath: "/runtime.json",
    connections,
    extensions,
    secrets,
    createId: () => "connection_test",
    now: (() => {
      let tick = 0;
      return () => `2026-09-23T12:00:0${tick++}.000Z`;
    })(),
    writeConfig: async (_path, config) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("disk unavailable");
      }
      writes.push(config);
    },
    logger: { error() {} },
  });

  const created = await manager.create({
    extensionId: "test.publisher",
    displayName: "Primary",
    settings: { endpoint: "https://example.com" },
    secrets: { token: "token-one" },
  });
  assert.deepEqual(created.configuredSecrets, ["token"]);
  assert.equal(Object.hasOwn(created, "secretRefs"), false);
  assert.equal(JSON.stringify(created).includes("token-one"), false);
  assert.equal(writes.at(-1).connections.length, 1);
  const firstReference = connections.get("connection_test").secretRefs.token;
  assert.match(firstReference, /^vault:connection\/connection_test\/token\//);
  assert.equal(await secrets.withUtf8(firstReference, (value) => value), "token-one");

  const updated = await manager.update("connection_test", {
    displayName: "Primary WordPress",
    secrets: { token: "token-two" },
  });
  assert.equal(updated.displayName, "Primary WordPress");
  const secondReference = connections.get("connection_test").secretRefs.token;
  assert.notEqual(secondReference, firstReference);
  await assert.rejects(() => secrets.withUtf8(firstReference, () => undefined), /unavailable/);
  assert.equal(await secrets.withUtf8(secondReference, (value) => value), "token-two");

  failWrite = true;
  await assert.rejects(
    () => manager.update("connection_test", { secrets: { token: "token-three" } }),
    /disk unavailable/,
  );
  assert.equal(connections.get("connection_test").secretRefs.token, secondReference);
  assert.equal(await secrets.withUtf8(secondReference, (value) => value), "token-two");
  assert.equal(vault.values.size, 1);

  const testResult = await manager.test("connection_test");
  assert.equal(testResult.validation.valid, true);
  assert.equal(testResult.health?.state, "healthy");

  const removed = await manager.remove("connection_test");
  assert.equal(removed.id, "connection_test");
  assert.equal(manager.list().length, 0);
  assert.equal(writes.at(-1).connections.length, 0);
  assert.equal(vault.values.size, 0);
});

test("connection manager rejects unknown fields and required-secret omissions before persistence", async () => {
  const vault = new MemoryVaultProvider();
  const secrets = new SecretAuthority([vault]);
  const connections = new ConnectionAuthority();
  const extensions = new ExtensionRuntime(connections);
  extensions.registerPublisher(publisher(secrets), contract);
  let writes = 0;
  const manager = new ConnectionManager({
    config: defaultRuntimeConfig(),
    configPath: "/runtime.json",
    connections,
    extensions,
    secrets,
    createId: () => "connection_test",
    writeConfig: async () => { writes += 1; },
  });

  await assert.rejects(
    () => manager.create({
      extensionId: "test.publisher",
      displayName: "Bad",
      settings: { endpoint: "https://example.com", surprise: true },
      secrets: { token: "secret" },
    }),
    /Unknown connection setting: surprise/,
  );
  await assert.rejects(
    () => manager.create({
      extensionId: "test.publisher",
      displayName: "Missing secret",
      settings: { endpoint: "https://example.com" },
    }),
    /Token is required/,
  );
  assert.equal(writes, 0);
  assert.equal(vault.values.size, 0);
  assert.equal(connections.list().length, 0);
});
