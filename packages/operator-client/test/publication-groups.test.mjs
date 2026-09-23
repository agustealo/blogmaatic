import assert from "node:assert/strict";
import test from "node:test";

import { OperatorClient } from "../dist/index.js";

const token = "operator-groups-0123456789-abcdefghijklmnopqrstuvwxyz";

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("publication group client preserves same-origin proof and encodes group identifiers", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return response({ items: [], nextCursor: null });
  };
  const client = new OperatorClient({
    baseUrl: "/api",
    sessionProof: "group-proof-0123456789-abcdefghijklmnopqrstuvwxyz",
    fetchImpl,
  });

  await client.listPublicationGroups({ enabled: true, limit: 25 });
  await client.listPublicationGroupVersions("group/with space", { limit: 10 });

  assert.match(calls[0].input, /^\/api\/v1\/publication-groups\?/);
  assert.match(calls[0].input, /enabled=true/);
  assert.match(calls[0].input, /limit=25/);
  assert.equal(
    new Headers(calls[0].init.headers).get("x-blogmaatic-session-proof"),
    "group-proof-0123456789-abcdefghijklmnopqrstuvwxyz",
  );
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[1].input, "/api/v1/publication-groups/group%2Fwith%20space/versions?limit=10");
});

test("publication group setup options come from the canonical operator boundary", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return response({ policySetIds: ["default", "strict"] });
  };
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });

  const options = await client.getPublicationGroupOptions();

  assert.deepEqual(options.policySetIds, ["default", "strict"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/v1/publication-group-options");
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${token}`);
});

test("publication group client emits bounded JSON mutation bodies without putting data in URLs", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return response({
      group: { id: "group_1", name: "Primary", policySetId: "default", routes: [] },
      version: 1,
      activeVersion: 1,
      registeredAt: "2026-09-23T18:00:00.000Z",
      updatedAt: "2026-09-23T18:00:00.000Z",
      enabled: true,
      isActiveVersion: true,
    });
  };
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });
  const create = { name: "Primary", policySetId: "default", routes: [] };
  const update = { expectedVersion: 1, ...create, name: "Primary v2" };

  await client.createPublicationGroup(create);
  await client.updatePublicationGroup("group/1", update);
  await client.setPublicationGroupEnabled("group/1", { expectedVersion: 2, enabled: false });

  assert.equal(calls[0].input, "/api/v1/publication-groups");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify(create));

  assert.equal(calls[1].input, "/api/v1/publication-groups/group%2F1");
  assert.equal(calls[1].init.method, "PATCH");
  assert.equal(calls[1].init.body, JSON.stringify(update));

  assert.equal(calls[2].input, "/api/v1/publication-groups/group%2F1/activation");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.body, JSON.stringify({ expectedVersion: 2, enabled: false }));
  assert.equal(calls.some((call) => call.input.includes("Primary")), false);
});
