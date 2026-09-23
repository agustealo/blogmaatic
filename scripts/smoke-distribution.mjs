import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const archiveArg = process.argv[2];
if (!archiveArg) throw new Error("Usage: node scripts/smoke-distribution.mjs <artifact.tar.gz>");
const archive = resolve(archiveArg);

async function git(root, args) {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout.trim();
}

function cleanEnv(poisonBin) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  env.PATH = `${poisonBin}${delimiter}${env.PATH ?? ""}`;
  return env;
}

async function api(token, path, options = {}) {
  return fetch(`http://127.0.0.1:4317${path}`, {
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
    throw new Error(`Expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

async function waitForHttp(url, processState, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.exited) throw new Error(`Packaged runtime exited before readiness:\n${processState.output}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return response;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for packaged runtime at ${url}:\n${processState.output}`);
}

async function controlRoomSession(processState, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.exited) throw new Error(`Packaged runtime exited before Control Room session bootstrap:\n${processState.output}`);
    const match = processState.output.match(/Control Room: (http:\/\/[^\s]+)/);
    if (match?.[1]) {
      const launchAddress = match[1];
      const response = await fetch(launchAddress, {
        redirect: "manual",
        headers: { "sec-fetch-site": "none" },
      });
      assert.equal(response.status, 303, `Control Room bootstrap returned ${response.status}: ${await response.text()}`);
      const setCookie = response.headers.get("set-cookie");
      const location = response.headers.get("location");
      assert.ok(setCookie, "Control Room bootstrap did not set a session cookie");
      assert.ok(location, "Control Room bootstrap did not return a redirect location");
      const origin = new URL(launchAddress).origin;
      const proof = new URL(location, origin).hash.replace(/^#session=/, "");
      assert.match(proof, /^[A-Za-z0-9_-]{32,128}$/);
      return { origin, cookie: setCookie.split(";", 1)[0], proof };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for the Control Room launch URL:\n${processState.output}`);
}

async function controlRoomApi(session, path, options = {}) {
  return fetch(`${session.origin}/api${path}`, {
    ...options,
    headers: {
      cookie: session.cookie,
      "x-blogmaatic-session-proof": session.proof,
      origin: session.origin,
      "sec-fetch-site": "same-origin",
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
}

async function terminalResult(token, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await api(token, `/v1/runs/${encodeURIComponent(runId)}/result`);
    if (response.status === 200) return response.json();
    if (response.status !== 409) throw new Error(`Unexpected result status ${response.status}: ${await response.text()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${runId}`);
}

function startPackagedRuntime(binary, dataDir, cwd, env) {
  const state = { exited: false, output: "" };
  const child = spawn(binary, ["start", "--data-dir", dataDir], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const append = (chunk) => { state.output = `${state.output}${chunk.toString("utf8")}`.slice(-128_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("exit", () => { state.exited = true; });
  return { child, state };
}

async function stopPackagedRuntime(handle) {
  if (handle.state.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      reject(new Error(`Packaged runtime did not stop cleanly:\n${handle.state.output}`));
    }, 10_000);
    handle.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolveExit();
      else reject(new Error(`Packaged runtime stopped unexpectedly (${signal ?? `code ${code}`}):\n${handle.state.output}`));
    });
  });
}

function publication() {
  return {
    id: "pub-distribution-proof",
    createdAt: "2026-09-23T06:45:00.000Z",
    slug: "distribution-proof",
    status: "approved",
    current: {
      id: "rev-distribution-proof-1",
      ordinal: 1,
      createdAt: "2026-09-23T06:45:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Distribution Proof",
        language: "en",
        blocks: [
          { id: "heading", kind: "heading", data: { level: 2, text: "Installed, not cloned" } },
          { id: "paragraph", kind: "paragraph", data: { text: "This publication was created by the packaged Blogmaatic runtime." } },
        ],
        assets: [],
        tags: ["distribution", "proof"],
        attributes: {},
      },
    },
    canonicalUrl: "https://example.test/distribution-proof/",
    provenance: { source: "distribution-smoke" },
  };
}

function groupCreateBody(connectionId) {
  return {
    name: "Distribution proof",
    policySetId: "default",
    enabled: true,
    routes: [{
      id: "jekyll-distribution-proof",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId,
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
      variant: { layout: "post", permalink: "/distribution-proof/" },
    }],
  };
}

function automation(groupId) {
  return {
    id: "distribution-proof",
    version: 1,
    name: "Distribution proof",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId }],
  };
}

const extractionRoot = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-extract-"));
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-jekyll-"));
const callerRoot = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-caller-"));
const poisonBin = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-poison-"));
let first;
let second;

try {
  await execFileAsync("tar", ["-xzf", archive, "-C", extractionRoot]);
  const roots = (await readdir(extractionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(roots.length, 1, `Expected one packaged root in ${basename(archive)}`);
  const installRoot = join(extractionRoot, roots[0].name);
  const binary = join(installRoot, "bin", "blogmaatic");
  const packagedManifest = JSON.parse(await readFile(join(installRoot, "package.json"), "utf8"));
  const expectedVersion = String(packagedManifest.version ?? "");
  assert.match(expectedVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Packaged product version is not valid SemVer");

  const poisonedNode = join(poisonBin, "node");
  await writeFile(poisonedNode, "#!/bin/sh\necho 'host node must not be used' >&2\nexit 86\n", { mode: 0o755 });
  await chmod(poisonedNode, 0o755);

  const callerBin = join(callerRoot, "node_modules", ".bin");
  await mkdir(callerBin, { recursive: true });
  for (const name of ["restate", "restate-server"]) {
    const fake = join(callerBin, name);
    await writeFile(fake, `#!/bin/sh\necho 'caller ${name} must not be used' >&2\nexit 87\n`, { mode: 0o755 });
    await chmod(fake, 0o755);
  }
  const env = cleanEnv(poisonBin);

  const help = await execFileAsync(binary, ["help"], { cwd: callerRoot, env, encoding: "utf8" });
  assert.match(help.stdout, /Blogmaatic runtime/);
  const version = await execFileAsync(binary, ["version"], { cwd: callerRoot, env, encoding: "utf8" });
  assert.equal(version.stdout.trim(), expectedVersion);

  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Distribution Fixture"]);
  await git(repository, ["config", "user.email", "distribution-fixture@example.test"]);
  await writeFile(join(repository, "_config.yml"), "title: Distribution Fixture\n");
  await git(repository, ["add", "_config.yml"]);
  await git(repository, ["commit", "-m", "seed"]);

  // Initialize genuinely fresh app data. Publisher state is created later through
  // the same Operator API used by the bundled first-run Control Room.
  await execFileAsync(binary, ["init", "--data-dir", dataDir], {
    cwd: callerRoot,
    env,
    encoding: "utf8",
  });

  const doctorResult = await execFileAsync(binary, ["doctor", "--data-dir", dataDir, "--json"], { cwd: callerRoot, env, encoding: "utf8" });
  const doctor = JSON.parse(doctorResult.stdout);
  assert.equal(doctor.ok, true, JSON.stringify(doctor, null, 2));
  assert.ok(doctor.checks.some((check) => check.name === "restate-server" && check.ok));
  assert.ok(doctor.checks.some((check) => check.name === "control-room" && check.ok));
  assert.ok(doctor.checks.some((check) => check.name === "config" && /0 configured connection/.test(check.detail)));

  const tokenResult = await execFileAsync(binary, ["token", "--data-dir", dataDir], { cwd: callerRoot, env, encoding: "utf8" });
  const token = tokenResult.stdout.trim();
  assert.ok(token.length >= 32, "Packaged runtime did not return its operator token");

  first = startPackagedRuntime(binary, dataDir, callerRoot, env);
  assert.equal((await waitForHttp("http://127.0.0.1:4317/healthz", first.state)).status, 200);
  const controlRoom = await waitForHttp("http://127.0.0.1:4320/", first.state);
  assert.match(await controlRoom.text(), /Blogmaatic Control Room/);

  const session = await controlRoomSession(first.state);
  const emptyConnections = await controlRoomApi(session, "/v1/connections");
  await expectStatus(emptyConnections, 200);
  assert.equal((await emptyConnections.json()).items.length, 0);
  assert.equal(emptyConnections.headers.get("cache-control"), "no-store");

  const connectionResponse = await api(token, "/v1/connections", {
    method: "POST",
    body: JSON.stringify({
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Packaged Jekyll",
      status: "active",
      settings: {
        repositoryPath: repository,
        branch: "main",
        authorName: "Blogmaatic Distribution",
        authorEmail: "distribution@example.test",
        siteBaseUrl: "https://example.test",
      },
    }),
  });
  await expectStatus(connectionResponse, 201);
  const managedConnection = await connectionResponse.json();
  assert.match(managedConnection.id, /^connection_[0-9a-f-]{36}$/);
  assert.equal(managedConnection.extensionId, "blogmaatic.jekyll-git");

  const connectionTest = await api(token, `/v1/connections/${encodeURIComponent(managedConnection.id)}/test`, { method: "POST" });
  await expectStatus(connectionTest, 200);
  const connectionHealth = await connectionTest.json();
  assert.equal(connectionHealth.validation.valid, true);
  assert.notEqual(connectionHealth.health?.state, "unhealthy");

  const groupOptionsResponse = await api(token, "/v1/publication-group-options");
  await expectStatus(groupOptionsResponse, 200);
  const groupOptions = await groupOptionsResponse.json();
  assert.ok(groupOptions.policySetIds.includes("default"));

  const groupRegistration = await api(token, "/v1/publication-groups", {
    method: "POST",
    body: JSON.stringify(groupCreateBody(managedConnection.id)),
  });
  await expectStatus(groupRegistration, 201);
  const managedGroup = await groupRegistration.json();
  assert.match(managedGroup.group.id, /^group_[0-9a-f-]{36}$/);
  assert.equal(managedGroup.enabled, true);
  assert.equal(managedGroup.version, 1);

  const registration = await api(token, "/v1/automations", {
    method: "POST",
    body: JSON.stringify(automation(managedGroup.group.id)),
  });
  await expectStatus(registration, 201);

  const setupConnections = await controlRoomApi(session, "/v1/connections");
  await expectStatus(setupConnections, 200);
  assert.equal((await setupConnections.json()).items.length, 1);
  const setupGroups = await controlRoomApi(session, "/v1/publication-groups?enabled=true&limit=10");
  await expectStatus(setupGroups, 200);
  assert.equal((await setupGroups.json()).items[0].group.id, managedGroup.group.id);
  const setupAutomations = await controlRoomApi(session, "/v1/automations?enabled=true&limit=10");
  await expectStatus(setupAutomations, 200);
  assert.equal((await setupAutomations.json()).items[0].definition.id, "distribution-proof");

  const launch = await api(token, "/v1/runs/manual", {
    method: "POST",
    headers: { "idempotency-key": "distribution-proof-1" },
    body: JSON.stringify({
      automationId: "distribution-proof",
      publication: publication(),
      groups: [managedGroup.group],
    }),
  });
  await expectStatus(launch, 202);
  const run = await launch.json();
  assert.equal(run.dispatchState, "started");

  const result = await terminalResult(token, run.runId);
  assert.equal(result.outcome, "completed");
  assert.equal(result.stepResults[0].receipts[0].status, "verified");
  const trackedPosts = (await git(repository, ["ls-files", "_posts/*.md"])).split("\n").filter(Boolean);
  assert.equal(trackedPosts.length, 1);
  assert.match(await readFile(join(repository, trackedPosts[0]), "utf8"), /Installed, not cloned/);
  assert.equal(await git(repository, ["rev-list", "--count", "HEAD"]), "2");

  await stopPackagedRuntime(first);
  first = undefined;

  second = startPackagedRuntime(binary, dataDir, callerRoot, env);
  await waitForHttp("http://127.0.0.1:4317/healthz", second.state);

  const restoredConnection = await api(token, `/v1/connections/${encodeURIComponent(managedConnection.id)}`);
  await expectStatus(restoredConnection, 200);
  assert.equal((await restoredConnection.json()).displayName, "Packaged Jekyll");
  const restoredGroup = await api(token, `/v1/publication-groups/${encodeURIComponent(managedGroup.group.id)}`);
  await expectStatus(restoredGroup, 200);
  assert.equal((await restoredGroup.json()).version, 1);
  const restoredAutomations = await api(token, "/v1/automations?enabled=true&limit=10");
  await expectStatus(restoredAutomations, 200);
  assert.equal((await restoredAutomations.json()).items.some((entry) => entry.definition.id === "distribution-proof"), true);

  const restored = await api(token, `/v1/runs/${encodeURIComponent(run.runId)}`);
  await expectStatus(restored, 200);
  assert.equal((await restored.json()).runtimePhase, "completed");
  assert.equal((await terminalResult(token, run.runId)).outcome, "completed");
  assert.equal(await git(repository, ["rev-list", "--count", "HEAD"]), "2");

  console.log(`Distribution first-run + restart smoke passed: ${basename(archive)}`);
} finally {
  if (second) await stopPackagedRuntime(second).catch(() => undefined);
  if (first) await stopPackagedRuntime(first).catch(() => undefined);
  await Promise.all([extractionRoot, dataDir, repository, callerRoot, poisonBin].map((path) => rm(path, { recursive: true, force: true })));
}
