import assert from "node:assert/strict";
import test from "node:test";

import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";

import {
  RestateAutomationLauncher,
  createPublicationAutomationWorkflow,
} from "../dist/index.js";

const publication = {
  id: "pub-launcher",
  createdAt: "2026-09-22T20:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-launcher",
    ordinal: 1,
    createdAt: "2026-09-22T20:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Launcher",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Detached workflow submission" } }],
      assets: [],
      tags: [],
      attributes: {},
    },
  },
  provenance: {},
};

const group = {
  id: "primary",
  name: "Primary",
  policySetId: "default",
  routes: [{
    id: "route-1",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "contract.publisher",
      connectionId: "connection-1",
      channel: "primary",
    },
    requiredCapabilities: ["article.create", "article.inspect"],
  }],
};

class Publisher {
  calls = 0;

  async publishGroup({ publication: item, group: publicationGroup }) {
    this.calls += 1;
    return [{
      publicationId: item.id,
      revisionId: item.current.id,
      groupId: publicationGroup.id,
      routeId: "route-1",
      projectionId: `${item.id}:route-1`,
      idempotencyKey: `${item.id}:${item.current.id}:route-1`,
      status: "verified",
      policy: { effect: "allow", reason: "launcher integration" },
      remote: { id: "remote-1" },
      completedAt: "2026-09-22T20:01:00.000Z",
    }];
  }
}

test("Restate launcher submits, inspects and attaches to a durable workflow", { timeout: 30_000 }, async () => {
  const publisher = new Publisher();
  const workflow = createPublicationAutomationWorkflow({ publisher });
  const environment = await RestateTestEnvironment.start({ services: [workflow], alwaysReplay: true });

  try {
    const launcher = new RestateAutomationLauncher({ url: environment.baseUrl() });
    const request = {
      runId: "run-launcher-proof",
      definition: {
        id: "launcher-proof",
        version: 1,
        name: "Launcher proof",
        enabled: true,
        trigger: { kind: "manual" },
        steps: [{ id: "publish", kind: "publish_group", groupId: "primary" }],
      },
      trigger: {
        kind: "manual",
        initiatedBy: "integration-test",
        commandId: "command-1",
        occurredAt: "2026-09-22T20:00:30.000Z",
      },
      publication,
      groups: [group],
    };

    const submission = await launcher.start(request);
    assert.ok(submission.runtimeId.length > 0);
    const result = await launcher.result(request.runId);
    assert.equal(result.outcome, "completed");
    assert.equal(publisher.calls, 1);
    const status = await launcher.status(request.runId);
    assert.equal(status.phase, "completed");
  } finally {
    await environment.stop();
  }
});
