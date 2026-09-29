import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cli = join(root, "apps", "runtime", "dist", "cli.js");
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-keyboard-state-"));
const chromeProfile = await mkdtemp(join(tmpdir(), "blogmaatic-keyboard-chrome-"));
let browser;
let cdp;
let runtimeStarted = false;

function appendOutput(state, chunk) {
  state.output = `${state.output}${chunk.toString("utf8")}`.slice(-80_000);
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
  throw new Error("A Chromium-compatible browser is required for the keyboard accessibility burn");
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
    "--window-size=1280,800",
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

async function waitForExpression(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {
      // Navigation can replace the execution context while polling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for browser state: ${expression}`);
}

async function pressKey(key, code, windowsVirtualKeyCode) {
  const event = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

try {
  const publicationSource = await readFile(join(root, "apps", "control-room", "src", "pages", "publications.tsx"), "utf8");
  assert.equal(publicationSource.includes("window.confirm"), false, "Publication flow must not regress to browser confirm()");
  assert.match(publicationSource, /aria-label="Confirm publication approval and dispatch"/);
  assert.match(publicationSource, /autoFocus/);

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
  assert.equal(response.ok, true, `Could not open keyboard burn tab: ${response.status}`);
  const target = await response.json();
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(`document.readyState === "complete" && document.body?.innerText.includes("Set up your publishing engine")`);
  await waitForExpression(`Boolean(document.querySelector(".skip-link") && document.querySelector("#main-content"))`);

  await cdp.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur(); true");
  await pressKey("Tab", "Tab", 9);
  await waitForExpression(`document.activeElement?.classList.contains("skip-link")`);
  const focusState = await cdp.evaluate(`(() => {
    const element = document.activeElement;
    const style = element ? getComputedStyle(element) : null;
    const rect = element?.getBoundingClientRect();
    return {
      text: element?.textContent?.trim(),
      outlineStyle: style?.outlineStyle,
      outlineWidth: style?.outlineWidth,
      top: rect?.top,
      bottom: rect?.bottom,
    };
  })()`);
  assert.equal(focusState.text, "Skip to main content");
  assert.notEqual(focusState.outlineStyle, "none");
  assert.ok(Number.parseFloat(focusState.outlineWidth) >= 3, `Expected visible focus outline, got ${focusState.outlineWidth}`);
  assert.ok(focusState.top >= 0 && focusState.bottom > focusState.top, "Focused skip link must be visible in the viewport");

  await pressKey("Enter", "Enter", 13);
  await waitForExpression(`location.hash === "#main-content" && document.activeElement?.id === "main-content"`);

  const semanticNav = await cdp.evaluate(`(() => {
    const nav = document.querySelector("nav.mobile-nav[aria-label='Mobile navigation']");
    return Boolean(nav && [...nav.querySelectorAll("a")].some((link) => link.textContent?.trim() === "Schedules"));
  })()`);
  assert.equal(semanticNav, true, "Semantic mobile navigation must expose the Schedules destination");

  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedMotion = await cdp.evaluate(`(() => {
    const probe = document.createElement("div");
    probe.style.transition = "transform 2s linear";
    probe.style.animation = "pulse 2s infinite";
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const result = {
      transitionDuration: Number.parseFloat(style.transitionDuration),
      animationDuration: Number.parseFloat(style.animationDuration),
      animationIterationCount: style.animationIterationCount,
    };
    probe.remove();
    return result;
  })()`);
  assert.ok(reducedMotion.transitionDuration <= 0.001, `Reduced-motion transition remained ${reducedMotion.transitionDuration}s`);
  assert.ok(reducedMotion.animationDuration <= 0.001, `Reduced-motion animation remained ${reducedMotion.animationDuration}s`);
  assert.equal(reducedMotion.animationIterationCount, "1");

  console.log(JSON.stringify({
    ok: true,
    proof: [
      "real secure first-launch session",
      "Tab focuses visible skip link",
      "Enter transfers focus to main content",
      "semantic mobile navigation exposes Schedules",
      "prefers-reduced-motion clamps animation and transition duration",
      "publication dispatch uses inline focused confirmation instead of browser confirm()",
    ],
  }));
} finally {
  if (cdp) cdp.close();
  if (browser) await stopBrowser(browser);
  if (runtimeStarted) {
    await execFileAsync(process.execPath, [cli, "stop", "--data-dir", dataDir], { cwd: root, encoding: "utf8", timeout: 20_000 }).catch(() => undefined);
  }
  await Promise.all([dataDir, chromeProfile].map((path) => rm(path, { recursive: true, force: true })));
}
