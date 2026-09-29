import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OperatorClient } from "../packages/operator-client/dist/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps", "runtime", "dist", "cli.js");
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-studio-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-studio-jekyll-"));
const chromeProfile = await mkdtemp(join(tmpdir(), "blogmaatic-studio-chrome-"));
let runtime;
let browser;
let cdp;

function appendOutput(state, chunk) {
  state.output = `${state.output}${chunk.toString("utf8")}`.slice(-100_000);
}

async function git(args) {
  const result = await execFileAsync("git", args, { cwd: repository, encoding: "utf8" });
  return result.stdout.trim();
}

function startRuntime() {
  const state = { exited: false, output: "" };
  const child = spawn(process.execPath, [cli, "start", "--data-dir", dataDir], {
    cwd: root,
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
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      resolveStop();
    }, 8_000);
    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
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
      // Try next browser.
    }
  }
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const { stdout } = await execFileAsync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Try next command.
    }
  }
  throw new Error("A Chromium-compatible browser is required for the Automation Studio burn");
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
    "--window-size=1440,1000",
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
      // Browser has not published its port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Chrome DevTools:\n${state.output}`);
}

async function stopBrowser(handle) {
  if (!handle || handle.state.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

async function waitForExpression(expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {
      // Navigation can replace the execution context.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const text = await cdp.evaluate("document.body?.innerText?.slice(0, 10000)").catch(() => "");
  throw new Error(`Timed out waiting for browser state: ${expression}\n\nVisible page:\n${text}`);
}

async function waitForText(text, timeoutMs = 30_000) {
  await waitForExpression(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) === true`, timeoutMs);
}

async function clickText(text, selector = "button, a") {
  const clicked = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const items = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = items.find((item) => item.textContent?.replace(/\\s+/g, " ").trim() === wanted)
      ?? items.find((item) => item.textContent?.replace(/\\s+/g, " ").trim().includes(wanted));
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Could not click visible control: ${text}`);
}

async function setLabeledValue(labelText, value) {
  const changed = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(labelText)};
    const label = [...document.querySelectorAll("label")].find((item) => {
      const caption = item.querySelector(":scope > span")?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
      return caption === wanted || caption.startsWith(wanted + " ") || caption.startsWith(wanted + "*") || caption.startsWith(wanted + " *");
    });
    const control = label?.querySelector("input, textarea, select");
    if (!control) return false;
    const value = ${JSON.stringify(value)};
    if (control instanceof HTMLSelectElement) {
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return control.value === value;
    }
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return control.value === value;
  })()`);
  assert.equal(changed, true, `Could not set field ${labelText}`);
}

async function clickChoice(labelText) {
  const clicked = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(labelText)};
    const label = [...document.querySelectorAll("label")].find((item) => item.textContent?.replace(/\\s+/g, " ").trim() === wanted);
    const input = label?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.click();
    return input.checked;
  })()`);
  assert.equal(clicked, true, `Could not select ${labelText}`);
}

async function clickRowAction(name, action) {
  const clicked = await cdp.evaluate(`(() => {
    const name = ${JSON.stringify(name)};
    const action = ${JSON.stringify(action)};
    const row = [...document.querySelectorAll("article.automation-row")].find((item) => item.textContent?.includes(name));
    const button = row ? [...row.querySelectorAll("button, a")].find((item) => item.textContent?.replace(/\\s+/g, " ").trim() === action) : null;
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Could not ${action} Automation ${name}`);
}

async function seedPrerequisites(client) {
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Blogmaatic Studio Burn"]);
  await git(["config", "user.email", "studio-burn@example.invalid"]);
  await writeFile(join(repository, "_config.yml"), "title: Studio Burn\n", "utf8");
  await git(["add", "_config.yml"]);
  await git(["commit", "-m", "seed studio burn"]);

  const connection = await client.createConnection({
    extensionId: "blogmaatic.jekyll-git",
    displayName: "Studio Jekyll",
    status: "active",
    settings: {
      repositoryPath: repository,
      branch: "main",
      authorName: "Blogmaatic Studio Burn",
      authorEmail: "studio-burn@example.invalid",
    },
  });
  const health = await client.testConnection(connection.id);
  assert.equal(health.validation.valid, true);
  assert.notEqual(health.health?.state, "unhealthy");

  const group = await client.createPublicationGroup({
    name: "Studio publishing",
    policySetId: "default",
    enabled: true,
    routes: [{
      id: "route-studio-jekyll",
      enabled: true,
      desiredState: "present",
      destination: { extensionId: "blogmaatic.jekyll-git", connectionId: connection.id, channel: "posts" },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  });
  const publication = await client.createPublication({
    title: "Studio schedule snapshot",
    body: "Approved fixture for schedule ownership proof.",
    status: "approved",
    tags: ["studio"],
  });
  await client.registerAutomation({
    id: "automation_studio_ready",
    version: 1,
    name: "Studio readiness",
    enabled: true,
    trigger: { kind: "event", eventType: "publication.approved" },
    steps: [{ id: "publish", kind: "publish_group", groupId: group.group.id }],
  });
  await client.registerAutomation({
    id: "automation_schedule_guard",
    version: 1,
    name: "Schedule ownership guard",
    enabled: true,
    trigger: { kind: "schedule", scheduleId: "schedule_guard" },
    steps: [{ id: "publish", kind: "publish_group", groupId: group.group.id }],
  });
  await client.createSchedule({
    id: "schedule_guard",
    automationId: "automation_schedule_guard",
    automationVersion: 1,
    publication: publication.publication,
    groups: [group.group],
    timezone: "UTC",
    localDate: "2026-10-01",
    localTime: "09:00",
    recurrence: { kind: "once" },
    missedRunPolicy: "skip",
    enabled: true,
  });
  return { group };
}

async function activeByName(client, name) {
  const page = await client.listAutomations({ limit: 100 });
  const entry = page.items.find((item) => item.definition.name === name);
  assert.ok(entry, `Automation was not persisted: ${name}`);
  return entry;
}

try {
  await execFileAsync(process.execPath, [cli, "init", "--data-dir", dataDir], { cwd: root, encoding: "utf8" });
  const token = (await execFileAsync(process.execPath, [cli, "token", "--data-dir", dataDir], { cwd: root, encoding: "utf8" })).stdout.trim();
  runtime = startRuntime();
  await waitForHealth(runtime.state);
  const client = new OperatorClient({ baseUrl: "http://127.0.0.1:4317", token });
  await seedPrerequisites(client);

  const { stdout } = await execFileAsync(process.execPath, [cli, "open", "--data-dir", dataDir, "--no-browser"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  const launchAddress = stdout.match(/Control Room: (http:\/\/[^\s]+)/)?.[1];
  assert.ok(launchAddress, `blogmaatic open did not return a Control Room launch URL:\n${stdout}`);

  browser = await startBrowser();
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(launchAddress)}`, { method: "PUT" });
  assert.equal(response.ok, true);
  const target = await response.json();
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await waitForText("A live operational view over the canonical control plane and durable runtime.");
  await clickText("Automations", "nav a");
  await waitForText("Compose manual and event publishing workflows");

  const scheduleActions = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll("article.automation-row")].find((item) => item.textContent?.includes("Schedule ownership guard"));
    if (!row) return null;
    return [...row.querySelectorAll(".inline-confirm-actions button, .inline-confirm-actions a")].map((item) => item.textContent?.replace(/\\s+/g, " ").trim());
  })()`);
  assert.deepEqual(scheduleActions, ["Open Schedule"]);

  await clickText("New Automation");
  await waitForText("Compose a publishing workflow");
  await setLabeledValue("Automation name", "Studio manual burn");
  await clickChoice("Manual");
  await clickChoice("approved");
  await setLabeledValue("Require all tags", "release, consumer");
  await setLabeledValue("Require any tag", "news, update");
  await setLabeledValue("On publishing business failure", "continue");
  await clickText("+ Approval");
  await clickText("+ Delay");
  await setLabeledValue("Required role", "publisher");
  await setLabeledValue("Prompt", "Approve the release");
  await setLabeledValue("Delay", "2");
  await setLabeledValue("Unit", "seconds");
  const reordered = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll(".automation-step-editor__item")];
    const last = items.at(-1);
    const up = last?.querySelector(".automation-step-editor__actions button");
    if (!(up instanceof HTMLButtonElement)) return false;
    up.click();
    return true;
  })()`);
  assert.equal(reordered, true, "Delay step could not be reordered");
  await clickText("Create Automation");
  await waitForText("Version history", 30_000);

  const manualV1 = await activeByName(client, "Studio manual burn");
  assert.equal(manualV1.definition.trigger.kind, "manual");
  assert.deepEqual(manualV1.definition.conditions, {
    statuses: ["approved"],
    tagsAll: ["release", "consumer"],
    tagsAny: ["news", "update"],
  });
  assert.deepEqual(manualV1.definition.steps.map((step) => step.kind), ["publish_group", "delay", "approval"]);
  assert.equal(manualV1.definition.steps[0].onBusinessFailure, "continue");
  assert.equal(manualV1.definition.steps[1].durationMs, 2_000);
  assert.equal(manualV1.definition.steps[2].role, "publisher");

  await clickText("Close");
  await waitForText("Studio manual burn");
  await clickRowAction("Studio manual burn", "Edit");
  await waitForText("new immutable v2");
  await setLabeledValue("Require any tag", "news, bulletin");
  await clickText("Save version 2");
  await waitForText("Version history", 30_000);
  await waitForExpression(`document.body?.innerText.includes("v2") && document.body?.innerText.includes("v1")`);

  const versions = await client.listAutomationVersions(manualV1.definition.id, { limit: 10 });
  assert.deepEqual(versions.items.map((item) => item.definition.version), [2, 1]);
  assert.deepEqual(versions.items[1].definition.conditions.tagsAny, ["news", "update"]);
  assert.deepEqual(versions.items[0].definition.conditions.tagsAny, ["news", "bulletin"]);
  assert.equal(versions.items[0].isActiveVersion, true);
  assert.equal(versions.items[1].isActiveVersion, false);

  await clickText("Close");
  await clickText("New Automation");
  await waitForText("Compose a publishing workflow");
  await setLabeledValue("Automation name", "Studio event burn");
  await setLabeledValue("Event type", "publication.approved");
  await clickChoice("approved");
  await setLabeledValue("Require any tag", "studio, browser");
  await clickText("+ Approval");
  await clickText("+ Delay");
  await setLabeledValue("Required role", "editor");
  await setLabeledValue("Prompt", "Review before publishing");
  await setLabeledValue("Delay", "1");
  await setLabeledValue("Unit", "seconds");
  await clickText("Create Automation");
  await waitForText("Version history", 30_000);

  const event = await activeByName(client, "Studio event burn");
  assert.deepEqual(event.definition.trigger, { kind: "event", eventType: "publication.approved" });
  assert.deepEqual(event.definition.conditions, { statuses: ["approved"], tagsAny: ["studio", "browser"] });
  assert.deepEqual(event.definition.steps.map((step) => step.kind), ["publish_group", "approval", "delay"]);

  console.log(JSON.stringify({
    ok: true,
    manualAutomationId: manualV1.definition.id,
    eventAutomationId: event.definition.id,
    proof: [
      "schedule-owned Automation row exposes only schedule navigation",
      "manual Automation authored through Studio with status/tag conditions",
      "publish business-failure policy persisted as continue",
      "approval and delay steps authored through Studio",
      "ordered steps reordered through visible controls",
      "edit created immutable v2 while v1 remained unchanged",
      "event Automation authored through Studio with explicit event type and multi-step workflow",
    ],
  }));
} finally {
  if (cdp) cdp.close();
  if (browser) await stopBrowser(browser);
  await stopRuntime(runtime).catch(() => undefined);
  await Promise.all([dataDir, repository, chromeProfile].map((path) => rm(path, { recursive: true, force: true })));
}
