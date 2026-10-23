import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-page-structure-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-page-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let calls = 0;
  let input;
  const publication = {
    publication: {
      id: "publication-page",
      createdAt: "2026-10-21T18:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-21T18:05:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Page",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
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
    recordedAt: "2026-10-21T18:05:00.000Z",
    updatedAt: "2026-10-21T18:05:00.000Z",
  };
  const sourceContent = {
    async setPageStructure(connectionId, body) {
      calls += 1;
      input = { connectionId, body };
      return {
        publication,
        contentType: "pages",
        parentRemoteId: "77",
        template: "templates/landing.php",
        menuOrder: 4,
      };
    },
    async setPublishingState() { throw new Error("unused"); },
    async createTaxonomy() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async listContentTypes() { return []; },
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
      id: "operator-source-page",
      token: TOKEN,
      permissions: ["source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-21T18:05:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => ({ calls, input }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const headers = () => ({ authorization: `Bearer ${TOKEN}` });

test("source page structure validates full-state semantics and records audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/page-structure",
      headers: headers(),
      payload: {
        publicationId: "publication-page",
        expectedVersion: 4,
        contentType: "pages",
        parentRemoteId: "77",
        template: "templates/landing.php",
        menuOrder: 4,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().input, {
      connectionId: "wp-main",
      body: {
        publicationId: "publication-page",
        expectedVersion: 4,
        contentType: "pages",
        parentRemoteId: "77",
        template: "templates/landing.php",
        menuOrder: 4,
      },
    });
    assert.equal(state().calls, 1);

    const audit = await store.listAudit({ action: "source-page-structure.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.contentType, "pages");
    assert.equal(succeeded.evidence.parentRemoteId, "77");
    assert.equal(succeeded.evidence.template, "templates/landing.php");
    assert.equal(succeeded.evidence.menuOrder, 4);
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    for (const payload of [
      { publicationId: "publication-page", expectedVersion: 4, contentType: "pages", parentRemoteId: "abc", template: null, menuOrder: 0 },
      { publicationId: "publication-page", expectedVersion: 4, contentType: "pages", parentRemoteId: null, template: null, menuOrder: -1 },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/connections/wp-main/page-structure",
        headers: headers(),
        payload,
      });
      assert.equal(invalid.statusCode, 400);
    }
    assert.equal(state().calls, 1);
  });
});
