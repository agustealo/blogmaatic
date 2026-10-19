import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-taxonomy-create-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-taxonomy-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let createArgs;
  let createCalls = 0;
  const created = {
    connectionId: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    kind: "category",
    remoteId: "91",
    name: "Deep Publishing",
    slug: "deep-publishing",
    description: "Editorial automation",
    count: 0,
    metadata: { wordpressTermId: 91 },
  };
  const sourceContent = {
    async createTaxonomy(connectionId, body) {
      createCalls += 1;
      createArgs = { connectionId, body };
      return created;
    },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async list() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async get() { throw new Error("unused"); },
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
      id: "operator-source-taxonomy",
      token: TOKEN,
      permissions: ["source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-18T17:05:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => ({ createArgs, createCalls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("source taxonomy create validates, forwards, and records remote audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/taxonomy",
      headers: bearer(),
      payload: {
        kind: "category",
        name: " Deep Publishing ",
        description: "Editorial automation",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().createArgs, {
      connectionId: "wp-main",
      body: {
        kind: "category",
        name: "Deep Publishing",
        description: "Editorial automation",
      },
    });
    assert.equal(state().createCalls, 1);
    assert.equal(response.json().remoteId, "91");
    assert.equal(response.json().slug, "deep-publishing");

    const audit = await store.listAudit({ action: "source-taxonomy.create", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.deepEqual(new Set(audit.items.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-source-taxonomy");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.kind, "category");
    assert.equal(succeeded.evidence.name, "Deep Publishing");
    assert.equal(succeeded.evidence.requestedSlug, null);
    assert.equal(succeeded.evidence.remoteId, "91");
    assert.equal(succeeded.evidence.slug, "deep-publishing");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/taxonomy",
      headers: bearer(),
      payload: { kind: "taxonomy", name: "Nope" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().createCalls, 1);
  });
});
