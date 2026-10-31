import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-seo-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-seo-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let listCalls = 0;
  let listQuery;
  let setInput;
  let setCalls = 0;
  const publication = {
    publication: {
      id: "publication-seo",
      createdAt: "2026-10-25T21:45:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-25T21:45:00.000Z",
        content: {
          schemaVersion: 1,
          title: "SEO proof",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: { source: "blogmaatic.publication-workspace" },
    },
    version: 5,
    recordedAt: "2026-10-25T21:45:00.000Z",
    updatedAt: "2026-10-25T21:45:00.000Z",
  };
  const sourceContent = {
    async listSeoFields(connectionId, contentType, query = {}) {
      listCalls += 1;
      assert.equal(connectionId, "wp-main");
      assert.equal(contentType, "posts");
      listQuery = query;
      return [
        {
          semantic: "description",
          key: "seo_description",
          label: "Meta description",
          provider: "generic-registered-meta",
          valueType: "text",
          currentValue: "Existing description",
          metadata: {
            extensionId: "blogmaatic.wordpress-rest",
            connectionId: "wp-main",
            contentType: "posts",
            source: "wordpress-rest-meta",
          },
        },
        {
          semantic: "robots_index",
          key: "seo_robots_index",
          label: "Index this content",
          provider: "generic-registered-meta",
          valueType: "boolean",
          currentValue: true,
          metadata: {
            extensionId: "blogmaatic.wordpress-rest",
            connectionId: "wp-main",
            contentType: "posts",
            source: "wordpress-rest-meta",
          },
        },
      ];
    },
    async setSeoValues(connectionId, body) {
      setCalls += 1;
      assert.equal(connectionId, "wp-main");
      setInput = body;
      return {
        publication,
        contentType: "posts",
        values: body.values,
      };
    },
    async listMetaFields() { return []; },
    async setMetaValues() { throw new Error("unused"); },
    async listContentTypes() { return []; },
    async list() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async get() { throw new Error("unused"); },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async setEditorialOptions() { throw new Error("unused"); },
    async setPageStructure() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async attachAsset() { throw new Error("unused"); },
    async uploadAsset() { throw new Error("unused"); },
    async setFeaturedMedia() { throw new Error("unused"); },
    async listTaxonomyDefinitions() { return []; },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async createTaxonomy() { throw new Error("unused"); },
    async setTaxonomySelections() { throw new Error("unused"); },
    async setStandardTaxonomy() { throw new Error("unused"); },
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
      id: "operator-source-seo",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-25T21:45:00.000Z" },
  });

  try {
    await fn({ app, store, state: () => ({ listCalls, listQuery, setCalls, setInput }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("SEO discovery requires content type and returns semantic writable fields", async () => {
  await withApi(async ({ app, state }) => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/seo-fields?contentType=posts&publicationId=publication-seo&groupId=group-main&routeId=wordpress",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state().listCalls, 1);
    assert.deepEqual(state().listQuery, {
      publicationId: "publication-seo",
      groupId: "group-main",
      routeId: "wordpress",
    });
    assert.equal(response.json().items[0].semantic, "description");
    assert.equal(response.json().items[1].semantic, "robots_index");
    assert.equal(response.json().items[1].currentValue, true);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/seo-fields",
      headers: bearer(),
    });
    assert.equal(missing.statusCode, 400);

    const incompleteRoute = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/seo-fields?contentType=posts&publicationId=publication-seo&groupId=group-main",
      headers: bearer(),
    });
    assert.equal(incompleteRoute.statusCode, 400);
    assert.equal(state().listCalls, 1);
  });
});

test("SEO updates are validated and audited without copying SEO values into evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const secretishText = "Launch plan alpha private phrase";
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/seo-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-seo",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
        values: {
          description: secretishText,
          robots_index: false,
          robots_follow: true,
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().setCalls, 1);
    assert.deepEqual(state().setInput.values, {
      description: secretishText,
      robots_index: false,
      robots_follow: true,
    });

    const audit = await store.listAudit({ action: "source-seo.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const serialized = JSON.stringify(audit.items);
    assert.equal(serialized.includes(secretishText), false);
    assert.equal(serialized.includes('"robots_index":false'), false);
    assert.equal(serialized.includes('"robots_follow":true'), false);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.deepEqual(succeeded.evidence.semantics, ["description", "robots_follow", "robots_index"]);
    assert.equal(succeeded.evidence.revisionId, "revision-2");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/seo-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-seo",
        expectedVersion: 4,
        contentType: "posts",
        values: { robots_magic: "index" },
      },
    });
    assert.equal(invalid.statusCode, 400);

    const wrongRobotType = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/seo-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-seo",
        expectedVersion: 4,
        contentType: "posts",
        values: { robots_index: "index" },
      },
    });
    assert.equal(wrongRobotType.statusCode, 400);

    const wrongTextType = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/seo-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-seo",
        expectedVersion: 4,
        contentType: "posts",
        values: { description: true },
      },
    });
    assert.equal(wrongTextType.statusCode, 400);
    assert.equal(state().setCalls, 1);
  });
});
