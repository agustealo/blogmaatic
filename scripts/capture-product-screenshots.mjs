import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cli = join(root, "apps", "runtime", "dist", "cli.js");
const outputDir = resolve(process.argv[2] ?? join(root, "docs", "screenshots"));
const viewport = { width: 1600, height: 1000, deviceScaleFactor: 1.5 };

const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-media-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-media-jekyll-"));
const chromeProfile = await mkdtemp(join(tmpdir(), "blogmaatic-media-chrome-"));
let runtime;
let browser;
let cdp;

function appendOutput(state, chunk) {
  state.output = `${state.output}${chunk.toString("utf8")}`.slice(-160_000);
}

async function git(args) {
  const result = await execFileAsync("git", args, { cwd: repository, encoding: "utf8" });
  return result.stdout.trim();
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

async function waitForHttp(url, processState, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.exited) throw new Error(`Runtime exited before readiness:\n${processState.output}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return response;
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${processState.output}`);
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

async function stopProcess(handle, label) {
  if (!handle || handle.state?.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      reject(new Error(`${label} did not stop cleanly:\n${handle.state?.output ?? ""}`));
    }, 10_000);
    handle.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolveExit();
      else reject(new Error(`${label} stopped unexpectedly (${signal ?? `code ${code}`}):\n${handle.state?.output ?? ""}`));
    });
  });
}

async function waitForLaunchAddress(processState, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.exited) throw new Error(`Runtime exited before Control Room launch URL:\n${processState.output}`);
    const match = processState.output.match(/Control Room: (http:\/\/[^\s]+)/);
    if (match?.[1]) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Control Room launch URL:\n${processState.output}`);
}

async function browserBinary() {
  const candidates = [
    process.env.BLOGMAATIC_SCREENSHOT_BROWSER,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const { stdout } = await execFileAsync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
      const path = stdout.trim();
      if (path) return path;
    } catch {
      // Try the next command.
    }
  }
  throw new Error("A Chromium-compatible browser is required for product screenshot capture");
}

async function startBrowser() {
  const executable = await browserBinary();
  const state = { exited: false, output: "" };
  const child = spawn(executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    `--user-data-dir=${chromeProfile}`,
    "--remote-debugging-port=0",
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => appendOutput(state, chunk));
  child.stderr.on("data", (chunk) => appendOutput(state, chunk));
  child.once("exit", () => { state.exited = true; });

  const activePortFile = join(chromeProfile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`Browser exited before DevTools was ready:\n${state.output}`);
    try {
      const [portLine] = (await readFile(activePortFile, "utf8")).trim().split("\n");
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return { child, state, port };
    } catch {
      // Chrome has not written DevToolsActivePort yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Chrome DevTools:\n${state.output}`);
}

class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Timed out opening Chrome DevTools websocket")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Could not open Chrome DevTools websocket"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Chrome DevTools command failed"));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Chrome DevTools websocket closed"));
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      this.#pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser evaluation failed";
      throw new Error(text);
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

async function openPage(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not open screenshot tab: ${response.status} ${await response.text()}`);
  const target = await response.json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: false,
  });
  return client;
}

async function waitForExpression(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {
      // Navigation may replace the execution context while polling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for browser state: ${expression}`);
}

async function navigate(origin, path, readyText) {
  await cdp.send("Page.navigate", { url: `${origin}${path}` });
  await waitForExpression(`document.readyState === "complete" && document.body && document.body.innerText.includes(${JSON.stringify(readyText)})`);
  await waitForExpression(`!document.querySelector(".loading-block")`);
  await cdp.evaluate(`(() => {
    document.documentElement.dataset.theme = "dark";
    window.scrollTo(0, 0);
    let style = document.getElementById("blogmaatic-screenshot-stability");
    if (!style) {
      style = document.createElement("style");
      style.id = "blogmaatic-screenshot-stability";
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}";
      document.head.appendChild(style);
    }
    return true;
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
}

function assertPng(buffer, name) {
  assert.ok(buffer.length > 20_000, `${name} screenshot is unexpectedly small`);
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${name} is not a PNG`);
  assert.equal(buffer.readUInt32BE(16), Math.round(viewport.width * viewport.deviceScaleFactor));
  assert.equal(buffer.readUInt32BE(20), Math.round(viewport.height * viewport.deviceScaleFactor));
}

async function capture(name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const buffer = Buffer.from(result.data, "base64");
  assertPng(buffer, name);
  await writeFile(join(outputDir, `${name}.png`), buffer);
}

function publication() {
  return {
    id: "pub-product-media",
    createdAt: "2026-09-23T12:00:00.000Z",
    slug: "durable-publishing",
    status: "approved",
    current: {
      id: "rev-product-media-1",
      ordinal: 1,
      createdAt: "2026-09-23T12:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Why durable publishing needs a control plane",
        language: "en",
        blocks: [
          { id: "heading", kind: "heading", data: { level: 2, text: "One publication, many destinations" } },
          { id: "paragraph", kind: "paragraph", data: { text: "Blogmaatic keeps delivery, policy, verification, and reconciliation behind one durable publishing authority." } },
        ],
        assets: [],
        tags: ["publishing", "automation"],
        attributes: {},
      },
    },
    canonicalUrl: "https://journal.example.test/durable-publishing/",
    provenance: { source: "product-media-capture" },
  };
}

async function seedProductState(token) {
  const connectionResponse = await api(token, "/v1/connections", {
    method: "POST",
    body: JSON.stringify({
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Editorial Journal",
      status: "active",
      settings: {
        repositoryPath: repository,
        branch: "main",
        authorName: "Blogmaatic Editorial",
        authorEmail: "editorial@example.test",
        siteBaseUrl: "https://journal.example.test",
      },
    }),
  });
  await expectStatus(connectionResponse, 201);
  const connection = await connectionResponse.json();

  const testResponse = await api(token, `/v1/connections/${encodeURIComponent(connection.id)}/test`, { method: "POST" });
  await expectStatus(testResponse, 200);
  const health = await testResponse.json();
  assert.equal(health.validation.valid, true);
  assert.notEqual(health.health?.state, "unhealthy");

  const optionsResponse = await api(token, "/v1/publication-group-options");
  await expectStatus(optionsResponse, 200);
  const options = await optionsResponse.json();
  assert.ok(options.policySetIds.includes("default"));

  const groupResponse = await api(token, "/v1/publication-groups", {
    method: "POST",
    body: JSON.stringify({
      name: "Primary Publishing",
      policySetId: "default",
      enabled: true,
      routes: [{
        id: "route-editorial-journal",
        enabled: true,
        desiredState: "present",
        destination: {
          extensionId: "blogmaatic.jekyll-git",
          connectionId: connection.id,
          channel: "posts",
        },
        requiredCapabilities: ["article.create", "article.inspect"],
        variant: { layout: "post", permalink: "/durable-publishing/" },
      }],
    }),
  });
  await expectStatus(groupResponse, 201);
  const group = await groupResponse.json();

  const automation = {
    id: "automation-editorial-publishing",
    version: 1,
    name: "Publish approved content",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId: group.group.id }],
  };
  const automationResponse = await api(token, "/v1/automations", {
    method: "POST",
    body: JSON.stringify(automation),
  });
  await expectStatus(automationResponse, 201);

  const runResponse = await api(token, "/v1/runs/manual", {
    method: "POST",
    headers: { "idempotency-key": "product-media-run-1" },
    body: JSON.stringify({
      automationId: automation.id,
      publication: publication(),
      groups: [group.group],
    }),
  });
  await expectStatus(runResponse, 202);
  const run = await runResponse.json();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const resultResponse = await api(token, `/v1/runs/${encodeURIComponent(run.runId)}/result`);
    if (resultResponse.status === 200) {
      const result = await resultResponse.json();
      assert.equal(result.outcome, "completed");
      return { connection, group, automation, run };
    }
    if (resultResponse.status !== 409) {
      throw new Error(`Unexpected run result status ${resultResponse.status}: ${await resultResponse.text()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for product-media run ${run.runId}`);
}

try {
  await mkdir(outputDir, { recursive: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Blogmaatic Product Media"]);
  await git(["config", "user.email", "product-media@example.test"]);
  await writeFile(join(repository, "_config.yml"), "title: Blogmaatic Editorial Journal\n");
  await git(["add", "_config.yml"]);
  await git(["commit", "-m", "seed product media fixture"]);

  await execFileAsync(process.execPath, [cli, "init", "--data-dir", dataDir], { cwd: root, encoding: "utf8" });
  const token = (await execFileAsync(process.execPath, [cli, "token", "--data-dir", dataDir], { cwd: root, encoding: "utf8" })).stdout.trim();
  assert.ok(token.length >= 32);

  runtime = startRuntime();
  await waitForHttp("http://127.0.0.1:4317/healthz", runtime.state);
  await waitForHttp("http://127.0.0.1:4320/", runtime.state);
  const launchAddress = await waitForLaunchAddress(runtime.state);

  browser = await startBrowser();
  cdp = await openPage(browser.port, launchAddress);
  await waitForExpression(`document.readyState === "complete" && document.body && document.body.innerText.includes("Set up your publishing engine")`);
  const origin = await cdp.evaluate("location.origin");
  assert.equal(origin, "http://127.0.0.1:4320");

  await navigate(origin, "/setup", "Set up your publishing engine");
  await capture("01-first-run-setup");

  const state = await seedProductState(token);

  await navigate(origin, "/setup", "Blogmaatic is ready");
  await capture("02-first-run-ready");

  await navigate(origin, "/connections", "Connections");
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Test");
    if (button) button.click();
    return Boolean(button);
  })()`);
  await waitForExpression(`document.body.innerText.toLowerCase().includes("healthy") || document.body.innerText.toLowerCase().includes("ready")`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  await capture("03-connections");

  await navigate(origin, "/", "Overview");
  await capture("04-control-room-overview");

  await navigate(origin, "/automations", "Automations");
  await capture("05-automations");

  await navigate(origin, "/runs", "Runs");
  await capture("06-runs");

  await navigate(origin, `/runs/${encodeURIComponent(state.run.runId)}`, "Run");
  await capture("07-run-detail");

  await navigate(origin, "/operations", "Operations");
  await capture("08-operations");

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: process.env.GITHUB_SHA ?? null,
    source: "real-runtime-capture",
    browser: await browserBinary(),
    viewport,
    fixture: {
      runtime: "managed local runtime",
      publisher: "Jekyll/Git",
      connection: "created through Operator API",
      publicationGroup: "created through canonical Publication Group authority",
      automation: "registered through canonical automation registry",
      run: "real completed durable publication run",
    },
    captures: [
      { file: "01-first-run-setup.png", route: "/setup", feature: "fresh first-run setup" },
      { file: "02-first-run-ready.png", route: "/setup", feature: "completed first-run readiness" },
      { file: "03-connections.png", route: "/connections", feature: "real managed destination and health" },
      { file: "04-control-room-overview.png", route: "/", feature: "Control Room overview" },
      { file: "05-automations.png", route: "/automations", feature: "durable automation management" },
      { file: "06-runs.png", route: "/runs", feature: "durable run history" },
      { file: "07-run-detail.png", route: `/runs/${state.run.runId}`, feature: "verified run detail" },
      { file: "08-operations.png", route: "/operations", feature: "operator attention surface" },
    ],
  };
  await writeFile(join(outputDir, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Captured ${manifest.captures.length} real Control Room screenshots in ${outputDir}`);
} finally {
  if (cdp) cdp.close();
  if (browser) await stopProcess(browser, "Browser").catch(() => undefined);
  if (runtime) await stopProcess(runtime, "Runtime").catch(() => undefined);
  await Promise.all([
    dataDir,
    repository,
    chromeProfile,
  ].map((path) => rm(path, { recursive: true, force: true })));
}
