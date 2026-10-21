import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-content-types-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-types-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  const calls = [];
  const sourceContent = {
    async listContentTypes(connectionId) {
      calls.push(["types", connectionId]);
      return [{
        connectionId,
        extensionId: "blogmaatic.wordpress-rest",
        key: "pages",
        label: "Pages",
        hierarchical: true,
        metadata: {},
      }];
    },
    async list(connectionId, query) {
      calls.push(["list", connectionId, query]);
      return { items: [], page: 1, limit: 30, hasMore: false };
    },
    async get(connectionId, remoteId, contentType) {
      calls.push(["get", connectionId, remoteId, contentType]);
      return {
        connectionId,
        contentType,
        extensionId: "blogmaatic.wordpress-rest",
        remoteId,
        remoteUrl: "https://example.test/about",
        title: "About",
        excerpt: "",
        contentHtml: "<p>About</p>",
        slug: "about",
        status: "publish",
        managed: false,
        metadata: {},
      };
    },
    async revisions(connectionId, remoteId, contentType) {
      calls.push(["revisions", connectionId, remoteId, contentType]);
      return [];
    },
    async trash(connectionId, remoteId, contentType) {
      calls.push(["trash", connectionId, remoteId, contentType]);
      return this.get(connectionId, remoteId, contentType);
    },
    async restore() { throw new Error("unused"); },
    async deletePermanent() { throw new Error("unused"); },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async createTaxonomy() { throw new Error("unused"); },
    async import() { throw new Error("unused"); },
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
      id: "operator-source-types",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
  });
  try {
    await fn({ app, calls });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const headers = { authorization: `Bearer ${TOKEN}` };

test("source content type discovery and scoped operations forward one validated type", async () => {
  await withApi(async ({ app, calls }) => {
    const types = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/content-types",
      headers,
    });
    assert.equal(types.statusCode, 200);
    assert.equal(types.json().items[0].key, "pages");

    const list = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/content?contentType=pages&page=1&limit=30",
      headers,
    });
    assert.equal(list.statusCode, 200);

    const get = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/content/71?contentType=pages",
      headers,
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().contentType, "pages");

    const trash = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/content/71/trash?contentType=pages",
      headers,
    });
    assert.equal(trash.statusCode, 200);

    assert.deepEqual(calls.slice(0, 4), [
      ["types", "wp-main"],
      ["list", "wp-main", { contentType: "pages", page: 1, limit: 30 }],
      ["get", "wp-main", "71", "pages"],
      ["trash", "wp-main", "71", "pages"],
    ]);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/content?contentType=Pages!",
      headers,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
  });
});
