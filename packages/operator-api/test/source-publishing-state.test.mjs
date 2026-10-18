import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-publishing-state-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-publishing-state-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let stateInput;
  let stateCalls = 0;
  const publication = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-18T16:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            sourcePublishing: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-main",
              status: "future",
              scheduledAt: "2026-11-01T18:30:00.000Z",
            },
          },
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 5,
    recordedAt: "2026-10-18T16:00:00.000Z",
    updatedAt: "2026-10-18T16:00:00.000Z",
  };
  const sourceContent = {
    async setPublishingState(connectionId, body) {
      stateCalls += 1;
      assert.equal(connectionId, "wp-main");
      stateInput = body;
      return {
        publication,
        status: "future",
        scheduledAt: "2026-11-01T18:30:00.000Z",
      };
    },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async list() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async get() { throw new Error("unused"); },
    async revisions() { return []; },
    async import() { throw new Error("unused"); },
    async trash() { throw new Error("unused"); },
    async restore() { throw new Error("unused"); },
    async deletePermanent() { throw new Error("unused"); },
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
      id: "operator-source-publishing-state",
      token: TOKEN,
      permissions: ["source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-18T16:00:00.000Z" },
  });
  try {
    await fn({
      app,
      store,
      state: () => ({ stateInput, stateCalls }),
    });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("source publishing state mutation is validated and audited with canonical revision evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/publishing-state",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        status: "future",
        scheduledAt: "2026-11-01T18:30:00.000Z",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().stateInput, {
      publicationId: "publication-wp",
      expectedVersion: 4,
      status: "future",
      scheduledAt: "2026-11-01T18:30:00.000Z",
    });
    assert.equal(state().stateCalls, 1);
    assert.equal(response.json().publication.version, 5);

    const audit = await store.listAudit({ action: "source-publishing-state.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.deepEqual(new Set(audit.items.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-source-publishing-state");
    assert.equal(succeeded.resource.type, "publication");
    assert.equal(succeeded.resource.id, "publication-wp");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.status, "future");
    assert.equal(succeeded.evidence.scheduledAt, "2026-11-01T18:30:00.000Z");
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/publishing-state",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 0,
        status: "draft",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().stateCalls, 1);
  });
});
