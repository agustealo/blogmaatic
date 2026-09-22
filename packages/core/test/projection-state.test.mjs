import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionRegistry,
  InMemoryProjectionStateStore,
  PolicyEngine,
  PublicationKernel,
} from "../dist/index.js";

const clock = { now: () => "2026-09-22T18:00:00.000Z" };

const publication = {
  id: "pub-state",
  createdAt: "2026-09-22T12:00:00.000Z",
  status: "approved",
  current: {
    id: "rev-state",
    ordinal: 1,
    createdAt: "2026-09-22T12:00:00.000Z",
    content: {
      schemaVersion: 1,
      title: "Stateful projection",
      language: "en",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "hello" } }],
      assets: [],
      tags: [],
      attributes: {},
    },
  },
  provenance: {},
};

const group = {
  id: "group-state",
  name: "State",
  policySetId: "allow",
  routes: [{
    id: "route-state",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "contract.remote-only",
      connectionId: "connection-state",
      channel: "primary",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
  }],
};

class RemoteOnlyPublisher {
  manifest = {
    id: "contract.remote-only",
    displayName: "Remote Only",
    version: "1.0.0",
    capabilities: ["article.create", "article.update", "article.inspect"],
  };

  constructor(remoteState) {
    this.remoteState = remoteState;
    this.deliveryCount = 0;
  }

  async compile({ publication: item, route }) {
    return {
      projectionId: `${item.id}:${route.id}`,
      publicationId: item.id,
      sourceRevisionId: item.current.id,
      routeId: route.id,
      destination: route.destination,
      payload: { title: item.current.content.title },
      fingerprint: `${item.current.id}:${item.current.content.title}`,
    };
  }

  async inspect({ projection, remote }) {
    if (!remote) return { state: "missing", observedAt: clock.now() };
    const fingerprint = this.remoteState.get(remote.id);
    if (!fingerprint) return { state: "missing", observedAt: clock.now() };
    return {
      state: fingerprint === projection.fingerprint ? "synchronized" : "drifted",
      remote,
      fingerprint,
      observedAt: clock.now(),
    };
  }

  async deliver(request) {
    this.deliveryCount += 1;
    const remote = request.existingRemote ?? { id: "remote-state-1" };
    this.remoteState.set(remote.id, request.projection.fingerprint);
    return {
      remote,
      acceptedAt: clock.now(),
      evidence: { deliveryCount: this.deliveryCount },
    };
  }
}

function makeKernel(publisher, projectionState) {
  const extensions = new ExtensionRegistry();
  extensions.register(publisher);
  const policies = new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]);
  return new PublicationKernel(extensions, policies, clock, projectionState);
}

test("stored remote identity prevents duplicate creation after kernel restart", async () => {
  const remoteState = new Map();
  const projectionState = new InMemoryProjectionStateStore();
  const firstPublisher = new RemoteOnlyPublisher(remoteState);
  const firstKernel = makeKernel(firstPublisher, projectionState);

  const first = await firstKernel.publish({ publication, group });
  assert.equal(first[0].status, "verified");
  assert.equal(firstPublisher.deliveryCount, 1);

  const secondPublisher = new RemoteOnlyPublisher(remoteState);
  const secondKernel = makeKernel(secondPublisher, projectionState);
  const second = await secondKernel.publish({ publication, group });

  assert.equal(second[0].status, "verified");
  assert.equal(second[0].remote.id, "remote-state-1");
  assert.equal(secondPublisher.deliveryCount, 0);
});
