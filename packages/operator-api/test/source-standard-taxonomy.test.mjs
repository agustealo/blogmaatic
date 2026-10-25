import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-standard-taxonomy-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-standard-taxonomy-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });

  let input;
  let calls = 0;
  const publication = {
    publication: {
      id: "publication-taxonomy",
      createdAt: "2026-10-24T23:20:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-24T23:20:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Taxonomy",
          language: "en",
          blocks: [],
          assets: [],
          tags: ["shared-tag"],
          attributes: { categories: ["Shared"] },
        },
      },
      provenance: { source: "blogmaatic.publication-workspace" },
    },
    version: 5,
    recordedAt: "2026-10-24T23:20:00.000Z",
    updatedAt: "2026-10-24T23:20:00.000Z",
  };

  const sourceContent = {
    async setStandardTaxonomy(connectionId, body) {
      calls += 1;
      input = { connectionId, body };
      return {
        publication,
        contentType: body.contentType,
        categories: ["Local A"],
        tags: ["site-a"],
      };
    },
  };

  const app = createOperatorApi({
    controlPlane,
    store,
    runtime: {
      async status() { return null; },
      async approve() { return { accepted: false }; },
      async result() { throw new Error("unused"); },
    },
    sourceContent,
    authorizer: new StaticBearerAuthorizer([{
      id: "operator-standard-taxonomy",
      token: TOKEN,
      permissions: ["source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-24T23:20:00.000Z" },
  });

  try {
    await fn({ app, store, state: () => ({ input, calls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("route-scoped standard taxonomy validates coordinates and records audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-a/standard-taxonomy",
      headers: bearer(),
      payload: {
        publicationId: "publication-taxonomy",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-a",
        routeId: "wordpress",
        categories: [" Local A ", "Local A"],
        tags: ["site-a", " site-a "],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().calls, 1);
    assert.deepEqual(state().input, {
      connectionId: "wp-a",
      body: {
        publicationId: "publication-taxonomy",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-a",
        routeId: "wordpress",
        categories: ["Local A"],
        tags: ["site-a"],
      },
    });

    const audit = await store.listAudit({ action: "source-taxonomy.standard.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.deepEqual(new Set(audit.items.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.resource.type, "publication");
    assert.equal(succeeded.resource.id, "publication-taxonomy");
    assert.equal(succeeded.evidence.connectionId, "wp-a");
    assert.equal(succeeded.evidence.groupId, "group-a");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.equal(succeeded.evidence.categoryCount, 1);
    assert.equal(succeeded.evidence.tagCount, 1);
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-a/standard-taxonomy",
      headers: bearer(),
      payload: {
        publicationId: "publication-taxonomy",
        expectedVersion: 5,
        contentType: "posts",
        groupId: "group-a",
        categories: [],
        tags: [],
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().calls, 1);
  });
});
