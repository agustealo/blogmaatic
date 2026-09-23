import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadConfigFromFile } from "vite";

const configFile = resolve("vite.config.ts");

async function load(command, dataDir) {
  const previous = process.env.BLOGMAATIC_DEV_DATA_DIR;
  if (dataDir === undefined) delete process.env.BLOGMAATIC_DEV_DATA_DIR;
  else process.env.BLOGMAATIC_DEV_DATA_DIR = dataDir;
  try {
    const loaded = await loadConfigFromFile({ command, mode: "development" }, configFile, undefined, "silent");
    assert.ok(loaded, "Vite configuration did not load");
    return loaded.config;
  } finally {
    if (previous === undefined) delete process.env.BLOGMAATIC_DEV_DATA_DIR;
    else process.env.BLOGMAATIC_DEV_DATA_DIR = previous;
  }
}

test("development proxy injects the runtime credential server-side and strips browser cookies", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-dev-"));
  const token = "dev-operator-token-0123456789-abcdefghijklmnopqrstuvwxyz";
  try {
    await mkdir(join(dataDir, "secrets"), { recursive: true });
    await writeFile(join(dataDir, "secrets", "operator.token"), `${token}\n`, { mode: 0o600 });
    const config = await load("serve", dataDir);
    const proxyOptions = config.server?.proxy?.["/api"];
    assert.ok(proxyOptions && typeof proxyOptions === "object");
    assert.equal(typeof proxyOptions.configure, "function");

    let proxyRequestHandler;
    proxyOptions.configure({
      on(event, handler) {
        if (event === "proxyReq") proxyRequestHandler = handler;
      },
    });
    assert.equal(typeof proxyRequestHandler, "function");

    const headers = new Map(["cookie", "browser-session=must-not-forward"]);
    const proxyRequest = {
      setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
      removeHeader(name) { headers.delete(String(name).toLowerCase()); },
    };
    proxyRequestHandler(proxyRequest);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.has("cookie"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("development mode fails closed when the runtime credential is unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-dev-missing-"));
  try {
    await assert.rejects(() => load("serve", dataDir), /initialized Blogmaatic runtime credential/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production build configuration never requires a local runtime credential", async () => {
  const config = await load("build", undefined);
  assert.ok(Array.isArray(config.plugins));
});
