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
  const cookie = response.headers.get("set-cookie");
  const location = response.headers.get("location");
  assert.ok(cookie);
  assert.ok(location);
  return {
    cookie: cookie.split(";", 1)[0],
    proof: new URL(location, origin).hash.replace(/^#session=/, ""),
  };
}

test("local launcher authority mints fresh one-use Control Room launch capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-reopen-"));
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
    const initial = host.launchAddress;
    const initialBootstrap = await fetch(initial, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    assert.equal(initialBootstrap.status, 303);
    const initialSession = sessionFrom(initialBootstrap, host.address);

    const browserOnly = await fetch(`${host.address}/local/launch`, {
      method: "POST",
      headers: {
        cookie: initialSession.cookie,
        "x-blogmaatic-session-proof": initialSession.proof,
        origin: host.address,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(browserOnly.status, 403);
    assert.equal((await browserOnly.json()).error.code, "CONTROL_ROOM_LAUNCH_FORBIDDEN");

    const wrongToken = await fetch(`${host.address}/local/launch`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "sec-fetch-site": "none" },
    });
    assert.equal(wrongToken.status, 403);

    const crossOrigin = await fetch(`${host.address}/local/launch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPERATOR_TOKEN}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const minted = await fetch(`${host.address}/local/launch`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "sec-fetch-site": "none" },
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.headers.get("cache-control"), "no-store");
    const firstLaunch = (await minted.json()).launchAddress;
    assert.match(firstLaunch, new RegExp(`^${host.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/session/[A-Za-z0-9_-]+$`));
    assert.notEqual(firstLaunch, initial);

    const bootstrap = await fetch(firstLaunch, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    assert.equal(bootstrap.status, 303);
    const reopenedSession = sessionFrom(bootstrap, host.address);
    assert.equal(reopenedSession.proof, initialSession.proof);

    const reused = await fetch(firstLaunch, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    assert.equal(reused.status, 410);

    const secondMint = await fetch(`${host.address}/local/launch`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "sec-fetch-site": "none" },
    });
    assert.equal(secondMint.status, 201);
    const secondLaunch = (await secondMint.json()).launchAddress;
    assert.notEqual(secondLaunch, firstLaunch);
    const secondBootstrap = await fetch(secondLaunch, { redirect: "manual", headers: { "sec-fetch-site": "none" } });
    assert.equal(secondBootstrap.status, 303);
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
