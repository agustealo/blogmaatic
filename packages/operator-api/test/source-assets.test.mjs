import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, createOperatorApi } from "../dist/index.js";

const TOKEN = "source-assets-operator-0123456789-abcdefghijklmnopqrstuvwxyz";

async function withApi(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-source-assets-"));
  const store = new SqliteControlPlaneStore(join(directory, "control.sqlite"));
  const launcher = {
    async start(request) {
      return { runtimeId: `unused:${request.runId}` };
    },
  };
  const controlPlane = new AutomationControlPlane({ store, launcher });
  let listQuery;
  let attachInput;
  let attachCalls = 0;
  let preflightCalls = 0;
  let detachInput;
  let detachCalls = 0;
  let uploadInput;
  let uploadCalls = 0;
  let featuredInput;
  let featuredCalls = 0;
  let metadataInput;
  let metadataCalls = 0;
  const asset = {
    connectionId: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    remoteId: "77",
    sourceUrl: "https://example.test/uploads/hero.jpg",
    kind: "image",
    mediaType: "image/jpeg",
    title: "Hero",
    alt: "Editorial hero",
    width: 1600,
    height: 900,
    metadata: { wordpressMediaId: 77, slug: "hero" },
  };
  const publication = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-2",
        ordinal: 2,
        createdAt: "2026-10-18T14:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [{
            id: "wordpress-media-77",
            kind: "image",
            source: asset.sourceUrl,
            mediaType: "image/jpeg",
            alt: "Editorial hero",
            attributes: { wordpressMediaId: 77, featured: true },
          }],
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
    recordedAt: "2026-10-18T14:00:00.000Z",
    updatedAt: "2026-10-18T14:00:00.000Z",
  };
  const sourceContent = {
    async listAssets(connectionId, query) {
      assert.equal(connectionId, "wp-main");
      listQuery = query;
      return { items: [asset], page: query.page ?? 1, limit: query.limit ?? 30, hasMore: true };
    },
    async preflightAssetDeletion(connectionId, remoteId) {
      preflightCalls++;
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "77");
      return {
        connectionId, remoteId, disposition: "blocked",
        canDelete: false, wordpressMediaRetained: true,
        media: asset,
        references: [{
          kind: "publication_current", publicationId: "publication-wp", revisionId: "revision-2",
        }],
        inspected: {
          publicationHeads: 1, publicationVersions: 2, schedules: 0,
          wordpressContentTypes: 1, wordpressPosts: 3,
        },
        blockers: ["known_media_references_exist", "permanent_deletion_not_enabled"],
      };
    },
    async attachAsset(connectionId, remoteId, body) {
      attachCalls += 1;
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "77");
      attachInput = body;
      return { publication, asset };
    },
    async detachAsset(connectionId, remoteId, body) {
      detachCalls += 1;
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "77");
      detachInput = body;
      return { publication, remoteId, wordpressMediaRetained: true };
    },
    async uploadAsset(connectionId, input) {
      uploadCalls += 1;
      assert.equal(connectionId, "wp-main");
      uploadInput = input;
      return { publication, asset };
    },
    async updateAssetMetadata(connectionId, remoteId, body) {
      metadataCalls += 1;
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "77");
      metadataInput = body;
      return {
        asset: {
          ...asset,
          title: body.title ?? asset.title,
          alt: body.alt ?? asset.alt,
          ...(body.caption === undefined ? {} : { caption: body.caption }),
          ...(body.description === undefined ? {} : { description: body.description }),
        },
      };
    },
    async setFeaturedMedia(connectionId, input) {
      featuredCalls += 1;
      assert.equal(connectionId, "wp-main");
      featuredInput = input;
      return {
        publication,
        contentType: input.contentType,
        mode: input.mode,
        ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
      };
    },
    async list() { return { items: [], page: 1, limit: 30, hasMore: false }; },
    async get() { throw new Error("unused"); },
    async revisions() { return []; },
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
      id: "operator-source-assets",
      token: TOKEN,
      permissions: ["source-content:read", "source-content:write"],
      roles: ["publisher"],
    }]),
    clock: { now: () => "2026-10-18T14:00:00.000Z" },
  });
  try {
    await fn({
      app,
      store,
      state: () => ({
        listQuery,
        attachInput,
        attachCalls,
        preflightCalls,
        detachInput,
        detachCalls,
        uploadInput,
        uploadCalls,
        featuredInput,
        featuredCalls,
        metadataInput,
        metadataCalls,
      }),
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

test("source asset browse validates and forwards provider-neutral search pagination", async () => {
  await withApi(async ({ app, state }) => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/assets?search=hero&page=2&limit=12",
      headers: bearer(),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(state().listQuery, { search: "hero", page: 2, limit: 12 });
    assert.equal(response.json().items[0].remoteId, "77");

    const unknown = await app.inject({
      method: "GET",
      url: "/v1/connections/wp-main/assets?status=publish",
      headers: bearer(),
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error.code, "INVALID_REQUEST");
  });
});

test("source asset attach is validated, audited, and records resulting canonical revision evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/77/attach",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        featured: true,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().attachInput, {
      publicationId: "publication-wp",
      expectedVersion: 4,
      featured: true,
    });
    assert.equal(state().attachCalls, 1);
    assert.equal(response.json().publication.version, 5);

    const audit = await store.listAudit({ action: "source-asset.attach", limit: 10 });
    assert.equal(audit.items.length, 2);
    const phases = new Set(audit.items.map((entry) => entry.phase));
    assert.deepEqual(phases, new Set(["intent", "succeeded"]));
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.actor.id, "operator-source-assets");
    assert.equal(succeeded.resource.type, "publication");
    assert.equal(succeeded.resource.id, "publication-wp");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.assetRemoteId, "77");
    assert.equal(succeeded.evidence.revisionId, "revision-2");
    assert.equal(succeeded.evidence.version, 5);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/77/attach",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 0,
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().attachCalls, 1);
  });
});


test("source asset metadata update accepts explicit clears and audits field names without values", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/77/metadata",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 5,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
        title: "Private editorial title",
        alt: "",
        caption: "Private launch caption",
        description: "",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().metadataCalls, 1);
    assert.deepEqual(state().metadataInput, {
      publicationId: "publication-wp",
      expectedVersion: 5,
      contentType: "posts",
      groupId: "group-main",
      routeId: "wordpress",
      title: "Private editorial title",
      alt: "",
      caption: "Private launch caption",
      description: "",
    });
    assert.equal(response.json().asset.title, "Private editorial title");
    assert.equal(response.json().asset.alt, "");
    assert.equal(response.json().asset.caption, "Private launch caption");

    const audit = await store.listAudit({ action: "source-asset.metadata.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.resource.type, "source-asset");
    assert.equal(succeeded.resource.id, "wp-main:77");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.remoteId, "77");
    assert.equal(succeeded.evidence.publicationId, "publication-wp");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.deepEqual(succeeded.evidence.changedFields, ["alt", "title", "caption", "description"]);
    const serializedAudit = JSON.stringify(audit.items);
    assert.doesNotMatch(serializedAudit, /Private editorial title/);
    assert.doesNotMatch(serializedAudit, /Private launch caption/);

    const empty = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/77/metadata",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 5,
      },
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.code, "INVALID_REQUEST");
    assert.equal(state().metadataCalls, 1);
  });
});

test("source asset binary upload validates metadata, forwards bytes, and records audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/upload?publicationId=publication-wp&expectedVersion=4&featured=true&filename=hero.png&alt=Editorial%20hero&title=Hero",
      headers: {
        ...bearer(),
        "content-type": "image/png",
      },
      payload: bytes,
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().uploadCalls, 1);
    assert.equal(state().uploadInput.publicationId, "publication-wp");
    assert.equal(state().uploadInput.expectedVersion, 4);
    assert.equal(state().uploadInput.filename, "hero.png");
    assert.equal(state().uploadInput.mediaType, "image/png");
    assert.equal(state().uploadInput.featured, true);
    assert.equal(state().uploadInput.alt, "Editorial hero");
    assert.equal(state().uploadInput.title, "Hero");
    assert.deepEqual(Buffer.from(state().uploadInput.bytes), bytes);

    const audit = await store.listAudit({ action: "source-asset.upload", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.resource.id, "publication-wp");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.filename, "hero.png");
    assert.equal(succeeded.evidence.mediaType, "image/png");
    assert.equal(succeeded.evidence.byteLength, bytes.length);
    assert.equal(succeeded.evidence.assetRemoteId, "77");
    assert.equal(succeeded.evidence.revisionId, "revision-2");

    const badFilename = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/upload?publicationId=publication-wp&expectedVersion=4&filename=..%2Fsecret.png",
      headers: {
        ...bearer(),
        "content-type": "image/png",
      },
      payload: bytes,
    });
    assert.equal(badFilename.statusCode, 400);
    assert.equal(badFilename.json().error.code, "INVALID_REQUEST");
    assert.equal(state().uploadCalls, 1);
  });
});


test("route-scoped source asset attach preserves group route and content type in audit evidence", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/77/attach",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
        featured: false,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(state().attachInput, {
      publicationId: "publication-wp",
      expectedVersion: 4,
      featured: false,
      contentType: "posts",
      groupId: "group-main",
      routeId: "wordpress",
    });

    const audit = await store.listAudit({ action: "source-asset.attach", limit: 10 });
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.equal(succeeded.evidence.contentType, "posts");
  });
});

test("route-scoped binary upload forwards route coordinates without global featured ownership", async () => {
  await withApi(async ({ app, store, state }) => {
    const bytes = Buffer.from([9, 8, 7]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/assets/upload?publicationId=publication-wp&expectedVersion=4&featured=false&filename=route.png&contentType=posts&groupId=group-main&routeId=wordpress",
      headers: {
        ...bearer(),
        "content-type": "image/png",
      },
      payload: bytes,
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().uploadInput.featured, false);
    assert.equal(state().uploadInput.contentType, "posts");
    assert.equal(state().uploadInput.groupId, "group-main");
    assert.equal(state().uploadInput.routeId, "wordpress");

    const audit = await store.listAudit({ action: "source-asset.upload", limit: 10 });
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.equal(succeeded.evidence.contentType, "posts");
  });
});

test("route-scoped featured media validates mode and records exact destination audit coordinates", async () => {
  await withApi(async ({ app, store, state }) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/featured-media",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
        mode: "asset",
        assetId: "wordpress-media-wp-main-77",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(state().featuredCalls, 1);
    assert.deepEqual(state().featuredInput, {
      publicationId: "publication-wp",
      expectedVersion: 4,
      contentType: "posts",
      groupId: "group-main",
      routeId: "wordpress",
      mode: "asset",
      assetId: "wordpress-media-wp-main-77",
    });

    const audit = await store.listAudit({ action: "source-featured-media.update", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((entry) => entry.phase === "succeeded");
    assert.equal(succeeded.evidence.connectionId, "wp-main");
    assert.equal(succeeded.evidence.groupId, "group-main");
    assert.equal(succeeded.evidence.routeId, "wordpress");
    assert.equal(succeeded.evidence.mode, "asset");
    assert.equal(succeeded.evidence.assetId, "wordpress-media-wp-main-77");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/connections/wp-main/featured-media",
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 4,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
        mode: "none",
        assetId: "should-not-be-here",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "INVALID_REQUEST");
    assert.equal(state().featuredCalls, 1);
  });
});


test("source asset detach is audited, version-validated, and explicitly retains WordPress media", async () => {
  await withApi(async ({ app, store, state }) => {
    const url = "/v1/connections/wp-main/assets/77/detach";
    for (const payload of [
      { publicationId: "publication-wp", expectedVersion: 0 },
      { publicationId: "publication-wp", expectedVersion: 5, featured: false },
      { publicationId: "publication-wp", expectedVersion: 5, groupId: "group-main" },
      { publicationId: "publication-wp", expectedVersion: 5, unexpected: true },
    ]) {
      const rejected = await app.inject({ method: "POST", url, headers: bearer(), payload });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(rejected.json().error.code, "INVALID_REQUEST");
    }
    assert.equal(state().detachCalls, 0);

    const response = await app.inject({
      method: "POST",
      url,
      headers: bearer(),
      payload: {
        publicationId: "publication-wp",
        expectedVersion: 5,
        contentType: "posts",
        groupId: "group-main",
        routeId: "wordpress",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().wordpressMediaRetained, true);
    assert.equal(response.json().publication.version, 5);
    assert.equal(state().detachCalls, 1);
    assert.deepEqual(state().detachInput, {
      publicationId: "publication-wp",
      expectedVersion: 5,
      contentType: "posts",
      groupId: "group-main",
      routeId: "wordpress",
    });

    const audit = await store.listAudit({ action: "source-asset.detach", limit: 10 });
    assert.equal(audit.items.length, 2);
    const succeeded = audit.items.find((item) => item.phase === "succeeded");
    assert.equal(succeeded.evidence.wordpressMediaRetained, true);
    assert.equal(succeeded.evidence.assetRemoteId, "77");
    assert.equal(succeeded.evidence.version, 5);
    assert.ok(audit.items.every((item) => !JSON.stringify(item.evidence).includes("https://example.test/uploads")));
  });
});


test("media deletion preflight is authenticated, read-only, and always blocked", async () => {
  await withApi(async ({ app, store, state }) => {
    const url = "/v1/connections/wp-main/assets/77/deletion-preflight";
    const unauthorized = await app.inject({ method: "GET", url });
    assert.ok([401, 403].includes(unauthorized.statusCode), unauthorized.body);
    assert.equal(state().preflightCalls, 0);

    const response = await app.inject({ method: "GET", url, headers: bearer() });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.canDelete, false);
    assert.equal(result.disposition, "blocked");
    assert.equal(result.wordpressMediaRetained, true);
    assert.equal(result.references[0].publicationId, "publication-wp");
    assert.equal(result.inspected.publicationVersions, 2);
    assert.equal(state().preflightCalls, 1);

    const audit = await store.listAudit({ limit: 20 });
    assert.equal(audit.items.length, 0, "Read-only preflight may not create mutation intent");
    const invalidVerb = await app.inject({ method: "DELETE", url, headers: bearer() });
    assert.equal(invalidVerb.statusCode, 404);
    assert.equal(state().preflightCalls, 1);
  });
});
