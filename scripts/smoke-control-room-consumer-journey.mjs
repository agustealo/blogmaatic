import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cli = join(root, "apps", "runtime", "dist", "cli.js");
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-browser-journey-state-"));
const repositoryPath = await mkdtemp(join(tmpdir(), "blogmaatic-browser-journey-jekyll-"));
const chromeProfile = await mkdtemp(join(tmpdir(), "blogmaatic-browser-journey-chrome-"));
const publicationTitle = `Browser Journey ${Date.now()}`;
let browser;
let cdp;
let runtimeStarted = false;

function appendOutput(state, chunk) {
  state.output = `${state.output}${chunk.toString("utf8")}`.slice(-100_000);
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
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Try the next command.
    }
  }
  throw new Error("A Chromium-compatible browser is required for the consumer journey burn");
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
      // Chrome has not written DevToolsActivePort yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Chrome DevTools:\n${state.output}`);
}

async function stopBrowser(handle) {
  if (!handle || handle.state.exited) return;
  handle.child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      handle.child.kill("SIGKILL");
      resolveExit();
    }, 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
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
      // Navigation can replace the execution context while polling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const pageText = await cdp.evaluate("document.body?.innerText?.slice(0, 12000)").catch(() => "");
  throw new Error(`Timed out waiting for browser state: ${expression}\n\nVisible page:\n${pageText}`);
}

async function waitForText(text, timeoutMs = 30_000) {
  await waitForExpression(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) === true`, timeoutMs);
}

async function clickText(text, selector = "button, a") {
  const clicked = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((item) => item.textContent?.replace(/\\s+/g, " ").trim() === wanted)
      ?? candidates.find((item) => item.textContent?.replace(/\\s+/g, " ").trim().includes(wanted));
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

async function selectOptionContaining(labelText, valueFragment) {
  const changed = await cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(labelText)};
    const fragment = ${JSON.stringify(valueFragment)};
    const label = [...document.querySelectorAll("label")].find((item) => {
      const caption = item.querySelector(":scope > span")?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
      return caption === wanted || caption.startsWith(wanted + " ");
    });
    const control = label?.querySelector("select");
    if (!(control instanceof HTMLSelectElement)) return false;
    const option = [...control.options].find((item) => item.value.includes(fragment) || item.textContent?.toLowerCase().includes(fragment.toLowerCase()));
    if (!option) return false;
    control.value = option.value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `Could not select ${valueFragment} in ${labelText}`);
}

async function clickRunForPublication(title) {
  const clicked = await cdp.evaluate(`(() => {
    const title = ${JSON.stringify(title)};
    const row = [...document.querySelectorAll("a.data-table__row")].find((item) => item.textContent?.includes(title));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Could not open run for ${title}`);
}

async function initializeJekyllRepository() {
  await execFileAsync("git", ["init", "-b", "main", repositoryPath], { encoding: "utf8" });
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Blogmaatic Browser Burn"], { encoding: "utf8" });
  await execFileAsync("git", ["-C", repositoryPath, "config", "user.email", "browser-burn@example.invalid"], { encoding: "utf8" });
  await writeFile(join(repositoryPath, "_config.yml"), "title: Blogmaatic Browser Journey\nurl: https://example.invalid\n", "utf8");
  await writeFile(join(repositoryPath, "index.md"), "---\nlayout: home\n---\n\nBrowser journey fixture.\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "_config.yml", "index.md"], { encoding: "utf8" });
  await execFileAsync("git", ["-C", repositoryPath, "commit", "-m", "Initialize browser journey fixture"], { encoding: "utf8" });
}

try {
  await initializeJekyllRepository();

  const { stdout } = await execFileAsync(process.execPath, [cli, "open", "--data-dir", dataDir, "--no-browser"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  runtimeStarted = true;
  const launchAddress = stdout.match(/Control Room: (http:\/\/[^\s]+)/)?.[1];
  assert.ok(launchAddress, `blogmaatic open did not return a Control Room launch URL:\n${stdout}`);

  browser = await startBrowser();
  const response = await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(launchAddress)}`, { method: "PUT" });
  assert.equal(response.ok, true, `Could not open consumer journey tab: ${response.status}`);
  const target = await response.json();
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await waitForText("Set up your publishing engine");
  await waitForText("No active destination is ready");
  await clickText("Open Connections");
  await waitForText("No destinations yet");
  await clickText("New connection");
  await waitForText("New destination");

  await selectOptionContaining("Publisher", "jekyll-git");
  await setLabeledValue("Connection name", "Browser Jekyll");
  await setLabeledValue("Repository path", repositoryPath);
  await setLabeledValue("Branch", "main");
  await setLabeledValue("Git author name", "Blogmaatic Browser Burn");
  await setLabeledValue("Git author email", "browser-burn@example.invalid");
  await clickText("Save connection");

  await waitForText("Create your first Publication Group", 45_000);
  await setLabeledValue("Group name", "Browser publishing");
  await clickText("Create Publication Group");
  await waitForText("Create your first Automation", 30_000);
  await setLabeledValue("Automation name", "Browser approved publishing");
  await clickText("Create Automation");
  await waitForText("Blogmaatic is ready", 30_000);
  await clickText("Enter Control Room");
  await waitForText("A live operational view over the canonical control plane and durable runtime.");

  await clickText("Publications", "nav a");
  await waitForText("Content workspace");
  await clickText("New Publication");
  await waitForText("New Publication");
  await setLabeledValue("Title", publicationTitle);
  await setLabeledValue("Summary", "Created entirely through the real Control Room browser journey.");
  await setLabeledValue("Body", "This article proves the visible consumer flow can create durable publishing state without hidden OperatorClient seeding.");
  await setLabeledValue("Tags", "browser, e2e");
  await clickText("Create Draft");

  await waitForText("Approve & Publish", 30_000);
  await clickText("Approve & Publish");
  await waitForText(`Approve and publish “${publicationTitle}”?`);
  await clickText("Confirm publish");
  await waitForText("Publication dispatched to 1 run", 45_000);
  await clickText("Open Runs to follow delivery.");
  await waitForText("Durable run identities", 30_000);
  await waitForText(publicationTitle, 30_000);

  const completionDeadline = Date.now() + 60_000;
  let completed = false;
  while (Date.now() < completionDeadline) {
    const state = await cdp.evaluate(`(() => {
      const title = ${JSON.stringify(publicationTitle)};
      const row = [...document.querySelectorAll("a.data-table__row")].find((item) => item.textContent?.includes(title));
      return row?.textContent?.toLowerCase().includes("completed") === true;
    })()`);
    if (state) {
      completed = true;
      break;
    }
    await clickText("Refresh");
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  }
  assert.equal(completed, true, "Browser-created durable run did not reach completed state in the visible Runs UI");

  await clickRunForPublication(publicationTitle);
  await waitForText("Run detail");
  await waitForText("Terminal result", 30_000);
  await waitForExpression(`document.body?.innerText.toLowerCase().includes("completed") === true`);
  await waitForExpression(`document.body?.innerText.includes(${JSON.stringify(publicationTitle)}) === true`);

  const commits = Number((await execFileAsync("git", ["-C", repositoryPath, "rev-list", "--count", "HEAD"], { encoding: "utf8" })).stdout.trim());
  assert.ok(commits >= 2, `Expected the real Jekyll publisher to create a Git commit, found ${commits} total commits`);
  const postsDir = join(repositoryPath, "_posts");
  const posts = await readdir(postsDir);
  assert.ok(posts.some((name) => name.endsWith(".md")), "Expected a real Jekyll post in _posts after the browser-created run");

  console.log(JSON.stringify({
    ok: true,
    publicationTitle,
    proof: [
      "blank secure first launch",
      "Jekyll Connection created and health-tested through UI",
      "Publication Group created through guided setup UI",
      "publication.approved Automation created through guided setup UI",
      "Publication created through Workspace UI",
      "publication approved and dispatched through inline UI confirmation",
      "durable Run observed completed through Runs UI",
      "terminal Run detail observed through UI",
      "real Jekyll Git commit and _posts artifact observed externally",
    ],
  }));
} finally {
  if (cdp) cdp.close();
  if (browser) await stopBrowser(browser);
  if (runtimeStarted) {
    await execFileAsync(process.execPath, [cli, "stop", "--data-dir", dataDir], { cwd: root, encoding: "utf8", timeout: 20_000 }).catch(() => undefined);
  }
  await Promise.all([dataDir, repositoryPath, chromeProfile].map((path) => rm(path, { recursive: true, force: true })));
}
