import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageArg = process.argv[2];
if (!packageArg) throw new Error("Usage: node scripts/smoke-native-package.mjs <package>");
const packagePath = resolve(packageArg);
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-native-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-native-jekyll-"));
let runtime;

async function exec(file, args, options = {}) {
  return execFileAsync(file, args, { encoding: "utf8", ...options });
}

async function git(args) {
  return (await exec("git", args, { cwd: repository })).stdout.trim();
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

async function install() {
  if (process.platform === "linux") {
    assert.match(basename(packagePath), /\.deb$/);
    await exec("sudo", ["dpkg", "-i", packagePath]);
  } else if (process.platform === "darwin") {
    assert.match(basename(packagePath), /\.pkg$/);
    await exec("sudo", ["installer", "-pkg", packagePath, "-target", "/"]);
  } else {
    throw new Error(`Native installer smoke is unsupported on ${process.platform}`);
  }
}

async function cleanupInstall() {
  if (process.platform === "linux") {
    await exec("sudo", ["dpkg", "-r", "blogmaatic"]).catch(() => undefined);
  } else if (process.platform === "darwin") {
    await exec("sudo", ["rm", "-f", "/usr/local/bin/blogmaatic"]).catch(() => undefined);
    await exec("sudo", ["rm", "-rf", "/opt/blogmaatic"]).catch(() => undefined);
    await exec("sudo", ["pkgutil", "--forget", "com.blogmaatic.runtime"]).catch(() => undefined);
  }
}

function requireDoctorCheck(report, name) {
  const check = Array.isArray(report.checks) ? report.checks.find((candidate) => candidate?.name === name) : undefined;
  assert.ok(check, `Doctor report is missing ${name}: ${JSON.stringify(report)}`);
  assert.equal(check.ok, true, `${name} failed: ${check.detail ?? "no detail"}`);
  return check;
}

async function verifyMacNodeSigning() {
  const node = "/opt/blogmaatic/bin/node";
  await exec("codesign", ["--verify", "--strict", "--verbose=2", node]);
  const details = await exec("codesign", ["--display", "--verbose=4", "--entitlements", ":-", node]);
  const diagnostic = `${details.stdout}\n${details.stderr}`;
  assert.match(diagnostic, /runtime/i, `Bundled Node is not Hardened Runtime signed: ${diagnostic}`);
  assert.match(diagnostic, /com\.apple\.security\.cs\.allow-jit/, `Bundled Node lacks JIT entitlement: ${diagnostic}`);
}

function startInstalledRuntime(binary) {
  const state = { exited: false, output: "" };
  const child = spawn(binary, ["start", "--data-dir", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    state.output = `${state.output}${chunk.toString("utf8")}`.slice(-128_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("exit", () => { state.exited = true; });
  return { child, state };
}

async function waitForHttp(url, state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`Installed Blogmaatic exited before readiness:\n${state.output}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return response;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for installed Blogmaatic at ${url}:\n${state.output}`);
}

async function controlRoomSession(state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`Installed Blogmaatic exited before Control Room session bootstrap:\n${state.output}`);
    const match = state.output.match(/Control Room: (http:\/\/[^\s]+)/);
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
      assert.ok(location, "Control Room bootstrap did not return a session-proof redirect");
      const origin = new URL(launchAddress).origin;
      const proof = new URL(location, origin).hash.replace(/^#session=/, "");
      assert.match(proof, /^[A-Za-z0-9_-]{32,128}$/);
      return {
        origin,
        cookie: setCookie.split(";", 1)[0],
        proof,
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for the Control Room launch URL:\n${state.output}`);
}

async function controlRoomApi(session, path) {
  return fetch(`${session.origin}/api${path}`, {
    headers: {
      cookie: session.cookie,
      "x-blogmaatic-session-proof": session.proof,
      origin: session.origin,
      "sec-fetch-site": "same-origin",
      accept: "application/json",
    },
  });
}

async function stopInstalledRuntime(handle) {
  if (!handle || handle.state.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      reject(new Error(`Installed Blogmaatic did not stop cleanly:\n${handle.state.output}`));
    }, 10_000);
    handle.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolveExit();
      else reject(new Error(`Installed Blogmaatic stopped unexpectedly (${signal ?? `code ${code}`}):\n${handle.state.output}`));
    });
  });
}

function groupBody(connectionId) {
  return {
    name: "Native package publishing",
    policySetId: "default",
    enabled: true,
    routes: [{
      id: "native-jekyll",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId,
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
}

function automation(groupId) {
  return {
    id: "native-package-first-run",
    version: 1,
    name: "Native package first run",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId }],
  };
}

try {
  await install();
  if (process.platform === "darwin") await verifyMacNodeSigning();

  const binary = "/usr/local/bin/blogmaatic";
  const version = (await exec(binary, ["version"])).stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Native Package Fixture"]);
  await git(["config", "user.email", "native-package@example.test"]);
  await writeFile(join(repository, "_config.yml"), "title: Native Package Fixture\n");
  await git(["add", "_config.yml"]);
  await git(["commit", "-m", "seed"]);

  // Start from empty publisher state, matching the consumer first-run path.
  await exec(binary, ["init", "--data-dir", dataDir]);

  const doctor = await exec(binary, ["doctor", "--json", "--data-dir", dataDir]);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true, JSON.stringify(report));
  for (const name of ["product", "config", "operator-credential", "control-room", "restate-server", "restate-cli"]) {
    requireDoctorCheck(report, name);
  }
  assert.match(requireDoctorCheck(report, "config").detail, /0 configured connection/);

  const token = (await exec(binary, ["token", "--data-dir", dataDir])).stdout.trim();
  assert.ok(token.length >= 32);

  runtime = startInstalledRuntime(binary);
  assert.equal((await waitForHttp("http://127.0.0.1:4317/healthz", runtime.state)).status, 200);
  const controlRoom = await waitForHttp("http://127.0.0.1:4320/", runtime.state);
  assert.match(await controlRoom.text(), /Blogmaatic Control Room/);

  const session = await controlRoomSession(runtime.state);
  const emptyConnections = await controlRoomApi(session, "/v1/connections");
  await expectStatus(emptyConnections, 200);
  assert.equal((await emptyConnections.json()).items.length, 0);
  assert.equal(emptyConnections.headers.get("cache-control"), "no-store");

  const connectionResponse = await api(token, "/v1/connections", {
    method: "POST",
    body: JSON.stringify({
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Native Jekyll",
      status: "active",
      settings: {
        repositoryPath: repository,
        branch: "main",
        authorName: "Blogmaatic Native Package",
        authorEmail: "native-package@example.test",
        siteBaseUrl: "https://example.test",
      },
    }),
  });
  await expectStatus(connectionResponse, 201);
  const connection = await connectionResponse.json();

  const connectionTest = await api(token, `/v1/connections/${encodeURIComponent(connection.id)}/test`, { method: "POST" });
  await expectStatus(connectionTest, 200);
  const health = await connectionTest.json();
  assert.equal(health.validation.valid, true);
  assert.notEqual(health.health?.state, "unhealthy");

  const optionsResponse = await api(token, "/v1/publication-group-options");
  await expectStatus(optionsResponse, 200);
  assert.ok((await optionsResponse.json()).policySetIds.includes("default"));

  const groupResponse = await api(token, "/v1/publication-groups", {
    method: "POST",
    body: JSON.stringify(groupBody(connection.id)),
  });
  await expectStatus(groupResponse, 201);
  const group = await groupResponse.json();

  const automationResponse = await api(token, "/v1/automations", {
    method: "POST",
    body: JSON.stringify(automation(group.group.id)),
  });
  await expectStatus(automationResponse, 201);

  const proxiedGroups = await controlRoomApi(session, "/v1/publication-groups?enabled=true&limit=10");
  await expectStatus(proxiedGroups, 200);
  assert.equal((await proxiedGroups.json()).items[0].group.id, group.group.id);
  const proxiedAutomations = await controlRoomApi(session, "/v1/automations?enabled=true&limit=10");
  await expectStatus(proxiedAutomations, 200);
  assert.equal((await proxiedAutomations.json()).items[0].definition.id, "native-package-first-run");

  await stopInstalledRuntime(runtime);
  runtime = undefined;

  runtime = startInstalledRuntime(binary);
  await waitForHttp("http://127.0.0.1:4317/healthz", runtime.state);
  const restoredConnection = await api(token, `/v1/connections/${encodeURIComponent(connection.id)}`);
  await expectStatus(restoredConnection, 200);
  assert.equal((await restoredConnection.json()).displayName, "Native Jekyll");
  const restoredGroup = await api(token, `/v1/publication-groups/${encodeURIComponent(group.group.id)}`);
  await expectStatus(restoredGroup, 200);
  assert.equal((await restoredGroup.json()).enabled, true);
  const restoredAutomations = await api(token, "/v1/automations?enabled=true&limit=10");
  await expectStatus(restoredAutomations, 200);
  assert.equal((await restoredAutomations.json()).items.some((entry) => entry.definition.id === "native-package-first-run"), true);

  await stopInstalledRuntime(runtime);
  runtime = undefined;

  console.log(`Native installer first-run + restart smoke passed: ${basename(packagePath)}`);
} finally {
  if (runtime) await stopInstalledRuntime(runtime).catch(() => undefined);
  await cleanupInstall();
  await rm(dataDir, { recursive: true, force: true });
  await rm(repository, { recursive: true, force: true });
}
