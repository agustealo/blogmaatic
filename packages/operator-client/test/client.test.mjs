import assert from "node:assert/strict";
import test from "node:test";

import { OperatorClient, OperatorClientError } from "../dist/index.js";

const token = "operator-control-room-0123456789-abcdefghijklmnopqrstuvwxyz";

test("health is public while authenticated queries carry only the bearer credential and encoded filters", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    const body = calls.length === 1
      ? { status: "ok", service: "blogmaatic-operator-api" }
      : { items: [], nextCursor: "next" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new OperatorClient({ baseUrl: "https://control.example.test/api/", token, fetchImpl });

  await client.health();
  await client.listRuns({ limit: 25, runtimePhase: "waiting_approval", publicationId: "pub one" });

  assert.equal(calls[0].input, "https://control.example.test/api/healthz");
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.match(calls[1].input, /\/api\/v1\/runs\?/);
  assert.match(calls[1].input, /limit=25/);
  assert.match(calls[1].input, /runtimePhase=waiting_approval/);
  assert.match(calls[1].input, /publicationId=pub\+one/);
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(calls[1].init.headers).has("x-blogmaatic-session-proof"), false);
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.referrerPolicy, "no-referrer");
});

test("same-origin proxy mode sends no bearer credential and carries the origin-bound session proof", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const proof = "origin-proof-0123456789-abcdefghijklmnopqrstuvwxyz";
  const client = new OperatorClient({ baseUrl: "/api", sessionProof: proof, fetchImpl });

  await client.listAutomations({ limit: 1 });

  assert.equal(calls[0].input, "/api/v1/automations?limit=1");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.get("x-blogmaatic-session-proof"), proof);
  assert.equal(calls[0].init.credentials, "same-origin");
});

test("public health never carries the local session proof", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ status: "ok", service: "blogmaatic-operator-api" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new OperatorClient({
    baseUrl: "/api",
    sessionProof: "origin-proof-0123456789-abcdefghijklmnopqrstuvwxyz",
    fetchImpl,
  });
  await client.health();
  assert.equal(new Headers(calls[0].init.headers).has("x-blogmaatic-session-proof"), false);
});

test("mutation bodies are JSON and credentials never enter the URL", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ definition: { id: "release", version: 2 }, enabled: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });
  await client.activateAutomation("release", 2, { enabled: false });

  assert.equal(calls[0].input, "/api/v1/automations/release/versions/2/activate");
  assert.equal(calls[0].input.includes(token), false);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ enabled: false }));
});

test("structured API failures become bounded client errors", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { code: "FORBIDDEN", message: "Missing permission", requestId: "req-7" },
  }), { status: 403, headers: { "content-type": "application/json" } });
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });

  await assert.rejects(
    () => client.listOperations({ limit: 1 }),
    (error) => {
      assert.ok(error instanceof OperatorClientError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.requestId, "req-7");
      assert.equal(error.message, "Missing permission");
      return true;
    },
  );
});

test("rejects ambiguous relative origins, non-http absolute origins, and URL credentials", () => {
  assert.throws(() => new OperatorClient({ baseUrl: "//attacker.example/api", token }), /unambiguous path/);
  assert.throws(() => new OperatorClient({ baseUrl: "/\\attacker.example/api", token }), /unambiguous path/);
  assert.throws(() => new OperatorClient({ baseUrl: "/api?next=//attacker.example", token }), /unambiguous path/);
  assert.throws(() => new OperatorClient({ baseUrl: "file:///tmp/api", token }), /HTTP or HTTPS/);
  assert.throws(() => new OperatorClient({ baseUrl: "https://user:pass@example.test", token }), /must not contain credentials/);
});
