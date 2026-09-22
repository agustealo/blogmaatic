import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionRegistry,
  PolicyEngine,
  PublicationKernel,
  deliveryIdempotencyKey,
} from "../dist/index.js";

const fixedClock = { now: () => "2026-09-22T16:00:00.000Z" };

function publication(overrides = {}) {
  return {
    id: "pub-1",
    status: "approved",
    current: {
      id: "rev-7",
      ordinal: 7,
      createdAt: "2026-09-22T15:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Maintain Everywhere",
        language: "en",
        blocks: [{ id: "b1", kind: "paragraph", data: { text: "Publish once." } }],
        assets: [],
        tags: ["technology"],
        attributes: {},
      },
    },
    provenance: { author: "owner" },
    ...overrides,
  };
}

function group(extensionId = "contract.publisher") {
  return {
    id: "group-1",
    name: "Technology",
    policySetId: "default",
    routes: [
      {
        id: "route-1",
        enabled: true,
        desiredState: "present",
        destination: {
          extensionId,
          connectionId: "connection-1",
          channel: "primary",
        },
        requiredCapabilities: ["article.create", "article.inspect"],
      },
    ],
  };
}

class ContractPublisher {
  manifest = {
    id: "contract.publisher",
    displayName: "Contract Publisher",
    version: "1.0.0",
    capabilities: ["article.create", "article.update", "article.inspect"],
  };

  #remote = new Map();
  deliveryCount = 0;
  lastExistingRemote = undefined;

  async compile({ publication: item, route }) {
    const fingerprint = `${item.current.id}:${item.current.content.title}`;
    return {
      projectionId: `${item.id}:${route.id}`,
      publicationId: item.id,
      sourceRevisionId: item.current.id,
      routeId: route.id,
      destination: route.destination,
      payload: { title: item.current.content.title },
      fingerprint,
    };
  }

  async deliver(request) {
    this.deliveryCount += 1;
    this.lastExistingRemote = request.existingRemote;
    const remote = request.existingRemote ?? {
      id: `remote-${request.projection.routeId}`,
      url: "https://publisher.invalid/post/1",
    };
    this.#remote.set(request.projection.routeId, {
      remote,
      fingerprint: request.projection.fingerprint,
    });
    return {
      remote,
      acceptedAt: fixedClock.now(),
      evidence: { idempotencyKey: request.idempotencyKey },
    };
  }

  async inspect({ projection }) {
    const record = this.#remote.get(projection.routeId);
    if (!record) {
      return { state: "missing", observedAt: fixedClock.now() };
    }
    const synchronized = record.fingerprint === projection.fingerprint;
    return {
      state: synchronized ? "synchronized" : "drifted",
      remote: record.remote,
      fingerprint: record.fingerprint,
      observedAt: fixedClock.now(),
    };
  }

  forceFingerprint(routeId, fingerprint) {
    const record = this.#remote.get(routeId);
    if (!record) throw new Error("Cannot drift a missing route");
    this.#remote.set(routeId, { ...record, fingerprint });
  }
}

function kernel({ rules = [], defaultEffect = "allow" } = {}) {
  const publisher = new ContractPublisher();
  const registry = new ExtensionRegistry();
  registry.register(publisher);
  const policies = new PolicyEngine([
    {
      id: "default",
      defaultEffect,
      rules,
    },
  ]);
  return {
    publisher,
    kernel: new PublicationKernel(registry, policies, fixedClock),
  };
}

test("publishes, verifies, and emits a stable idempotency key", async () => {
  const fixture = kernel();
  const item = publication();
  const publicationGroup = group();
  const receipts = await fixture.kernel.publish({ publication: item, group: publicationGroup });

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "verified");
  assert.equal(fixture.publisher.deliveryCount, 1);

  const projection = await fixture.publisher.compile({ publication: item, route: publicationGroup.routes[0] });
  assert.equal(receipts[0].idempotencyKey, deliveryIdempotencyKey(item, publicationGroup.routes[0], projection));
});

test("repeated publication is a no-op when the remote already matches", async () => {
  const fixture = kernel();
  const item = publication();
  const publicationGroup = group();

  const first = await fixture.kernel.publish({ publication: item, group: publicationGroup });
  const second = await fixture.kernel.publish({ publication: item, group: publicationGroup });

  assert.equal(first[0].status, "verified");
  assert.equal(second[0].status, "verified");
  assert.equal(fixture.publisher.deliveryCount, 1);
  assert.equal(second[0].remote.id, "remote-route-1");
});

test("drifted projections update the existing remote identity instead of creating a duplicate", async () => {
  const fixture = kernel();
  const item = publication();
  const publicationGroup = group();

  await fixture.kernel.publish({ publication: item, group: publicationGroup });
  fixture.publisher.forceFingerprint("route-1", "external-edit");
  const receipts = await fixture.kernel.publish({ publication: item, group: publicationGroup });

  assert.equal(receipts[0].status, "verified");
  assert.equal(fixture.publisher.deliveryCount, 2);
  assert.equal(fixture.publisher.lastExistingRemote.id, "remote-route-1");
  assert.equal(receipts[0].remote.id, "remote-route-1");
});

test("fails closed when a route requires a capability the extension does not provide", async () => {
  const fixture = kernel();
  const publicationGroup = group();
  publicationGroup.routes[0].requiredCapabilities = ["article.create", "article.schedule"];

  await assert.rejects(
    fixture.kernel.publish({ publication: publication(), group: publicationGroup }),
    /missing required capabilities: article.schedule/,
  );
});

test("requires approval for the exact publication revision before delivery", async () => {
  const fixture = kernel({
    rules: [
      {
        id: "legal-approval",
        description: "Technology publications require editorial approval",
        match: { tagsAny: ["technology"] },
        effect: "require_approval",
        approvalRole: "editor",
      },
    ],
  });
  const item = publication();
  const publicationGroup = group();

  const blocked = await fixture.kernel.publish({ publication: item, group: publicationGroup });
  assert.equal(blocked[0].status, "awaiting_approval");
  assert.equal(fixture.publisher.deliveryCount, 0);

  const approved = await fixture.kernel.publish({
    publication: item,
    group: publicationGroup,
    approvals: [
      {
        routeId: "route-1",
        role: "editor",
        approvedBy: "editor-1",
        approvedRevisionId: "rev-7",
        approvedAt: fixedClock.now(),
      },
    ],
  });
  assert.equal(approved[0].status, "verified");
  assert.equal(fixture.publisher.deliveryCount, 1);
});

test("reconciliation detects remote drift without publishing again", async () => {
  const fixture = kernel();
  const item = publication();
  const publicationGroup = group();

  await fixture.kernel.publish({ publication: item, group: publicationGroup });
  fixture.publisher.forceFingerprint("route-1", "external-edit");

  const report = await fixture.kernel.reconcile(item, publicationGroup);
  assert.equal(report.items[0].action, "update");
  assert.equal(report.items[0].observed.state, "drifted");
  assert.equal(fixture.publisher.deliveryCount, 1);
});

test("denied policy routes never invoke the publisher", async () => {
  const fixture = kernel({ defaultEffect: "deny" });
  const receipts = await fixture.kernel.publish({ publication: publication(), group: group() });

  assert.equal(receipts[0].status, "blocked");
  assert.equal(fixture.publisher.deliveryCount, 0);
});
