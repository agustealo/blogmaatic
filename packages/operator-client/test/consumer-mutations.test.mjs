import assert from "node:assert/strict";
import test from "node:test";

import { OperatorClient } from "../dist/index.js";

const token = "operator-consumer-0123456789-abcdefghijklmnopqrstuvwxyz";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("consumer mutation routes are exposed through the canonical operator client", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    const url = String(input);
    if (url.endsWith("/v1/events")) return jsonResponse({ runs: [] }, 202);
    if (url.endsWith("/v1/runs/manual")) {
      return jsonResponse({
        runId: "run_1",
        triggerKey: "cmd_1",
        request: {
          runId: "run_1",
          definition: {
            id: "publish-now",
            version: 1,
            name: "Publish now",
            enabled: true,
            trigger: { kind: "manual" },
            steps: [{ id: "publish", kind: "publish_group", groupId: "group_1" }],
          },
          trigger: { kind: "manual", initiatedBy: "local-operator" },
          publication: publication(),
          groups: [group()],
        },
        dispatchState: "started",
        createdAt: "2026-09-28T12:00:00.000Z",
        updatedAt: "2026-09-28T12:00:00.000Z",
      }, 202);
    }
    if (url.endsWith("/v1/schedules") && init.method === "POST") return jsonResponse(schedule(), 201);
    if (url.endsWith("/v1/schedules/schedule_1")) return jsonResponse(schedule());
    if (url.endsWith("/v1/automations/publish-now")) {
      return jsonResponse({
        definition: {
          id: "publish-now",
          version: 1,
          name: "Publish now",
          enabled: true,
          trigger: { kind: "manual" },
          steps: [{ id: "publish", kind: "publish_group", groupId: "group_1" }],
        },
        registeredAt: "2026-09-28T12:00:00.000Z",
        activeVersion: 1,
        enabled: true,
        isActiveVersion: true,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = new OperatorClient({ baseUrl: "/api", token, fetchImpl });

  await client.getAutomation("publish-now");
  await client.ingestEvent({
    id: "event_1",
    type: "publication.approved",
    occurredAt: "2026-09-28T12:00:00.000Z",
    publication: publication(),
    groups: [group()],
  });
  await client.startManualRun({
    automationId: "publish-now",
    publication: publication(),
    groups: [group()],
  }, "consumer-run-1");
  await client.createSchedule(scheduleInput());
  await client.getSchedule("schedule_1");

  assert.deepEqual(calls.map((call) => [call.input, call.init.method ?? "GET"]), [
    ["/api/v1/automations/publish-now", "GET"],
    ["/api/v1/events", "POST"],
    ["/api/v1/runs/manual", "POST"],
    ["/api/v1/schedules", "POST"],
    ["/api/v1/schedules/schedule_1", "GET"],
  ]);
  const manualHeaders = new Headers(calls[2].init.headers);
  assert.equal(manualHeaders.get("idempotency-key"), "consumer-run-1");
  assert.equal(manualHeaders.get("authorization"), `Bearer ${token}`);
});

test("manual run rejects an empty idempotency key before fetch", () => {
  let called = false;
  const client = new OperatorClient({
    baseUrl: "/api",
    token,
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });
  assert.throws(
    () => client.startManualRun({ automationId: "publish-now", publication: publication(), groups: [group()] }, "  "),
    /idempotency key is required/,
  );
  assert.equal(called, false);
});

function publication() {
  return {
    id: "pub_1",
    createdAt: "2026-09-28T12:00:00.000Z",
    slug: "consumer-proof",
    status: "approved",
    current: {
      id: "rev_1",
      ordinal: 1,
      createdAt: "2026-09-28T12:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Consumer proof",
        language: "en",
        blocks: [{ id: "p1", kind: "paragraph", data: { text: "Published from the Control Room." } }],
        assets: [],
        tags: [],
        attributes: {},
      },
    },
    provenance: { source: "control-room" },
  };
}

function group() {
  return {
    id: "group_1",
    name: "Primary publishing",
    policySetId: "default",
    routes: [{
      id: "route_1",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.jekyll-git",
        connectionId: "connection_1",
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
}

function scheduleInput() {
  return {
    id: "schedule_1",
    automationId: "scheduled-publish",
    automationVersion: 1,
    publication: publication(),
    groups: [group()],
    timezone: "America/Detroit",
    localDate: "2026-09-29",
    localTime: "09:00",
    recurrence: { kind: "once" },
    missedRunPolicy: "catch_up_once",
    enabled: true,
  };
}

function schedule() {
  return {
    ...scheduleInput(),
    misfireGraceMs: 300000,
    nextFireAt: "2026-09-29T13:00:00.000Z",
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
  };
}
