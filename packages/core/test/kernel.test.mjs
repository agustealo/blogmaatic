import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionRegistry,
  InMemoryDistributionHistoryStore,
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

  async compile({ publication: item, route, groupId }) {
    const fingerprint = `${item.current.id}:${item.current.content.title}`;
    return {
      projectionId: `${item.id}:${groupId ?? "legacy"}:${route.id}`,
      ...(groupId ? { groupId } : {}),
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
    const key = `${request.projection.groupId ?? "legacy"}:${request.projection.routeId}`;
    const remote = request.existingRemote ?? {
      id: `remote-${request.projection.groupId ?? "legacy"}-${request.projection.routeId}`,
      url: "https://publisher.invalid/post/1",
    };
    this.#remote.set(key, {
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
    const key = `${projection.groupId ?? "legacy"}:${projection.routeId}`;
    const record = this.#remote.get(key);
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

  forceFingerprint(routeId, fingerprint, groupId = "group-1") {
    const key = `${groupId}:${routeId}`;
    const record = this.#remote.get(key);
    if (!record) throw new Error("Cannot drift a missing route");
    this.#remote.set(key, { ...record, fingerprint });
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

  const projection = await fixture.publisher.compile({
    publication: item,
    route: publicationGroup.routes[0],
    groupId: publicationGroup.id,
  });
  assert.equal(
    receipts[0].idempotencyKey,
    deliveryIdempotencyKey(item, publicationGroup.id, publicationGroup.routes[0], projection),
  );
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
  assert.equal(second[0].remote.id, "remote-group-1-route-1");
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
  assert.equal(fixture.publisher.lastExistingRemote.id, "remote-group-1-route-1");
  assert.equal(receipts[0].remote.id, "remote-group-1-route-1");
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


test("records the exact group snapshot and run identity in distribution history", async () => {
  const publisher = new ContractPublisher();
  const registry = new ExtensionRegistry();
  registry.register(publisher);
  const policies = new PolicyEngine([{ id: "default", defaultEffect: "allow", rules: [] }]);
  const history = new InMemoryDistributionHistoryStore();
  const publicationGroup = group();
  const item = publication();
  const publicationKernel = new PublicationKernel(
    registry,
    policies,
    fixedClock,
    undefined,
    history,
  );

  const receipts = await publicationKernel.publish({
    publication: item,
    group: publicationGroup,
    runId: "run-42",
  });
  const page = await history.list(item.id);

  assert.equal(receipts.length, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].runId, "run-42");
  assert.equal(page.items[0].revisionId, item.current.id);
  assert.equal(page.items[0].destination.connectionId, "connection-1");
  assert.deepEqual(page.items[0].groupSnapshot, publicationGroup);
  assert.equal(page.items[0].receipt.status, "verified");
});


test("same route id in different publication groups has isolated projection and remote identity", async () => {
  const fixture = kernel();
  const item = publication();
  const firstGroup = group();
  const secondGroup = {
    ...group(),
    id: "group-2",
    name: "Secondary",
    routes: [{
      ...group().routes[0],
      destination: {
        ...group().routes[0].destination,
        connectionId: "connection-2",
      },
    }],
  };

  const first = await fixture.kernel.publish({ publication: item, group: firstGroup });
  const second = await fixture.kernel.publish({ publication: item, group: secondGroup });

  assert.equal(first[0].status, "verified");
  assert.equal(second[0].status, "verified");
  assert.notEqual(first[0].projectionId, second[0].projectionId);
  assert.notEqual(first[0].idempotencyKey, second[0].idempotencyKey);
  assert.equal(first[0].remote.id, "remote-group-1-route-1");
  assert.equal(second[0].remote.id, "remote-group-2-route-1");
  assert.equal(fixture.publisher.deliveryCount, 2);

  const repeatedFirst = await fixture.kernel.publish({ publication: item, group: firstGroup });
  const repeatedSecond = await fixture.kernel.publish({ publication: item, group: secondGroup });
  assert.equal(repeatedFirst[0].remote.id, "remote-group-1-route-1");
  assert.equal(repeatedSecond[0].remote.id, "remote-group-2-route-1");
  assert.equal(fixture.publisher.deliveryCount, 2);
});
