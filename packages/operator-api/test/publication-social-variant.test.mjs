import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "publication-social-variant-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-social-variant-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const controlPlane = new AutomationControlPlane({
    store,
    launcher: { async start(request) { return { runtimeId: `unused:${request.runId}` }; } },
  });
  let mutation;
  const current = {
    publication: {
      id: "publication-social",
      createdAt: "2026-10-25T00:40:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-25T00:40:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Social",
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
    recordedAt: "2026-10-25T00:40:00.000Z",
    updatedAt: "2026-10-25T00:40:00.000Z",
  };
  const updated = {
    ...current,
    version: 5,
    publication: {
      ...current.publication,
      current: {
        ...current.publication.current,
        id: "revision-2",
        ordinal: 2,
        attributes: undefined,
        content: {
          ...current.publication.current.content,
          attributes: {
            destinationOverrides: {
              schemaVersion: 1,
              groups: {
                "group-social": {
                  routes: {
                    social: {
                      extensionId: "blogmaatic.facebook-pages",
                      connectionId: "fb-main",
                      channel: "posts",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const publications = {
    async get(id) {
      return id === "publication-social" ? current : undefined;
    },
    async setDestinationSocialVariant(publicationId, expectedVersion, state) {
      mutation = { publicationId, expectedVersion, state };
      return updated;
    },
  };
  const app = createOperatorApi({
    controlPlane,
    store,
    runtime: {
      async status() { return null; },
      async approve() { return { accepted: false }; },
      async result() { throw new Error("unused"); },
    },
    publications,
    authorizer: new StaticBearerAuthorizer([{
      id: "operator-social",
      token: TOKEN,
      permissions: ["publications:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-25T00:40:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => mutation });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("publication social variant mutation records route modes without leaking commentary text", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/publications/publication-social/social-variant",
      headers: bearer(),
      payload: {
        expectedVersion: 4,
        groupId: "group-social",
        routeId: "social",
        commentaryMode: "override",
        commentary: "Private social copy",
        mediaMode: "select",
        imageAssetIds: ["hero", "detail"],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state(), {
      publicationId: "publication-social",
      expectedVersion: 4,
      state: {
        groupId: "group-social",
        routeId: "social",
        commentaryMode: "override",
        commentary: "Private social copy",
        mediaMode: "select",
        imageAssetIds: ["hero", "detail"],
      },
    });
    const body = response.json();
    assert.equal(body.publication.version, 5);
    assert.equal(body.extensionId, "blogmaatic.facebook-pages");
    assert.equal(body.connectionId, "fb-main");

    const audit = await store.listAudit({ action: "publication.social-variant.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const intent = audit.items.find((entry) => entry.phase === "intent");
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(intent.evidence.groupId, "group-social");
    assert.equal(intent.evidence.routeId, "social");
    assert.equal(intent.evidence.commentaryMode, "override");
    assert.equal(intent.evidence.commentaryLength, "Private social copy".length);
    assert.equal(intent.evidence.mediaMode, "select");
    assert.equal(intent.evidence.imageCount, 2);
    assert.equal(JSON.stringify(intent.evidence).includes("Private social copy"), false);
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);
    assert.equal(succeeded.evidence.extensionId, "blogmaatic.facebook-pages");
  });
});
