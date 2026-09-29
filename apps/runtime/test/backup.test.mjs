import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRuntimeStopped,
  createBackup,
  defaultRuntimeConfig,
  restoreBackup,
  runtimePaths,
  verifyBackup,
  writeRuntimeConfig,
} from "../dist/index.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function testConfig() {
  const [operatorPort, controlRoomPort, workflowPort, ingressPort, adminPort] = await Promise.all([
    freePort(), freePort(), freePort(), freePort(), freePort(),
  ]);
  const base = defaultRuntimeConfig();
  return {
    ...base,
    operator: { ...base.operator, port: operatorPort },
    controlRoom: { ...base.controlRoom, port: controlRoomPort },
    restate: {
      ...base.restate,
      mode: "external",
      ingressUrl: `http://127.0.0.1:${ingressPort}`,
      adminUrl: `http://127.0.0.1:${adminPort}`,
      workflowPort,
    },
  };
}

async function seedDataDirectory(root, config) {
  const paths = runtimePaths(root);
  await writeRuntimeConfig(paths.configPath, config);
  await writeFile(paths.controlPlanePath, "control-plane-state", "utf8");
  await writeFile(paths.projectionStatePath, "projection-state", "utf8");
  await mkdir(paths.restateDataDir, { recursive: true });
  await writeFile(join(paths.restateDataDir, "durable.bin"), "restate-state", "utf8");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(paths.operatorTokenPath, "operator-secret-that-must-not-be-backed-up", "utf8");
  return paths;
}

test("offline backup excludes credentials, verifies integrity, and restores durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-backup-test-"));
  try {
    const source = join(root, "source");
    const backup = join(root, "backup");
    const target = join(root, "restored");
    const config = await testConfig();
    const sourcePaths = await seedDataDirectory(source, config);

    const manifest = await createBackup(source, backup, new Date("2026-09-29T04:00:00.000Z"));
    assert.equal(manifest.includesSecrets, false);
    assert.equal(manifest.createdAt, "2026-09-29T04:00:00.000Z");
    assert.ok(manifest.files.some((entry) => entry.path === "runtime.json"));
    assert.ok(manifest.files.some((entry) => entry.path === "control-plane.sqlite"));
    assert.ok(manifest.files.some((entry) => entry.path === "projection-state.sqlite"));
    assert.ok(manifest.files.some((entry) => entry.path === "restate/durable.bin"));
    assert.equal(manifest.files.some((entry) => entry.path.includes("secret")), false);

    const verified = await verifyBackup(backup);
    assert.deepEqual(verified, manifest);

    const restored = await restoreBackup(backup, target);
    assert.equal(restored.dataDir, target);
    assert.equal(restored.safetyCopy, undefined);
    const targetPaths = runtimePaths(target);
    assert.equal(await readFile(targetPaths.controlPlanePath, "utf8"), "control-plane-state");
    assert.equal(await readFile(targetPaths.projectionStatePath, "utf8"), "projection-state");
    assert.equal(await readFile(join(targetPaths.restateDataDir, "durable.bin"), "utf8"), "restate-state");
    await assert.rejects(readFile(targetPaths.operatorTokenPath, "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(sourcePaths.operatorTokenPath, "utf8"), "operator-secret-that-must-not-be-backed-up");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup verification fails closed after durable state is tampered", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-backup-tamper-"));
  try {
    const source = join(root, "source");
    const backup = join(root, "backup");
    await seedDataDirectory(source, await testConfig());
    await createBackup(source, backup);
    await writeFile(join(backup, "state", "control-plane.sqlite"), "tampered", "utf8");
    await assert.rejects(verifyBackup(backup), /integrity check failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replace restore preserves the previous data directory as a safety copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-restore-replace-"));
  try {
    const source = join(root, "source");
    const backup = join(root, "backup");
    const target = join(root, "target");
    await seedDataDirectory(source, await testConfig());
    await createBackup(source, backup);

    await seedDataDirectory(target, await testConfig());
    await writeFile(join(target, "consumer-note.txt"), "keep me safe", "utf8");
    const restored = await restoreBackup(backup, target, { replace: true });
    assert.ok(restored.safetyCopy);
    assert.equal(await readFile(join(restored.safetyCopy, "consumer-note.txt"), "utf8"), "keep me safe");
    assert.equal(await readFile(runtimePaths(target).controlPlanePath, "utf8"), "control-plane-state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup refuses to snapshot while a configured local runtime port is accepting connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-backup-live-"));
  const server = createServer();
  try {
    const source = join(root, "source");
    const backup = join(root, "backup");
    const config = await testConfig();
    await seedDataDirectory(source, config);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.operator.port, "127.0.0.1", resolve);
    });
    await assert.rejects(createBackup(source, backup), /requires the runtime to be stopped/);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
