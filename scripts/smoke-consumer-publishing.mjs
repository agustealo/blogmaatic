import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OperatorClient, OperatorClientError } from "../packages/operator-client/dist/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps", "runtime", "dist", "cli.js");
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-consumer-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-consumer-jekyll-"));
let runtime;

function appendOutput(state, chunk) {
  state.output = `${state.output}${chunk.toString("utf8")}`.slice(-120_000);
}

async function git(args) {
  const result = await execFileAsync("git", args, { cwd: repository, encoding: "utf8" });
  return result.stdout.trim();
}

function startRuntime() {
  const state = { exited: false, output: "" };
  const child = spawn(process.execPath, [cli, "start", "--data-dir", dataDir], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => appendOutput(state, chunk));
  child.stderr.on("data", (chunk) => appendOutput(state, chunk));
  child.once("exit", () => { state.exited = true; });
  return { child, state };
}

async function stopRuntime(handle) {
  if (!handle || handle.state.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveStop, rejectStop) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      rejectStop(new Error(`Runtime did not stop cleanly:\n${handle.state.output}`));
    }, 10_000);
    handle.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolveStop();
      else rejectStop(new Error(`Runtime exited unexpectedly (${signal ?? `code ${code}`}):\n${handle.state.output}`));
    });
  });
}

async function waitForHealth(state, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`Runtime exited before readiness:\n${state.output}`);
    try {
      const response = await fetch("http://127.0.0.1:4317/healthz", { redirect: "manual" });
      if (response.ok) return;
    } catch {
      // Runtime still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for runtime health:\n${state.output}`);
}

async function waitForResult(client, runId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await client.getRunResult(runId);
    } catch (error) {
      if (!(error instanceof OperatorClientError) || error.status !== 409) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for durable run ${runId}`);
}

try {
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Blogmaatic Consumer Burn"]);
  await git(["config", "user.email", "consumer-burn@example.test"]);
  await writeFile(join(repository, "_config.yml"), "title: Consumer Burn\n", "utf8");
  await git(["add", "_config.yml"]);
  await git(["commit", "-m", "seed consumer burn fixture"]);

  await execFileAsync(process.execPath, [cli, "init", "--data-dir", dataDir], { cwd: root, encoding: "utf8" });
  const token = (await execFileAsync(process.execPath, [cli, "token", "--data-dir", dataDir], {
    cwd: root,
    encoding: "utf8",
  })).stdout.trim();
  assert.ok(token.length >= 32);

  runtime = startRuntime();
  await waitForHealth(runtime.state);
  const client = new OperatorClient({ baseUrl: "http://127.0.0.1:4317", token });

  const connection = await client.createConnection({
    extensionId: "blogmaatic.jekyll-git",
    displayName: "Consumer Journal",
    status: "active",
    settings: {
      repositoryPath: repository,
      branch: "main",
      authorName: "Blogmaatic Consumer",
      authorEmail: "consumer@example.test",
      siteBaseUrl: "https://consumer.example.test",
    },
  });
  const health = await client.testConnection(connection.id);
  assert.equal(health.validation.valid, true);
  assert.notEqual(health.health?.state, "unhealthy");

  const group = await client.createPublicationGroup({
    name: "Consumer publishing",
    policySetId: "default",
    enabled: true,
    routes: [{
      id: "route-consumer-journal",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId: connection.id,
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
      variant: { layout: "post", permalink: "/consumer-ready/" },
    }],
  });
  assert.equal(group.enabled, true);

  const automation = await client.registerAutomation({
    id: "automation-consumer-manual",
    version: 1,
    name: "Consumer manual publish",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId: group.group.id }],
  });
  assert.equal(automation.enabled, true);
  assert.equal(automation.definition.trigger.kind, "manual");

  const workspace = await client.createPublication({
    title: "Consumer ready publishing",
    summary: "A real Workspace publication used by the consumer Run Now release burn.",
    body: "This publication is persisted in the canonical Workspace before a manual Automation publishes it.",
    language: "en",
    tags: ["consumer", "release"],
    slug: "consumer-ready",
    canonicalUrl: "https://consumer.example.test/consumer-ready/",
    status: "approved",
  });
  assert.equal(workspace.publication.current.content.title, "Consumer ready publishing");

  const idempotencyKey = "consumer-run-now-proof";
  const runInput = {
    automationId: automation.definition.id,
    automationVersion: automation.definition.version,
    publication: workspace.publication,
    groups: [group.group],
  };
  const first = await client.startManualRun(runInput, idempotencyKey);
  const replay = await client.startManualRun(runInput, idempotencyKey);
  assert.equal(replay.runId, first.runId, "same consumer action must resolve to the same durable run");

  const result = await waitForResult(client, first.runId);
  assert.equal(result.outcome, "completed");
  assert.equal(result.publicationId, workspace.publication.id);

  const posts = await readdir(join(repository, "_posts"));
  assert.equal(posts.length, 1, "idempotent replay must not create a second post");
  const post = await readFile(join(repository, "_posts", posts[0]), "utf8");
  assert.match(post, /Consumer ready publishing/);
  assert.match(post, /This publication is persisted in the canonical Workspace/);
  const commitCount = Number(await git(["rev-list", "--count", "HEAD"]));
  assert.equal(commitCount, 2, "one seed commit plus exactly one consumer publication commit is expected");

  const stored = await client.getPublication(workspace.publication.id);
  assert.equal(stored.version, workspace.version);
  const durableRun = await client.getRun(first.runId);
  assert.equal(durableRun.dispatchState, "started");

  console.log(JSON.stringify({
    ok: true,
    publicationId: workspace.publication.id,
    automationId: automation.definition.id,
    groupId: group.group.id,
    runId: first.runId,
    post: posts[0],
  }));
} finally {
  await stopRuntime(runtime).catch(() => undefined);
  await Promise.all([
    rm(dataDir, { recursive: true, force: true }),
    rm(repository, { recursive: true, force: true }),
  ]);
}
