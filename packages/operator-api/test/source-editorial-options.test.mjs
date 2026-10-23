import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-editorial-options-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-editorial-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let calls = 0;
  let input;
  const publication = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-23T15:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-23T15:05:00.000Z",
        content: { schemaVersion: 1, title: "Post", language: "en", blocks: [], assets: [], tags: [], attributes: {} },
      },
      provenance: { source: "wordpress", extensionId: "blogmaatic.wordpress-rest", connectionId: "wp-main", remoteId: "55" },
    },
    version: 5,
    recordedAt: "2026-10-23T15:05:00.000Z",
    updatedAt: "2026-10-23T15:05:00.000Z",
  };
  const sourceContent = {
    async setEditorialOptions(connectionId, body) {
      calls += 1;
      input = { connectionId, body };
      return {
        publication,
        contentType: body.contentType,
        passwordProtected: body.password.length > 0,
        commentStatus: body.commentStatus,
        pingStatus: body.pingStatus,
        sticky: body.sticky,
        format: body.format,
      };
    },
    async setPageStructure() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async listContentTypes() { return []; },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async createTaxonomy() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async list() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async get() { throw new Error("unused"); },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
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
      id: "operator-source-editorial",
      token: TOKEN,
      permissions: ["source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-23T15:05:00.000Z" },
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

test("source editorial options validate and audit without recording the WordPress content password", async () => {
  await withApi(async ({ app, store, state }) => {
    const contentPassword = "sample-content-access";
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/editorial-options",
      headers: headers(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "posts",
        password: contentPassword,
        commentStatus: "closed",
        pingStatus: "open",
        sticky: false,
        format: "quote",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().input.body.password, contentPassword);
    assert.equal(state().calls, 1);
    assert.equal(response.json().passwordProtected, true);
    assert.equal(JSON.stringify(response.json()).includes(contentPassword), false);

    const audit = await store.listAudit({ action: "source-editorial-options.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.equal(JSON.stringify(audit.items).includes(contentPassword), false);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.passwordProtected, true);
    assert.equal(succeeded.evidence.commentStatus, "closed");
    assert.equal(succeeded.evidence.pingStatus, "open");
    assert.equal(succeeded.evidence.sticky, false);
    assert.equal(succeeded.evidence.format, "quote");
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/editorial-options",
      headers: headers(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "posts",
        password: "locked-content",
        sticky: true,
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(state().calls, 1);
  });
});
