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

test("Control Room host serves the production bundle and proxies only the operator surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-control-room-"));
  await writeFile(join(root, "index.html"), "<main>control room</main>");
  let receivedAuthorization;
  const upstream = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  });
  const operatorOrigin = await listen(upstream);
  const host = await ControlRoomServer.start({ root, host: "127.0.0.1", port: 0, operatorOrigin });
  try {
    const page = await fetch(host.address);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<main>control room</main>");
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

    const proxied = await fetch(`${host.address}/api/healthz`, { headers: { authorization: "Bearer proof-token" } });
    assert.equal(proxied.status, 200);
    assert.equal(receivedAuthorization, "Bearer proof-token");
    assert.deepEqual(await proxied.json(), { status: "ok" });
  } finally {
    await host.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
