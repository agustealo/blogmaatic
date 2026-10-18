import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-revision-restore-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-revision-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let restoreArgs;
  let restoreCalls = 0;
  const revision = {
    remoteRevisionId: "9055",
    title: "Recovered title",
    excerpt: "<p>Recovered excerpt</p>",
    contentHtml: "<h2>Recovered</h2><p>Body</p>",
    createdAt: "2026-10-17T19:00:00",
    modifiedAt: "2026-10-17T20:00:00",
    metadata: { parentId: 55, authorId: 9 },
  };
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
          title: "Recovered title",
          language: "en",
          blocks: [{ id: "source-revision-9055", kind: "embed", data: { html: revision.contentHtml } }],
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
    recordedAt: "2026-10-18T16:00:00.000Z",
    updatedAt: "2026-10-18T16:00:00.000Z",
  };
  const sourceContent = {
    async restoreRevision(connectionId, remoteId, remoteRevisionId, body) {
      restoreCalls += 1;
      restoreArgs = { connectionId, remoteId, remoteRevisionId, body };
      return { publication, revision };
    },
    async revisions() { return [revision]; },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
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
      id: "operator-source-revision",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-18T16:00:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => ({ restoreArgs, restoreCalls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("source revision restore validates path/body and records canonical audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/content/55/revisions/9055/restore",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().restoreArgs, {
      connectionId: "wp-main",
      remoteId: "55",
      remoteRevisionId: "9055",
      body: { publicationId: "publication-wp", expectedVersion: 4 },
    });
    assert.equal(state().restoreCalls, 1);
    assert.equal(response.json().publication.version, 5);
    assert.equal(response.json().revision.remoteRevisionId, "9055");

    const audit = await store.listAudit({ action: "source-content.revision.restore", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.deepEqual(new Set(audit.items.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-source-revision");
    assert.equal(succeeded.resource.type, "publication");
    assert.equal(succeeded.resource.id, "publication-wp");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.remoteId, "55");
    assert.equal(succeeded.evidence.remoteRevisionId, "9055");
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);
    assert.equal(succeeded.evidence.restoredRemoteRevisionId, "9055");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/content/55/revisions/9055/restore",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 0,
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().restoreCalls, 1);
  });
});
