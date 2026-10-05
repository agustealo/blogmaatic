import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteProjectionStateStore } from "../dist/index.js";

test("persists projection identity across store restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-state-"));
  const path = join(directory, "projection-state.sqlite");
  try {
    const first = new SqliteProjectionStateStore(path);
    await first.put({
      publicationId: "pub-1",
      routeId: "route-linkedin",
      projectionId: "pub-1:route-linkedin",
      extensionId: "blogmaatic.linkedin-rest",
      connectionId: "linkedin-company",
      sourceRevisionId: "rev-4",
      desiredFingerprint: "abc123",
      remote: {
        id: "urn:li:share:123",
        url: "https://www.linkedin.com/feed/update/urn:li:share:123",
      },
      updatedAt: "2026-09-22T18:00:00.000Z",
    });
    first.close();

    const second = new SqliteProjectionStateStore(path);
    const restored = await second.get("pub-1", "route-linkedin");
    assert.equal(restored?.remote.id, "urn:li:share:123");
    assert.equal(restored?.desiredFingerprint, "abc123");
    await second.delete("pub-1", "route-linkedin");
    assert.equal(await second.get("pub-1", "route-linkedin"), undefined);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("preserves append-only publication distribution history across revisions and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-distribution-"));
  const path = join(directory, "distribution-state.sqlite");
  const group = {
    id: "group-network",
    name: "Network",
    policySetId: "default",
    routes: [{
      id: "route-wordpress",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wordpress-main",
        channel: "posts",
      },
      requiredCapabilities: ["article.create"],
      desiredState: "present",
      enabled: true,
    }],
  };
  const receipt = (revisionId, remoteId, completedAt) => ({
    publicationId: "pub-1",
    revisionId,
    groupId: group.id,
    routeId: "route-wordpress",
    projectionId: "pub-1:route-wordpress",
    idempotencyKey: `publication:pub-1:${revisionId}:route-wordpress:test`,
    status: "verified",
    policy: { effect: "allow", reason: "test" },
    remote: { id: remoteId, url: `https://example.test/?p=${remoteId}` },
    completedAt,
  });

  try {
    const first = new SqliteProjectionStateStore(path);
    for (const [id, revisionId, remoteId, completedAt] of [
      ["delivery-1", "rev-1", "101", "2026-10-05T01:00:00.000Z"],
      ["delivery-2", "rev-2", "101", "2026-10-05T02:00:00.000Z"],
    ]) {
      const delivery = receipt(revisionId, remoteId, completedAt);
      await first.append({
        id,
        runId: `run-${revisionId}`,
        publicationId: "pub-1",
        revisionId,
        groupId: group.id,
        routeId: "route-wordpress",
        projectionId: "pub-1:route-wordpress",
        destination: group.routes[0].destination,
        groupSnapshot: group,
        receipt: delivery,
        recordedAt: completedAt,
      });
    }
    await first.append({
      id: "delivery-2",
      runId: "run-rev-2",
      publicationId: "pub-1",
      revisionId: "rev-2",
      groupId: group.id,
      routeId: "route-wordpress",
      projectionId: "pub-1:route-wordpress",
      destination: group.routes[0].destination,
      groupSnapshot: group,
      receipt: receipt("rev-2", "101", "2026-10-05T02:00:00.000Z"),
      recordedAt: "2026-10-05T02:00:00.000Z",
    });
    first.close();

    const second = new SqliteProjectionStateStore(path);
    const page = await second.list("pub-1");
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].revisionId, "rev-2");
    assert.equal(page.items[1].revisionId, "rev-1");
    assert.equal(page.items[0].groupSnapshot.routes[0].destination.connectionId, "wordpress-main");
    assert.equal(page.items[0].receipt.remote.id, "101");

    const revision = await second.list("pub-1", { revisionId: "rev-1" });
    assert.equal(revision.items.length, 1);
    assert.equal(revision.items[0].id, "delivery-1");
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
