import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-rest-fields-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-rest-fields-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let updateArgs;
  let updateCalls = 0;
  const fields = [
    {
      key: "reading_time",
      type: "integer",
      nullable: false,
      title: "Reading time",
      metadata: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        contentType: "books",
        source: "wordpress-rest-field",
      },
    },
  ];
  const publication = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-11-13T23:20:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-11-13T23:20:00.000Z",
        content: {
          schemaVersion: 1,
          title: "REST field proof",
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
    recordedAt: "2026-11-13T23:20:00.000Z",
    updatedAt: "2026-11-13T23:20:00.000Z",
  };
  const sourceContent = {
    async listRestFields(connectionId, contentType) {
      assert.equal(connectionId, "wp-main");
      assert.equal(contentType, "books");
      return fields;
    },
    async setRestFieldValues(connectionId, body) {
      updateCalls += 1;
      updateArgs = { connectionId, body };
      return {
        publication,
        contentType: "books",
        values: body.values,
      };
    },
    async listMetaFields() { return []; },
    async setMetaValues() { throw new Error("unused"); },
    async listSeoFields() { return []; },
    async setSeoValues() { throw new Error("unused"); },
    async listTaxonomyDefinitions() { return []; },
    async createTaxonomy() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
    async listAssets() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async uploadAsset() { throw new Error("unused"); },
    async attachAsset() { throw new Error("unused"); },
    async setFeaturedMedia() { throw new Error("unused"); },
    async setStandardTaxonomy() { throw new Error("unused"); },
    async setTaxonomySelections() { throw new Error("unused"); },
    async setEditorialOptions() { throw new Error("unused"); },
    async setPageStructure() { throw new Error("unused"); },
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
      id: "operator-source-rest-fields",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-11-13T23:20:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => ({ updateArgs, updateCalls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("top-level REST fields are discoverable and audited updates record keys without values", async () => {
  await withApi(async ({ app, store, state }) => {
    const discovery = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/rest-fields?contentType=books",
      headers: bearer(),
    });
    assert.equal(discovery.statusCode, 200, discovery.body);
    assert.deepEqual(discovery.json().items[0], {
      key: "reading_time",
      type: "integer",
      nullable: false,
      title: "Reading time",
      metadata: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        contentType: "books",
        source: "wordpress-rest-field",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/rest-field-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "books",
        groupId: "group-main",
        routeId: "wordpress",
        values: {
          reading_time: 12,
          shelf_label: "Reference",
          promo_data: { badge: "private-value-proof" },
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().updateArgs, {
      connectionId: "wp-main",
      body: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "books",
        groupId: "group-main",
        routeId: "wordpress",
        values: {
          reading_time: 12,
          shelf_label: "Reference",
          promo_data: { badge: "private-value-proof" },
        },
      },
    });
    assert.equal(state().updateCalls, 1);

    const audit = await store.listAudit({ action: "source-rest-fields.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.deepEqual(succeeded.evidence.fieldKeys, ["promo_data", "reading_time", "shelf_label"]);
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    const serializedAudit = JSON.stringify(audit.items);
    assert.equal(serializedAudit.includes("Reference"), false);
    assert.equal(serializedAudit.includes("private-value-proof"), false);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/rest-field-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 0,
        contentType: "books",
        values: { reading_time: 12 },
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().updateCalls, 1);
  });
});
