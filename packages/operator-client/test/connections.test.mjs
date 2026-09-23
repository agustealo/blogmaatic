import assert from "node:assert/strict";
import test from "node:test";

import { OperatorClient } from "../dist/index.js";

const proof = "origin-proof-0123456789-abcdefghijklmnopqrstuvwxyz";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("connection client uses same-origin proof and keeps credentials out of URLs", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    const path = String(input);
    if (path.endsWith("/v1/connection-types")) return jsonResponse({ items: [] });
    if (path.endsWith("/v1/connections") && (init.method ?? "GET") === "GET") {
      return jsonResponse({ items: [] });
    }
    if (path.endsWith("/v1/connections") && init.method === "POST") {
      return jsonResponse({
        id: "connection-1",
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary WordPress",
        status: "active",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        configuredSecrets: ["applicationPassword"],
        createdAt: "2026-09-23T17:00:00.000Z",
        updatedAt: "2026-09-23T17:00:00.000Z",
      }, 201);
    }
    if (path.endsWith("/v1/connections/connection-1") && init.method === "PATCH") {
      return jsonResponse({
        id: "connection-1",
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary WordPress",
        status: "disabled",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        configuredSecrets: ["applicationPassword"],
        createdAt: "2026-09-23T17:00:00.000Z",
        updatedAt: "2026-09-23T17:01:00.000Z",
      });
    }
    if (path.endsWith("/v1/connections/connection-1/test")) {
      return jsonResponse({ validation: { valid: true, errors: [] }, health: {
        state: "healthy",
        checkedAt: "2026-09-23T17:02:00.000Z",
        detail: "WordPress REST API reachable",
      } });
    }
    if (path.endsWith("/v1/connections/connection-1") && init.method === "DELETE") {
      return jsonResponse({
        id: "connection-1",
        extensionId: "blogmaatic.wordpress-rest",
        displayName: "Primary WordPress",
        status: "disabled",
        settings: { siteUrl: "https://example.test", username: "publisher" },
        configuredSecrets: ["applicationPassword"],
        createdAt: "2026-09-23T17:00:00.000Z",
        updatedAt: "2026-09-23T17:01:00.000Z",
      });
    }
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${path}`);
  };

  const client = new OperatorClient({ baseUrl: "/api", sessionProof: proof, fetchImpl });
  await client.listConnectionTypes();
  await client.listConnections();
  const secret = "wp-app-password-super-secret";
  const created = await client.createConnection({
    extensionId: "blogmaatic.wordpress-rest",
    displayName: "Primary WordPress",
    settings: { siteUrl: "https://example.test", username: "publisher" },
    secrets: { applicationPassword: secret },
  });
  assert.deepEqual(created.configuredSecrets, ["applicationPassword"]);
  await client.updateConnection("connection-1", { status: "disabled" });
  await client.testConnection("connection-1");
  await client.removeConnection("connection-1");

  for (const call of calls) {
    assert.equal(call.input.includes(secret), false);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.get("x-blogmaatic-session-proof"), proof);
    assert.equal(call.init.credentials, "same-origin");
  }
  assert.equal(calls[2].init.method, "POST");
  assert.equal(JSON.parse(calls[2].init.body).secrets.applicationPassword, secret);
  assert.equal(calls[3].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[3].init.body), { status: "disabled" });
  assert.equal(calls[4].init.method, "POST");
  assert.equal(calls[4].init.body, undefined);
  assert.equal(calls[5].init.method, "DELETE");
  assert.equal(calls[5].init.body, undefined);
});

test("connection identifiers are encoded as one path segment", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return jsonResponse({
      id: "unsafe/id",
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Local",
      status: "active",
      settings: {},
      configuredSecrets: [],
      createdAt: "2026-09-23T17:00:00.000Z",
      updatedAt: "2026-09-23T17:00:00.000Z",
    });
  };
  const client = new OperatorClient({ baseUrl: "/api", sessionProof: proof, fetchImpl });
  await client.getConnection("unsafe/id");
  assert.equal(calls[0].input, "/api/v1/connections/unsafe%2Fid");
});
