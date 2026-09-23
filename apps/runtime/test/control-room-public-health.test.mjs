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
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}

test("public health can pass through without exposing operator authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-health-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");

  let receivedAuthorization;
  let receivedPath;
  const upstream = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    receivedPath = request.url;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", service: "blogmaatic-operator-api" }));
  });
  const operatorOrigin = await listen(upstream);
  const controlRoom = await ControlRoomServer.start({
    root,
    host: "127.0.0.1",
    port: 0,
    operatorOrigin,
    operatorToken: "runtime-owned-operator-token-0123456789",
  });

  try {
    const response = await fetch(`${controlRoom.address}/api/healthz`);
    assert.equal(response.status, 200);
    assert.equal(receivedPath, "/healthz");
    assert.equal(receivedAuthorization, undefined);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "blogmaatic-operator-api",
    });

    const privateResponse = await fetch(`${controlRoom.address}/api/v1/automations`);
    assert.equal(privateResponse.status, 403);
  } finally {
    await controlRoom.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
