import assert from "node:assert/strict";
import test from "node:test";

import { OperatorClient } from "../dist/index.js";

const token = "operator-automation-0123456789-abcdefghijklmnopqrstuvwxyz";

test("automation registration uses the canonical JSON mutation route", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({
      definition: {
        id: "first-publication",
        version: 1,
        name: "First publication",
        enabled: true,
        trigger: { kind: "manual" },
        steps: [{ id: "publish", kind: "publish_group", groupId: "group_1" }],
      },
      registeredAt: "2026-09-23T18:30:00.000Z",
      activeVersion: 1,
      enabled: true,
      isActiveVersion: true,
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });
  const definition = {
    id: "first-publication",
    version: 1,
    name: "First publication",
    enabled: true,
    trigger: { kind: "manual" },
    steps: [{ id: "publish", kind: "publish_group", groupId: "group_1" }],
  };

  const result = await client.registerAutomation(definition);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/v1/automations");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify(definition));
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(result.definition.id, definition.id);
});
