import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionRegistry, PolicyEngine, PublicationKernel } from "../dist/index.js";

const clock = { now: () => "2026-09-22T19:10:00.000Z" };

const publication = {
  id: "pub-blocked-drift",
  createdAt: "2026-09-22T18:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-1",
    ordinal: 1,
    createdAt: "2026-09-22T18:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Immutable Social Projection",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "Original" } }],
      assets: [],
      tags: [],
      attributes: {},
    },
  },
  provenance: {},
};

const group = {
  id: "group-1",
  name: "Social",
  policySetId: "default",
  routes: [{
    id: "route-1",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "contract.immutable",
      connectionId: "connection-1",
      channel: "feed",
    },
    requiredCapabilities: ["article.create", "article.inspect"],
  }],
};

class ImmutablePublisher {
  manifest = {
    id: "contract.immutable",
    displayName: "Immutable Publisher",
    version: "1.0.0",
    capabilities: ["article.create", "article.inspect"],
  };

  created = false;
  deliveryCount = 0;
  drift = false;

  async compile({ publication: item, route }) {
    return {
      projectionId: `${item.id}:${route.id}`,
      publicationId: item.id,
      sourceRevisionId: item.current.id,
      routeId: route.id,
      destination: route.destination,
      payload: { title: item.current.content.title },
      fingerprint: "desired",
    };
  }

  async inspect() {
    if (!this.created) return { state: "missing", observedAt: clock.now() };
    return {
      state: this.drift ? "drifted" : "synchronized",
      remote: { id: "remote-1" },
      fingerprint: this.drift ? "remote-edit" : "desired",
      observedAt: clock.now(),
    };
  }

  planDriftReconciliation() {
    return {
      action: "blocked",
      reason: "Provider does not support safe in-place mutation for this projection",
    };
  }

  async deliver() {
    this.deliveryCount += 1;
    this.created = true;
    return {
      remote: { id: "remote-1" },
      acceptedAt: clock.now(),
      evidence: {},
    };
  }
}

function fixture() {
  const publisher = new ImmutablePublisher();
  const registry = new ExtensionRegistry();
  registry.register(publisher);
  const policies = new PolicyEngine([{ id: "default", defaultEffect: "allow", rules: [] }]);
  return { publisher, kernel: new PublicationKernel(registry, policies, clock) };
}

test("publisher can block drift repair without claiming update capability", async () => {
  const { publisher, kernel } = fixture();
  const first = await kernel.publish({ publication, group });
  assert.equal(first[0].status, "verified");
  assert.equal(publisher.deliveryCount, 1);

  publisher.drift = true;
  const report = await kernel.reconcile(publication, group);
  assert.equal(report.items[0].action, "blocked");
  assert.match(report.items[0].reason, /does not support safe in-place mutation/);

  const second = await kernel.publish({ publication, group });
  assert.equal(second[0].status, "blocked");
  assert.equal(publisher.deliveryCount, 1);
  assert.equal(second[0].remote.id, "remote-1");
});
