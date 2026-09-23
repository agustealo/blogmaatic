import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ConnectionAuthority, ExtensionRuntime } from "../packages/extension-sdk/dist/index.js";
import {
  LinuxSecretServiceBackend,
  MacOsKeychainBackend,
  OsCredentialSecretProvider,
  SecretAuthority,
} from "../packages/secrets/dist/index.js";
import { ConnectionManager, defaultRuntimeConfig } from "../apps/runtime/dist/index.js";

const exec = promisify(execFile);
const locator = `ci/${process.platform}/${process.arch}/${randomBytes(12).toString("hex")}`;
const secret = `vault-smoke-${randomBytes(24).toString("base64url")}`;

async function roundTrip(provider) {
  const authority = new SecretAuthority([provider]);
  const reference = `vault:${locator}`;
  await authority.storeUtf8(reference, secret);
  const actual = await authority.withUtf8(reference, (value) => value);
  assert.equal(actual, secret);
  assert.equal(await authority.delete(reference), true);
  await assert.rejects(authority.withUtf8(reference, () => undefined), /vault:\[redacted\]/);
}

function managedPublisher(secrets) {
  return {
    manifest: {
      apiVersion: 1,
      kind: "publisher",
      connectionSchemaVersion: 1,
      id: "ci.vault-publisher",
      displayName: "CI Vault Publisher",
      version: "1.0.0",
      capabilities: ["article.create"],
    },
    async validateConnection(connection) {
      const errors = [];
      if (connection.settings.endpoint !== "https://example.test") errors.push("endpoint is invalid");
      if (!connection.secretRefs.token) errors.push("token is required");
      return { valid: errors.length === 0, errors };
    },
    async checkHealth(connection) {
      const tokenRef = connection.secretRefs.token;
      if (!tokenRef) {
        return { state: "unhealthy", checkedAt: new Date().toISOString(), detail: "Credential reference is missing" };
      }
      const readable = await secrets.withUtf8(tokenRef, (value) => value.startsWith("managed-vault-"));
      return {
        state: readable ? "healthy" : "unhealthy",
        checkedAt: new Date().toISOString(),
        detail: readable ? "Managed credential is readable" : "Managed credential is invalid",
      };
    },
    async compile() { throw new Error("not used"); },
    async deliver() { throw new Error("not used"); },
    async inspect() { throw new Error("not used"); },
  };
}

const managedContract = {
  schemaVersion: 1,
  settingsFields: [
    { key: "endpoint", label: "Endpoint", kind: "url", required: true },
  ],
  secretFields: [
    { key: "token", label: "Token", required: true },
  ],
  defaultRoute: {
    channel: "posts",
    requiredCapabilities: ["article.create"],
  },
};

async function managedConnectionLifecycle(provider) {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-managed-vault-smoke-"));
  const configPath = join(root, "runtime.json");
  const secrets = new SecretAuthority([provider]);
  const connections = new ConnectionAuthority();
  const extensions = new ExtensionRuntime(connections);
  extensions.registerPublisher(managedPublisher(secrets), managedContract);
  const connectionId = `connection_ci_${randomBytes(8).toString("hex")}`;
  const manager = new ConnectionManager({
    config: defaultRuntimeConfig(),
    configPath,
    connections,
    extensions,
    secrets,
    createId: () => connectionId,
  });
  const createdReferences = new Set();

  try {
    const firstSecret = `managed-vault-${randomBytes(24).toString("base64url")}`;
    const created = await manager.create({
      extensionId: "ci.vault-publisher",
      displayName: "CI managed vault",
      settings: { endpoint: "https://example.test" },
      secrets: { token: firstSecret },
    });
    assert.equal(created.id, connectionId);
    assert.deepEqual(created.configuredSecrets, ["token"]);
    assert.equal(JSON.stringify(created).includes(firstSecret), false);

    const firstReference = connections.get(connectionId).secretRefs.token;
    createdReferences.add(firstReference);
    assert.match(firstReference, new RegExp(`^vault:connection/${connectionId}/token/`));
    assert.equal(await secrets.withUtf8(firstReference, (value) => value), firstSecret);
    assert.equal((await manager.test(connectionId)).health?.state, "healthy");

    const persistedAfterCreate = await readFile(configPath, "utf8");
    assert.equal(persistedAfterCreate.includes(firstSecret), false);
    assert.ok(persistedAfterCreate.includes(firstReference));

    const secondSecret = `managed-vault-${randomBytes(24).toString("base64url")}`;
    const updated = await manager.update(connectionId, { secrets: { token: secondSecret } });
    assert.deepEqual(updated.configuredSecrets, ["token"]);
    const secondReference = connections.get(connectionId).secretRefs.token;
    createdReferences.add(secondReference);
    assert.notEqual(secondReference, firstReference);
    assert.equal(await secrets.withUtf8(secondReference, (value) => value), secondSecret);
    await assert.rejects(secrets.withUtf8(firstReference, () => undefined), /vault:\[redacted\]/);
    assert.equal((await manager.test(connectionId)).health?.state, "healthy");

    const persistedAfterRotation = await readFile(configPath, "utf8");
    assert.equal(persistedAfterRotation.includes(secondSecret), false);
    assert.equal(persistedAfterRotation.includes(firstReference), false);
    assert.ok(persistedAfterRotation.includes(secondReference));

    const removed = await manager.remove(connectionId);
    assert.equal(removed.id, connectionId);
    assert.equal(manager.list().length, 0);
    await assert.rejects(secrets.withUtf8(secondReference, () => undefined), /vault:\[redacted\]/);
    const persistedAfterRemoval = await readFile(configPath, "utf8");
    assert.equal(persistedAfterRemoval.includes(secondReference), false);
  } finally {
    for (const reference of createdReferences) {
      await secrets.delete(reference).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function burn(provider) {
  await roundTrip(provider);
  await managedConnectionLifecycle(provider);
}

if (process.platform === "darwin") {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-vault-smoke-"));
  const keychain = join(root, "blogmaatic-ci.keychain-db");
  const password = randomBytes(24).toString("base64url");
  try {
    await exec("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    await exec("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    await exec("/usr/bin/security", ["set-keychain-settings", "-lut", "3600", keychain]);
    await burn(new OsCredentialSecretProvider(new MacOsKeychainBackend({ keychain })));
  } finally {
    await exec("/usr/bin/security", ["delete-keychain", keychain]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
} else if (process.platform === "linux") {
  await burn(new OsCredentialSecretProvider(new LinuxSecretServiceBackend()));
} else {
  throw new Error(`Credential vault smoke is unsupported on ${process.platform}`);
}

console.log(`OS credential vault + managed connection smoke passed on ${process.platform}/${process.arch}`);
