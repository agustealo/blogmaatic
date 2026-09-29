import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlRoomServer } from "../dist/control-room-server.js";

const OPERATOR_TOKEN = "runtime-owned-operator-token-0123456789-abcdefghijklmnopqrstuvwxyz";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}

function sessionFrom(response, origin) {
  const cookieHeader = response.headers.get("set-cookie");
  const location = response.headers.get("location");
  assert.ok(cookieHeader);
  assert.ok(location);
  return {
    cookie: cookieHeader.split(";", 1)[0],
    proof: new URL(location, origin).hash.replace(/^#session=/, ""),
  };
}

function sessionHeaders(host, session) {
  return {
    cookie: session.cookie,
    "x-blogmaatic-session-proof": session.proof,
    origin: host.address,
    "sec-fetch-site": "same-origin",
    accept: "application/json",
  };
}

test("Control Room update actions require the full origin-bound browser session and expose only sanitized status", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-update-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  const upstream = createServer((_request, response) => response.end("{}"));
  const operatorOrigin = await listen(upstream);
  let checks = 0;
  let installs = 0;
  const updates = {
    check: async () => {
      checks += 1;
      return {
        currentVersion: "0.12.0",
        latestVersion: "0.13.0",
        tag: "v0.13.0",
        releaseUrl: "https://github.com/agustealo/blogmaatic/releases/tag/v0.13.0",
        updateAvailable: true,
        packageName: "blogmaatic-0.13.0-amd64.deb",
      };
    },
    install: async () => {
      installs += 1;
      return {
        currentVersion: "0.12.0",
        latestVersion: "0.13.0",
        tag: "v0.13.0",
        releaseUrl: "https://github.com/agustealo/blogmaatic/releases/tag/v0.13.0",
        updateAvailable: true,
        packageName: "blogmaatic-0.13.0-amd64.deb",
        installerOpened: true,
      };
    },
  };
  const host = await ControlRoomServer.start({
    root,
    host: "127.0.0.1",
    port: 0,
    operatorOrigin,
    operatorToken: OPERATOR_TOKEN,
    updates,
  });

  try {
    const bootstrap = await fetch(host.launchAddress, {
      redirect: "manual",
      headers: { "sec-fetch-site": "none" },
    });
    assert.equal(bootstrap.status, 303);
    const session = sessionFrom(bootstrap, host.address);

    const unauthenticated = await fetch(`${host.address}/local/update`, {
      headers: { origin: host.address, "sec-fetch-site": "same-origin" },
    });
    assert.equal(unauthenticated.status, 403);

    const cookieOnly = await fetch(`${host.address}/local/update`, {
      headers: {
        cookie: session.cookie,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(cookieOnly.status, 403);

    const proofOnly = await fetch(`${host.address}/local/update`, {
      headers: {
        "x-blogmaatic-session-proof": session.proof,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(proofOnly.status, 403);

    const crossOrigin = await fetch(`${host.address}/local/update`, {
      headers: {
        cookie: session.cookie,
        "x-blogmaatic-session-proof": session.proof,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(checks, 0);
    assert.equal(installs, 0);

    const checked = await fetch(`${host.address}/local/update`, {
      headers: sessionHeaders(host, session),
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.headers.get("cache-control"), "no-store");
    const status = await checked.json();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.packageName, "blogmaatic-0.13.0-amd64.deb");
    assert.equal("packagePath" in status, false);
    assert.equal("packageSha256" in status, false);
    assert.equal(checks, 1);

    const installed = await fetch(`${host.address}/local/update/install`, {
      method: "POST",
      headers: sessionHeaders(host, session),
    });
    assert.equal(installed.status, 202);
    const installedStatus = await installed.json();
    assert.equal(installedStatus.installerOpened, true);
    assert.equal("packagePath" in installedStatus, false);
    assert.equal("packageSha256" in installedStatus, false);
    assert.equal(installs, 1);

    const wrongMethod = await fetch(`${host.address}/local/update/install`, {
      method: "GET",
      headers: sessionHeaders(host, session),
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(installs, 1);
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
