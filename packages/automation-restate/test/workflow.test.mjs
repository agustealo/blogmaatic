import assert from "node:assert/strict";
import test from "node:test";

import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";

import { createPublicationAutomationWorkflow } from "../dist/index.js";

function publication() {
  return {
    id: "pub-automation",
    createdAt: "2026-09-22T19:30:00.000Z",
    status: "approved",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T19:30:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Durable automation",
        language: "en",
        blocks: [{ id: "p1", kind: "paragraph", data: { text: "One publication, many hubs." } }],
        assets: [],
        tags: ["automation"],
        attributes: {},
      },
    },
    provenance: { author: "owner" },
  };
}

function group(id) {
  return {
    id,
    name: id,
    policySetId: "default",
    routes: [{
      id: `${id}-route`,
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "contract.publisher",
        connectionId: `${id}-connection`,
        channel: "primary",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
}

function request(runId) {
  return {
    runId,
    definition: {
      id: "durable-distribution",
      version: 1,
      name: "Durable distribution",
      enabled: true,
      trigger: { kind: "manual" },
      steps: [
        { id: "publish-origin", kind: "publish_group", groupId: "origin" },
        { id: "editor-approval", kind: "approval", role: "editor", prompt: "Approve social distribution" },
        { id: "settle", kind: "delay", durationMs: 25 },
        { id: "publish-social", kind: "publish_group", groupId: "social" },
      ],
    },
    trigger: { kind: "manual", initiatedBy: "owner" },
    publication: publication(),
    groups: [group("origin"), group("social")],
  };
}

class RecordingPublisher {
  calls = [];

  async publishGroup({ publication: item, group: publicationGroup }) {
    this.calls.push(publicationGroup.id);
    return [{
      publicationId: item.id,
      revisionId: item.current.id,
      groupId: publicationGroup.id,
      routeId: `${publicationGroup.id}-route`,
      projectionId: `${item.id}:${publicationGroup.id}-route`,
      idempotencyKey: `${item.id}:${item.current.id}:${publicationGroup.id}`,
      status: "verified",
      policy: { effect: "allow", reason: "integration test" },
      remote: { id: `${publicationGroup.id}-remote` },
      completedAt: new Date().toISOString(),
    }];
  }
}

async function invoke(baseUrl, runId, handler, body) {
  const response = await fetch(`${baseUrl}/BlogmaaticPublicationAutomation/${encodeURIComponent(runId)}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${handler} failed ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitForStatus(baseUrl, runId, phase, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await invoke(baseUrl, runId, "status", {});
      if (status?.phase === phase) return status;
    } catch {
      // Workflow registration/start can race the first status read.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for workflow phase ${phase}`);
}

test("durably pauses for approval and replays without repeating completed publication steps", { timeout: 30_000 }, async () => {
  const publisher = new RecordingPublisher();
  const workflow = createPublicationAutomationWorkflow({ publisher });
  const environment = await RestateTestEnvironment.start({ services: [workflow], alwaysReplay: true });

  try {
    const baseUrl = environment.baseUrl();
    const runId = "run-approval-resume";
    const runPromise = invoke(baseUrl, runId, "run", request(runId));

    const waiting = await waitForStatus(baseUrl, runId, "waiting_approval");
    assert.equal(waiting.currentStepId, "editor-approval");
    assert.deepEqual(publisher.calls, ["origin"]);

    const rejectedWrongRevision = await invoke(baseUrl, runId, "approve", {
      runId,
      stepId: "editor-approval",
      revisionId: "wrong-revision",
      role: "editor",
      approvedBy: "editor-1",
      decision: "approve",
      decidedAt: "2026-09-22T19:31:00.000Z",
    });
    assert.equal(rejectedWrongRevision.accepted, false);

    const approval = await invoke(baseUrl, runId, "approve", {
      runId,
      stepId: "editor-approval",
      revisionId: "rev-1",
      role: "editor",
      approvedBy: "editor-1",
      decision: "approve",
      decidedAt: "2026-09-22T19:31:01.000Z",
    });
    assert.equal(approval.accepted, true);

    const result = await runPromise;
    assert.equal(result.outcome, "completed");
    assert.deepEqual(publisher.calls, ["origin", "social"]);
    assert.deepEqual(result.stepResults.map((step) => step.stepId), [
      "publish-origin",
      "editor-approval",
      "settle",
      "publish-social",
    ]);

    const finalStatus = await invoke(baseUrl, runId, "status", {});
    assert.equal(finalStatus.phase, "completed");
    assert.deepEqual(finalStatus.completedStepIds, [
      "publish-origin",
      "editor-approval",
      "settle",
      "publish-social",
    ]);
  } finally {
    await environment.stop();
  }
});

test("human rejection is a durable business outcome and prevents later publication", { timeout: 30_000 }, async () => {
  const publisher = new RecordingPublisher();
  const workflow = createPublicationAutomationWorkflow({ publisher });
  const environment = await RestateTestEnvironment.start({ services: [workflow], alwaysReplay: true });

  try {
    const baseUrl = environment.baseUrl();
    const runId = "run-rejected";
    const runPromise = invoke(baseUrl, runId, "run", request(runId));
    await waitForStatus(baseUrl, runId, "waiting_approval");

    const response = await invoke(baseUrl, runId, "approve", {
      runId,
      stepId: "editor-approval",
      revisionId: "rev-1",
      role: "editor",
      approvedBy: "editor-2",
      decision: "reject",
      decidedAt: "2026-09-22T19:32:00.000Z",
      note: "Needs revision",
    });
    assert.equal(response.accepted, true);

    const result = await runPromise;
    assert.equal(result.outcome, "rejected");
    assert.equal(result.detail, "Needs revision");
    assert.deepEqual(publisher.calls, ["origin"]);
  } finally {
    await environment.stop();
  }
});
