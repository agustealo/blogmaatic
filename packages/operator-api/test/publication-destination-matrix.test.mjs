import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "destination-matrix-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-destination-matrix-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });

  let matrixCalls = 0;
  const publication = {
    publication: {
      id: "publication-1",
      createdAt: "2026-10-24T19:00:00.000Z",
      status: "approved",
      current: {
        id: "revision-current",
        ordinal: 4,
        createdAt: "2026-10-24T21:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Matrix API",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: { source: "blogmaatic.publication-workspace" },
    },
    version: 4,
    recordedAt: "2026-10-24T21:00:00.000Z",
    updatedAt: "2026-10-24T21:00:00.000Z",
  };
  const matrix = {
    publicationId: "publication-1",
    currentRevisionId: "revision-current",
    currentRevisionOrdinal: 4,
    generatedAt: "2026-10-24T22:00:00.000Z",
    items: [{
      key: "group-a\u0000route-a\u0000blogmaatic.wordpress-rest\u0000wp-main\u0000posts",
      groupId: "group-a",
      groupName: "Primary",
      groupVersion: 2,
      routeId: "route-a",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        extensionName: "WordPress REST",
        connectionId: "wp-main",
        connectionName: "WordPress",
        channel: "posts",
      },
      state: "not_sent",
      currentRevisionId: "revision-current",
      currentRevisionOrdinal: 4,
      deliveryCount: 0,
      preview: {
        status: "ready",
        projectionId: "projection-current",
        fingerprint: "fingerprint-current",
      },
    }],
  };

  const app = createOperatorApi({
    controlPlane,
    store,
    runtime: {
      async status() { return null; },
      async approve() { return { accepted: false }; },
      async result() { throw new Error("unused"); },
    },
    publications: {
      async get(id) {
        return id === "publication-1" ? publication : undefined;
      },
      async list() { return { items: [] }; },
      async listVersions() { return { items: [] }; },
      async getVersion() { return undefined; },
      async create() { throw new Error("unused"); },
      async update() { throw new Error("unused"); },
      async approveAndDispatch() { throw new Error("unused"); },
    },
    destinationMatrix: {
      async get(id) {
        matrixCalls += 1;
        assert.equal(id, "publication-1");
        return matrix;
      },
    },
    authorizer: new StaticBearerAuthorizer([{
      id: "operator-destination-matrix",
      token: TOKEN,
      permissions: ["publications:read"],
      roles: ["publisher"],
    }]),
  });

  try {
    await fn({ app, state: () => ({ matrixCalls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("publication destination matrix route returns configured route truth", async () => {
  await withApi(async ({ app, state }) => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/publications/publication-1/destinations",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state().matrixCalls, 1);
    const body = response.json();
    assert.equal(body.currentRevisionId, "revision-current");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].state, "not_sent");
    assert.equal(body.items[0].preview.status, "ready");

    const missing = await app.inject({
      method: "GET",
      url: "/v1/publications/missing/destinations",
      headers: bearer(),
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "PUBLICATION_NOT_FOUND");
    assert.equal(state().matrixCalls, 1);
  });
});
