import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  configForFirstRun,
  ensureOperatorToken,
  isTcpOpen,
  runtimePaths,
  startRuntime,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function distinctFreePorts(count) {
  const ports = [];
  while (ports.length < count) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function jekyllRepository() {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-runtime-jekyll-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Runtime Fixture"]);
  await git(root, ["config", "user.email", "runtime-fixture@example.test"]);
  await writeFile(join(root, "_config.yml"), "title: Runtime Fixture\n");
  await git(root, ["add", "_config.yml"]);
  await git(root, ["commit", "-m", "seed"]);
  return root;
}

function publication() {
  return {
    id: "pub-runtime-proof",
    createdAt: "2026-09-23T01:15:00.000Z",
    slug: "runtime-proof",
    status: "approved",
    current: {
      id: "rev-runtime-proof-1",
      ordinal: 1,
      createdAt: "2026-09-23T01:15:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Runtime Proof",
        language: "en",
        blocks: [
          { id: "heading", kind: "heading", data: { level: 2, text: "One local runtime" } },
          { id: "paragraph", kind: "paragraph", data: { text: "Operator API to Restate to Jekyll, with no fake publisher in the middle." } },
        ],
        assets: [],
        tags: ["runtime", "proof"],
        attributes: {},
      },
    },
    canonicalUrl: "https://example.test/runtime-proof/",
    provenance: { source: "managed-runtime-integration" },
  };
}

function group() {
  return {
    id: "group-runtime-proof",
    name: "Runtime proof publication",
    policySetId: "default",
    routes: [{
      id: "jekyll-runtime-proof",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId: "jekyll-primary",
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.update", "article.inspect"],
      variant: { layout: "post", permalink: "/runtime-proof/" },
    }],
  };
}

function automation() {
  return {
    id: "runtime-proof",
    version: 1,
    name: "Runtime proof",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId: "group-runtime-proof" }],
  };
}

async function api(origin, token, path, options = {}) {
  return fetch(`${origin}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
}

async function expectStatus(response, expected) {
  if (response.status !== expected) {
    assert.fail(`Expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

async function terminalResult(origin, token, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await api(origin, token, `/v1/runs/${encodeURIComponent(runId)}/result`);
    if (response.status === 200) return response.json();
    if (response.status !== 409) {
      throw new Error(`Unexpected run result response ${response.status}: ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId} to become terminal`);
}

test("managed runtime publishes through Restate and survives a full restart", {
  skip: process.platform !== "linux" && process.platform !== "darwin",
  timeout: 60_000,
}, async (t) => {
  if (process.env.CI !== "true") {
    const managedPortsOccupied = await Promise.all([8080, 9070, 9071].map((port) => isTcpOpen("127.0.0.1", port)));
    if (managedPortsOccupied.some(Boolean)) {
      t.skip("A local Restate process already owns a managed runtime port");
      return;
    }
  }

  const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-runtime-state-"));
  const repository = await jekyllRepository();
  const paths = runtimePaths(dataDir);
  let first;
  let second;

  try {
    const discovered = await configForFirstRun({
      jekyllRepository: repository,
      authorName: "Blogmaatic Runtime",
      authorEmail: "runtime@example.test",
      siteBaseUrl: "https://example.test",
    });
    const [operatorPort, controlRoomPort, workflowPort] = await distinctFreePorts(3);
    const config = {
      ...discovered,
      operator: { ...discovered.operator, port: operatorPort },
      controlRoom: { ...discovered.controlRoom, port: controlRoomPort },
      restate: { ...discovered.restate, workflowPort },
      scheduler: { ...discovered.scheduler, pollMs: 1000 },
    };
    const credential = await ensureOperatorToken(paths.operatorTokenPath);

    first = await startRuntime({
      config,
      paths,
      operatorToken: credential.token,
      logger: { info: () => undefined, error: () => undefined },
    });

    const controlRoom = await fetch(first.controlRoomAddress);
    await expectStatus(controlRoom, 200);
    assert.match(await controlRoom.text(), /Blogmaatic Control Room/);

    const registration = await api(first.operatorAddress, credential.token, "/v1/automations", {
      method: "POST",
      body: JSON.stringify(automation()),
    });
    await expectStatus(registration, 201);

    const launch = await api(first.operatorAddress, credential.token, "/v1/runs/manual", {
      method: "POST",
      headers: { "idempotency-key": "managed-runtime-proof-1" },
      body: JSON.stringify({
        automationId: "runtime-proof",
        publication: publication(),
        groups: [group()],
      }),
    });
    await expectStatus(launch, 202);
    const run = await launch.json();
    assert.equal(run.dispatchState, "started");

    const result = await terminalResult(first.operatorAddress, credential.token, run.runId);
    assert.equal(result.outcome, "completed");
    assert.equal(result.stepResults[0].outcome, "verified");
    assert.equal(result.stepResults[0].receipts[0].status, "verified");

    const trackedPosts = (await git(repository, ["ls-files", "_posts/*.md"])).split("\n").filter(Boolean);
    assert.equal(trackedPosts.length, 1);
    const post = await readFile(join(repository, trackedPosts[0]), "utf8");
    assert.match(post, /title: "Runtime Proof"/);
    assert.match(post, /Operator API to Restate to Jekyll/);
    assert.equal(await git(repository, ["rev-list", "--count", "HEAD"]), "2");

    const proxiedRun = await api(first.controlRoomAddress, credential.token, `/api/v1/runs/${encodeURIComponent(run.runId)}`);
    await expectStatus(proxiedRun, 200);

    await first.close();
    first = undefined;

    second = await startRuntime({
      config,
      paths,
      operatorToken: credential.token,
      logger: { info: () => undefined, error: () => undefined },
    });
    const restored = await api(second.operatorAddress, credential.token, `/v1/runs/${encodeURIComponent(run.runId)}`);
    await expectStatus(restored, 200);
    const restoredRun = await restored.json();
    assert.equal(restoredRun.runId, run.runId);
    assert.equal(restoredRun.runtimePhase, "completed");

    const restoredResult = await terminalResult(second.operatorAddress, credential.token, run.runId);
    assert.equal(restoredResult.outcome, "completed");
    assert.equal(await git(repository, ["rev-list", "--count", "HEAD"]), "2");
  } finally {
    if (second) await second.close().catch(() => undefined);
    if (first) await first.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    await rm(repository, { recursive: true, force: true });
  }
});
