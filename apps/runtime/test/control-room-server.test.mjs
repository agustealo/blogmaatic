import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlRoomServer } from "../dist/control-room-server.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}

async function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

function browserSession(response, origin) {
  const cookieHeader = response.headers.get("set-cookie");
  assert.ok(cookieHeader, "Control Room bootstrap did not set a session cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = cookieHeader.split(";", 1)[0];
  const cookieName = cookie.split("=", 1)[0];
  assert.match(cookieName, /^blogmaatic_control_room_session_\d+$/);

  const location = response.headers.get("location");
  assert.ok(location, "Control Room bootstrap did not return a redirect location");
  const proof = new URL(location, origin).hash.replace(/^#session=/, "");
  assert.match(proof, /^[A-Za-z0-9_-]{32,128}$/);
  return { cookie, cookieName, proof };
}

test("Control Room requires both a host-wide HttpOnly cookie and an origin-bound proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  let receivedAuthorization;
  let upstreamRequests = 0;
  const upstream = createServer((request, response) => {
    upstreamRequests += 1;
    receivedAuthorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  });
  const operatorOrigin = await listen(upstream);
  const host = await ControlRoomServer.start({
    root,
    host: "127.0.0.1",
    port: 0,
    operatorOrigin,
    operatorToken: "runtime-owned-operator-token-0123456789",
  });
  try {
    const page = await fetch(host.address);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<main>control room</main>");
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");

    const unauthenticated = await fetch(`${host.address}/api/v1/automations`, {
      headers: { origin: host.address, "sec-fetch-site": "same-origin" },
    });
    assert.equal(unauthenticated.status, 403);
    assert.equal(upstreamRequests, 0);

    const bootstrap = await fetch(host.launchAddress, {
      redirect: "manual",
      headers: { "sec-fetch-site": "none" },
    });
    assert.equal(bootstrap.status, 303);
    const session = browserSession(bootstrap, host.address);

    const reusedBootstrap = await fetch(host.launchAddress, {
      redirect: "manual",
      headers: { "sec-fetch-site": "none" },
    });
    assert.equal(reusedBootstrap.status, 410);

    const cookieOnly = await fetch(`${host.address}/api/v1/automations`, {
      headers: {
        cookie: session.cookie,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(cookieOnly.status, 403);
    assert.equal(upstreamRequests, 0);

    const proofOnly = await fetch(`${host.address}/api/v1/automations`, {
      headers: {
        "x-blogmaatic-session-proof": session.proof,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(proofOnly.status, 403);
    assert.equal(upstreamRequests, 0);

    const proxied = await fetch(`${host.address}/api/v1/automations`, {
      headers: {
        authorization: "Bearer browser-must-not-control-this",
        cookie: session.cookie,
        "x-blogmaatic-session-proof": session.proof,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(proxied.status, 200);
    assert.equal(receivedAuthorization, "Bearer runtime-owned-operator-token-0123456789");
    assert.equal(upstreamRequests, 1);
    assert.equal(proxied.headers.get("cache-control"), "no-store");
    assert.deepEqual(await proxied.json(), { status: "ok" });

    const rejected = await fetch(`${host.address}/api/v1/automations`, {
      headers: {
        cookie: session.cookie,
        "x-blogmaatic-session-proof": session.proof,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(upstreamRequests, 1);

    const boundPort = new URL(host.address).port;
    const rebound = await rawRequest(`${host.address}/api/v1/automations`, {
      host: `attacker.example:${boundPort}`,
      origin: `http://attacker.example:${boundPort}`,
      cookie: session.cookie,
      "x-blogmaatic-session-proof": session.proof,
      "sec-fetch-site": "same-origin",
    });
    assert.equal(rebound.status, 403);
    assert.equal(upstreamRequests, 1);
    assert.equal(JSON.parse(rebound.body).error.code, "CONTROL_ROOM_SESSION_REQUIRED");
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("Control Room instances use distinct cookie names so their loopback sessions do not overwrite each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-cookies-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  const upstream = createServer((_request, response) => response.end("{}"));
  const operatorOrigin = await listen(upstream);
  const first = await ControlRoomServer.start({ root, host: "127.0.0.1", port: 0, operatorOrigin, operatorToken: "first-token-0123456789-abcdefghijklmnopqrstuvwxyz" });
  const second = await ControlRoomServer.start({ root, host: "127.0.0.1", port: 0, operatorOrigin, operatorToken: "second-token-0123456789-abcdefghijklmnopqrstuvwxyz" });
  try {
    const firstBootstrap = await fetch(first.launchAddress, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    const secondBootstrap = await fetch(second.launchAddress, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    const firstSession = browserSession(firstBootstrap, first.address);
    const secondSession = browserSession(secondBootstrap, second.address);
    assert.notEqual(firstSession.cookieName, secondSession.cookieName);
    assert.notEqual(firstSession.proof, secondSession.proof);
  } finally {
    await first.close();
    await second.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
