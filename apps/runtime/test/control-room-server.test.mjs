import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("Control Room host owns proxy authentication and rejects cross-site browser requests", async () => {
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

    const proxied = await fetch(`${host.address}/api/v1/automations`, {
      headers: {
        authorization: "Bearer browser-must-not-control-this",
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
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(upstreamRequests, 1);
    const body = await rejected.json();
    assert.equal(body.error.code, "CONTROL_ROOM_ORIGIN_REJECTED");
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
