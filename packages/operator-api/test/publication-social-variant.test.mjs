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
  const current = {
    publication: {
      id: "publication-social",
      createdAt: "2026-10-25T01:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-25T01:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Social variants",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: { publishingTargets: { groupIds: ["group-social"] } },
        },
      },
      provenance: { source: "blogmaatic.publication-workspace" },
    },
    version: 4,
    recordedAt: "2026-10-25T01:00:00.000Z",
    updatedAt: "2026-10-25T01:00:00.000Z",
  };
  let socialInput;
  let socialCalls = 0;
  const publications = {
    async get(id) { return id === "publication-social" ? current : undefined; },
    async setSocialVariant(publicationId, input) {
      socialCalls += 1;
      assert.equal(publicationId, "publication-social");
      socialInput = input;
      return {
        publication: {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: { ...current.publication.current, id: "revision-2", ordinal: 2 },
          },
        },
        groupId: input.groupId,
        routeId: input.routeId,
        commentaryMode: input.commentaryMode,
        ...(input.commentary === undefined ? {} : { commentary: input.commentary }),
        mediaMode: input.mediaMode,
        imageAssetIds: input.imageAssetIds ?? [],
      };
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
      id: "operator-social-variant",
      token: TOKEN,
      permissions: ["publications:read", "publications:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-25T01:15:00.000Z" },
  });
  try {
    await fn({ app, store, state: () => ({ socialInput, socialCalls }) });
  } finally {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function bearer() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("publication social variant mutation validates and records audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/publications/publication-social/social-variant",
      headers: bearer(),
      payload: {
        expectedVersion: 4,
        groupId: "group-social",
        routeId: "facebook",
        commentaryMode: "override",
        commentary: "Exact Facebook copy",
        mediaMode: "select",
        imageAssetIds: ["detail", "hero"],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().socialInput, {
      expectedVersion: 4,
      groupId: "group-social",
      routeId: "facebook",
      commentaryMode: "override",
      commentary: "Exact Facebook copy",
      mediaMode: "select",
      imageAssetIds: ["detail", "hero"],
    });
    assert.equal(state().socialCalls, 1);
    assert.equal(response.json().publication.version, 5);

    const audit = await store.listAudit({ action: "publication.social-variant.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    assert.deepEqual(new Set(audit.items.map((entry) => entry.phase)), new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-social-variant");
    assert.equal(succeeded.resource.id, "publication-social");
    assert.equal(succeeded.evidence.groupId, "group-social");
    assert.equal(succeeded.evidence.routeId, "facebook");
    assert.equal(succeeded.evidence.commentaryMode, "override");
    assert.equal(succeeded.evidence.mediaMode, "select");
    assert.equal(succeeded.evidence.imageCount, 2);
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/publications/publication-social/social-variant",
      headers: bearer(),
      payload: {
        expectedVersion: 4,
        groupId: "group-social",
        routeId: "facebook",
        commentaryMode: "inherit",
        commentary: "not allowed",
        mediaMode: "none",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().socialCalls, 1);
  });
});
