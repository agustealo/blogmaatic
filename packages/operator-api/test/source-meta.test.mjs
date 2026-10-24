import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-meta-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-meta-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let listCalls = 0;
  let setCalls = 0;
  let setInput;
  const fields = [{
    key: "isbn",
    type: "string",
    nullable: false,
    title: "ISBN",
    description: "Book ISBN",
    metadata: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "books",
      source: "wordpress-rest-meta",
    },
  }];
  const publication = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-24T20:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-24T21:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Book",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            sourceMeta: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-main",
              contentType: "books",
              values: { isbn: "SENSITIVE-META-VALUE" },
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
    recordedAt: "2026-10-24T21:00:00.000Z",
    updatedAt: "2026-10-24T21:00:00.000Z",
  };
  const sourceContent = {
    async listMetaFields(connectionId, contentType) {
      listCalls += 1;
      assert.equal(connectionId, "wp-main");
      assert.equal(contentType, "books");
      return fields;
    },
    async setMetaValues(connectionId, body) {
      setCalls += 1;
      setInput = { connectionId, body };
      return {
        publication,
        contentType: "books",
        values: body.values,
      };
    },
    async listTaxonomies() { return []; },
    async setTaxonomySelections() { throw new Error("unused"); },
    async createTaxonomy() { throw new Error("unused"); },
    async listTaxonomy() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async revisions() { return []; },
    async restoreRevision() { throw new Error("unused"); },
    async listAuthors() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async assignAuthor() { throw new Error("unused"); },
    async setEditorialOptions() { throw new Error("unused"); },
    async setPageStructure() { throw new Error("unused"); },
    async setPublishingState() { throw new Error("unused"); },
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
      id: "operator-source-meta",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-24T21:00:00.000Z" },
  });
  try {
    await fn({
      app,
      store,
      state: () => ({ listCalls, setCalls, setInput }),
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

test("REST meta schema discovery and mutation are validated while audit records keys only", async () => {
  await withApi(async ({ app, store, state }) => {
    const schema = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/meta-fields?contentType=books",
      headers: bearer(),
    });
    assert.equal(schema.statusCode, 200, schema.body);
    assert.equal(schema.json().items[0].key, "isbn");
    assert.equal(state().listCalls, 1);

    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/meta-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "books",
        values: {
          isbn: "SENSITIVE-META-VALUE",
          rating: 4.5,
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().setInput, {
      connectionId: "wp-main",
      body: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "books",
        values: {
          isbn: "SENSITIVE-META-VALUE",
          rating: 4.5,
        },
      },
    });
    assert.equal(state().setCalls, 1);

    const audit = await store.listAudit({ action: "source-meta.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const serialized = JSON.stringify(audit.items);
    assert.doesNotMatch(serialized, /SENSITIVE-META-VALUE/);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-source-meta");
    assert.deepEqual(succeeded.evidence.fieldKeys, ["isbn", "rating"]);
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/meta-values",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 0,
        contentType: "books",
        values: { isbn: "MUST-NOT-RUN" },
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().setCalls, 1);

    const missingType = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/meta-fields",
      headers: bearer(),
    });
    assert.equal(missingType.statusCode, 400);
    assert.equal(state().listCalls, 1);
  });
});
