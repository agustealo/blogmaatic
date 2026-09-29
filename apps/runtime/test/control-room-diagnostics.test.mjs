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

test("Control Room diagnostics require the full browser session and expose only non-sensitive runtime facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-diagnostics-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  const upstream = createServer((_request, response) => response.end("{}"));
  const operatorOrigin = await listen(upstream);
  const host = await ControlRoomServer.start({
    root,
    host: "127.0.0.1",
    port: 0,
    operatorOrigin,
    operatorToken: OPERATOR_TOKEN,
    productVersion: "0.12.34",
  });

  try {
    const bootstrap = await fetch(host.launchAddress, {
      redirect: "manual",
      headers: { "sec-fetch-site": "none" },
    });
    assert.equal(bootstrap.status, 303);
    const session = sessionFrom(bootstrap, host.address);

    const unauthenticated = await fetch(`${host.address}/local/diagnostics`, {
      headers: { origin: host.address, "sec-fetch-site": "same-origin" },
    });
    assert.equal(unauthenticated.status, 403);

    const cookieOnly = await fetch(`${host.address}/local/diagnostics`, {
      headers: { cookie: session.cookie, origin: host.address, "sec-fetch-site": "same-origin" },
    });
    assert.equal(cookieOnly.status, 403);

    const proofOnly = await fetch(`${host.address}/local/diagnostics`, {
      headers: { "x-blogmaatic-session-proof": session.proof, origin: host.address, "sec-fetch-site": "same-origin" },
    });
    assert.equal(proofOnly.status, 403);

    const crossOrigin = await fetch(`${host.address}/local/diagnostics`, {
      headers: {
        cookie: session.cookie,
        "x-blogmaatic-session-proof": session.proof,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const wrongMethod = await fetch(`${host.address}/local/diagnostics`, {
      method: "POST",
      headers: sessionHeaders(host, session),
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const response = await fetch(`${host.address}/local/diagnostics`, {
      headers: sessionHeaders(host, session),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const diagnostics = await response.json();
    assert.deepEqual(diagnostics, {
      productVersion: "0.12.34",
      runtimeStatus: "running",
    });
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(OPERATOR_TOKEN), false);
    for (const forbidden of ["dataDir", "path", "token", "secret", "vault", "installer", "checksum", "sha256"]) {
      assert.equal(forbidden in diagnostics, false);
    }
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Control Room diagnostics fail closed when runtime product metadata is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-diagnostics-missing-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  const upstream = createServer((_request, response) => response.end("{}"));
  const operatorOrigin = await listen(upstream);
  const host = await ControlRoomServer.start({
    root,
    host: "127.0.0.1",
    port: 0,
    operatorOrigin,
    operatorToken: OPERATOR_TOKEN,
  });

  try {
    const bootstrap = await fetch(host.launchAddress, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    const session = sessionFrom(bootstrap, host.address);
    const response = await fetch(`${host.address}/local/diagnostics`, { headers: sessionHeaders(host, session) });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "CONTROL_ROOM_DIAGNOSTICS_UNAVAILABLE");
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
