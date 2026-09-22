import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalGrantsForGroup,
  automationMatchesPublication,
  validateAutomationDefinition,
  validateAutomationRunRequest,
} from "../dist/index.js";

function publication(overrides = {}) {
  return {
    id: "pub-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    status: "approved",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T12:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Durable publishing",
        language: "en",
        blocks: [{ id: "p1", kind: "paragraph", data: { text: "Ship it." } }],
        assets: [],
        tags: ["technology", "automation"],
        attributes: {},
      },
    },
    provenance: { author: "owner" },
    ...overrides,
  };
}

const group = {
  id: "primary",
  name: "Primary",
  policySetId: "default",
  routes: [
    {
      id: "wordpress",
      enabled: true,
      desiredState: "present",
      destination: { extensionId: "blogmaatic.wordpress-rest", connectionId: "wp", channel: "main" },
      requiredCapabilities: ["article.create", "article.inspect"],
    },
    {
      id: "linkedin",
      enabled: true,
      desiredState: "present",
      destination: { extensionId: "blogmaatic.linkedin-rest", connectionId: "li", channel: "company" },
      requiredCapabilities: ["article.create", "article.inspect"],
    },
  ],
};

function definition(overrides = {}) {
  return {
    id: "publish-approved",
    version: 1,
    name: "Publish approved content",
    enabled: true,
    trigger: { kind: "event", eventType: "publication.approved" },
    conditions: { statuses: ["approved"], tagsAny: ["technology"] },
    steps: [
      { id: "editor", kind: "approval", role: "editor" },
      { id: "publish", kind: "publish_group", groupId: "primary" },
    ],
    ...overrides,
  };
}

test("matches enabled event automations against publication conditions", () => {
  assert.equal(
    automationMatchesPublication(definition(), publication(), {
      kind: "event",
      eventType: "publication.approved",
      eventId: "evt-1",
      occurredAt: "2026-09-22T12:01:00.000Z",
    }),
    true,
  );
  assert.equal(
    automationMatchesPublication(definition(), publication({ status: "draft" }), {
      kind: "event",
      eventType: "publication.approved",
      eventId: "evt-2",
      occurredAt: "2026-09-22T12:01:00.000Z",
    }),
    false,
  );
});

test("rejects duplicate step identities and missing groups", () => {
  assert.throws(
    () => validateAutomationDefinition(definition({ steps: [
      { id: "same", kind: "approval", role: "editor" },
      { id: "same", kind: "delay", durationMs: 1000 },
    ] })),
    /duplicated/,
  );

  assert.throws(
    () => validateAutomationRunRequest({
      runId: "run-1",
      definition: definition(),
      trigger: {
        kind: "event",
        eventType: "publication.approved",
        eventId: "evt-1",
        occurredAt: "2026-09-22T12:01:00.000Z",
      },
      publication: publication(),
      groups: [],
    }),
    /missing publication group primary/,
  );
});

test("automation approval becomes revision-bound route grants", () => {
  const grants = approvalGrantsForGroup(group, publication(), [
    {
      runId: "run-1",
      stepId: "editor",
      revisionId: "rev-1",
      role: "editor",
      approvedBy: "editor-1",
      decision: "approve",
      decidedAt: "2026-09-22T12:05:00.000Z",
    },
    {
      runId: "run-1",
      stepId: "legal",
      revisionId: "old-rev",
      role: "legal",
      approvedBy: "legal-1",
      decision: "approve",
      decidedAt: "2026-09-22T12:05:00.000Z",
    },
  ]);

  assert.deepEqual(grants.map((grant) => [grant.routeId, grant.role]), [
    ["wordpress", "editor"],
    ["linkedin", "editor"],
  ]);
});
