import assert from "node:assert/strict";
import test from "node:test";

import { PublicationWorkspaceManager } from "../dist/publication-workspace-manager.js";

function managerWith(publication, publicationGroups = {}) {
  let entry = {
    publication,
    version: 1,
    recordedAt: publication.createdAt,
    updatedAt: publication.createdAt,
  };
  let idIndex = 0;
  const ids = ["metadata-revision-2", "metadata-revision-3", "metadata-revision-4"];
  const manager = new PublicationWorkspaceManager({
    store: {
      async get(id) {
        return entry.publication.id === id ? entry : undefined;
      },
      async update(next, expectedVersion, updatedAt) {
        assert.equal(expectedVersion, entry.version);
        entry = {
          publication: next,
          version: expectedVersion + 1,
          recordedAt: updatedAt,
          updatedAt,
        };
        return entry;
      },
    },
    publicationGroups,
    controlPlane: {},
    now: () => "2026-10-18T14:45:00.000Z",
    id: () => ids[idIndex++] ?? `metadata-id-${idIndex}`,
  });
  return { manager, current: () => entry };
}

function importedPublication() {
  return {
    id: "publication-wp",
    createdAt: "2026-10-18T14:00:00.000Z",
    status: "draft",
    current: {
      id: "revision-wp-1",
      ordinal: 1,
      createdAt: "2026-10-18T14:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Imported WordPress article",
        language: "en",
        blocks: [],
        assets: [
          {
            id: "hero",
            kind: "image",
            source: "https://example.test/hero.jpg",
            alt: "Hero",
            attributes: { wordpressMediaId: 44, featured: true, sourceNote: "keep-me" },
          },
          {
            id: "alternate",
            kind: "image",
            source: "https://example.test/alternate.jpg",
            attributes: { wordpressMediaId: 45 },
          },
          {
            id: "document",
            kind: "document",
            source: "https://example.test/file.pdf",
          },
        ],
        tags: ["news"],
        attributes: {
          categories: ["News"],
          wordpress: {
            connectionId: "wp-main",
            remoteId: "55",
            authorId: 3,
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
  };
}

test("metadata-only category and featured-image updates create canonical revisions and preserve provider metadata", async () => {
  const { manager } = managerWith(importedPublication());

  const changed = await manager.update("publication-wp", {
    expectedVersion: 1,
    categories: ["Tutorials", " tutorials ", "Guides"],
    featuredAssetId: "alternate",
  });

  assert.equal(changed.version, 2);
  assert.equal(changed.publication.current.ordinal, 2);
  assert.equal(changed.publication.current.id, "revision_metadata-revision-2");
  assert.deepEqual(changed.publication.current.content.attributes.categories, ["Tutorials", "tutorials", "Guides"]);
  assert.deepEqual(changed.publication.current.content.attributes.wordpress, {
    connectionId: "wp-main",
    remoteId: "55",
    authorId: 3,
  });

  const hero = changed.publication.current.content.assets.find((asset) => asset.id === "hero");
  const alternate = changed.publication.current.content.assets.find((asset) => asset.id === "alternate");
  assert.deepEqual(hero.attributes, { wordpressMediaId: 44, sourceNote: "keep-me" });
  assert.deepEqual(alternate.attributes, { wordpressMediaId: 45, featured: true });

  const removed = await manager.update("publication-wp", {
    expectedVersion: 2,
    featuredAssetId: null,
  });
  assert.equal(removed.publication.current.ordinal, 3);
  assert.deepEqual(
    removed.publication.current.content.assets.find((asset) => asset.id === "alternate").attributes,
    { wordpressMediaId: 45 },
  );
});

test("featured image selection rejects missing and non-image assets without mutating the workspace", async () => {
  const { manager, current } = managerWith(importedPublication());

  await assert.rejects(
    () => manager.update("publication-wp", { expectedVersion: 1, featuredAssetId: "missing" }),
    /Featured asset does not exist/,
  );
  assert.equal(current().version, 1);

  await assert.rejects(
    () => manager.update("publication-wp", { expectedVersion: 1, featuredAssetId: "document" }),
    /Featured asset must be an image/,
  );
  assert.equal(current().version, 1);
});

test("workspace-native create stores normalized canonical categories", async () => {
  let created;
  const manager = new PublicationWorkspaceManager({
    store: {
      async create(publication, recordedAt) {
        created = { publication, version: 1, recordedAt, updatedAt: recordedAt };
        return created;
      },
    },
    publicationGroups: {},
    controlPlane: {},
    now: () => "2026-10-18T14:45:00.000Z",
    id: (() => {
      const ids = ["publication-id", "revision-id"];
      let index = 0;
      return () => ids[index++] ?? `id-${index}`;
    })(),
  });

  const result = await manager.create({
    title: "Category proof",
    categories: ["Publishing", " publishing ", "Guides"],
  });

  assert.equal(result.publication.current.ordinal, 1);
  assert.deepEqual(result.publication.current.content.attributes.categories, ["Publishing", "publishing", "Guides"]);
});


test("canonical asset attachment is idempotent and can feature an existing attachment without duplication", async () => {
  const publication = importedPublication();
  publication.current.content.assets = [];
  const { manager, current } = managerWith(publication);
  const asset = {
    id: "wordpress-media-77",
    kind: "image",
    source: "https://example.test/uploads/library.jpg",
    mediaType: "image/jpeg",
    alt: "Library",
    attributes: {
      wordpressMediaId: 77,
      sourceConnectionId: "wp-main",
      sourceRemoteId: "77",
    },
  };

  const attached = await manager.attachAsset("publication-wp", 1, asset, false);
  assert.equal(attached.version, 2);
  assert.equal(attached.publication.current.ordinal, 2);
  assert.equal(attached.publication.current.content.assets.length, 1);

  const retry = await manager.attachAsset("publication-wp", 2, asset, false);
  assert.equal(retry.version, 2);
  assert.equal(retry.publication.current.content.assets.length, 1);

  const featured = await manager.attachAsset("publication-wp", 2, asset, true);
  assert.equal(featured.version, 3);
  assert.equal(featured.publication.current.ordinal, 3);
  assert.equal(featured.publication.current.content.assets.length, 1);
  assert.equal(featured.publication.current.content.assets[0].attributes.featured, true);
  assert.equal(featured.publication.current.content.assets[0].attributes.wordpressMediaId, 77);

  await assert.rejects(
    () => manager.attachAsset("publication-wp", 3, { ...asset, source: "https://example.test/other.jpg" }, false),
    /already belongs to a different asset/,
  );
  assert.equal(current().version, 3);
});


test("canonical source author assignment is immutable, idempotent, and source-bound", async () => {
  const publication = importedPublication();
  const { manager, current } = managerWith(publication);

  const assigned = await manager.assignSourceAuthor("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
    displayName: "Editor Seven",
  });
  assert.equal(assigned.version, 2);
  assert.equal(assigned.publication.current.ordinal, 2);
  assert.equal(assigned.publication.current.id, "revision_metadata-revision-2");
  assert.deepEqual(assigned.publication.current.content.attributes.sourceAuthor, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
    displayName: "Editor Seven",
  });
  assert.deepEqual(
    assigned.publication.current.content.attributes.wordpress,
    publication.current.content.attributes.wordpress,
  );
  assert.deepEqual(
    assigned.publication.current.content.assets,
    publication.current.content.assets,
  );

  const retry = await manager.assignSourceAuthor("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
    displayName: "Editor Seven",
  });
  assert.equal(retry.version, 2);
  assert.equal(retry.publication.current.id, "revision_metadata-revision-2");

  await assert.rejects(
    () => manager.assignSourceAuthor("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-other",
      remoteId: "8",
      displayName: "Wrong Site",
    }),
    /does not match the publication source/,
  );
  assert.equal(current().version, 2);
});


test("canonical source publishing state is immutable idempotent and source-bound", async () => {
  const publication = importedPublication();
  const { manager, current } = managerWith(publication);

  const scheduled = await manager.setSourcePublishingState("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T14:30:00-04:00",
  });
  assert.equal(scheduled.version, 2);
  assert.equal(scheduled.publication.current.ordinal, 2);
  assert.deepEqual(scheduled.publication.current.content.attributes.sourcePublishing, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  });
  assert.deepEqual(
    scheduled.publication.current.content.attributes.wordpress,
    publication.current.content.attributes.wordpress,
  );

  const retry = await manager.setSourcePublishingState("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  });
  assert.equal(retry.version, 2);
  assert.equal(retry.publication.current.id, scheduled.publication.current.id);

  await assert.rejects(
    () => manager.setSourcePublishingState("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-other",
      status: "draft",
    }),
    /does not match the publication source/,
  );
  assert.equal(current().version, 2);
});


test("source revision recovery creates a new canonical revision and preserves managed metadata", async () => {
  const publication = importedPublication();
  publication.current.content.attributes.sourceAuthor = {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
    displayName: "Editor Seven",
  };
  publication.current.content.attributes.sourcePublishing = {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  };
  const beforeAssets = structuredClone(publication.current.content.assets);
  const beforeAttributes = structuredClone(publication.current.content.attributes);
  const { manager, current } = managerWith(publication);

  const restored = await manager.restoreSourceRevision("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "55",
    remoteRevisionId: "9055",
    title: "Recovered remote title",
    summary: "Recovered excerpt",
    contentHtml: "<h2>Recovered heading</h2><p>Recovered body.</p>",
    sourceModifiedAt: "2026-10-17T20:00:00",
    sourceAuthorId: 9,
  });

  assert.equal(restored.version, 2);
  assert.equal(restored.publication.current.ordinal, 2);
  assert.equal(restored.publication.current.id, "revision_metadata-revision-2");
  assert.equal(restored.publication.current.content.title, "Recovered remote title");
  assert.equal(restored.publication.current.content.summary, "Recovered excerpt");
  assert.deepEqual(restored.publication.current.content.blocks, [{
    id: "source-revision-9055",
    kind: "embed",
    data: { html: "<h2>Recovered heading</h2><p>Recovered body.</p>" },
  }]);
  assert.deepEqual(restored.publication.current.content.assets, beforeAssets);
  assert.deepEqual(restored.publication.current.content.tags, ["news"]);
  assert.deepEqual(restored.publication.current.content.attributes.categories, beforeAttributes.categories);
  assert.deepEqual(restored.publication.current.content.attributes.wordpress, beforeAttributes.wordpress);
  assert.deepEqual(restored.publication.current.content.attributes.sourceAuthor, beforeAttributes.sourceAuthor);
  assert.deepEqual(restored.publication.current.content.attributes.sourcePublishing, beforeAttributes.sourcePublishing);
  assert.deepEqual(restored.publication.current.content.attributes.sourceRevisionRecovery, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "55",
    remoteRevisionId: "9055",
    recoveredAt: "2026-10-18T14:45:00.000Z",
    sourceModifiedAt: "2026-10-17T20:00:00",
    sourceAuthorId: 9,
  });

  await assert.rejects(
    () => manager.restoreSourceRevision("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      remoteId: "99",
      remoteRevisionId: "9001",
      title: "Wrong post",
      contentHtml: "<p>wrong</p>",
    }),
    /does not match the publication source identity/,
  );
  assert.equal(current().version, 2);
});

test("source revision recovery can clear an empty remote excerpt without deleting other metadata", async () => {
  const publication = importedPublication();
  publication.current.content.summary = "Current summary";
  const { manager } = managerWith(publication);

  const restored = await manager.restoreSourceRevision("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "55",
    remoteRevisionId: "9056",
    title: "",
    contentHtml: "",
  });

  assert.equal(restored.publication.current.content.title, "Imported WordPress article");
  assert.equal("summary" in restored.publication.current.content, false);
  assert.deepEqual(restored.publication.current.content.blocks, []);
  assert.equal(restored.publication.current.content.assets.length, 3);
});


test("canonical source page structure is immutable idempotent and source/type bound", async () => {
  const publication = importedPublication();
  publication.current.content.attributes.wordpress.contentType = "pages";
  const { manager, current } = managerWith(publication);

  const changed = await manager.setSourcePageStructure("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 4,
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.publication.current.ordinal, 2);
  assert.deepEqual(changed.publication.current.content.attributes.sourcePage, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 4,
  });

  const retry = await manager.setSourcePageStructure("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 4,
  });
  assert.equal(retry.version, 2);

  const cleared = await manager.setSourcePageStructure("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: null,
    template: null,
    menuOrder: 0,
  });
  assert.equal(cleared.version, 3);
  assert.deepEqual(cleared.publication.current.content.attributes.sourcePage, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: null,
    template: null,
    menuOrder: 0,
  });

  await assert.rejects(
    () => manager.setSourcePageStructure("publication-wp", 3, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "posts",
      parentRemoteId: null,
      template: null,
      menuOrder: 0,
    }),
    /content type does not match/,
  );
  await assert.rejects(
    () => manager.setSourcePageStructure("publication-wp", 3, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "pages",
      parentRemoteId: "55",
      template: null,
      menuOrder: 0,
    }),
    /cannot be its own parent/,
  );
  assert.equal(current().version, 3);
});


test("canonical source editorial options are immutable idempotent source-bound and reject sticky password conflicts", async () => {
  const publication = importedPublication();
  publication.current.content.attributes.wordpress.contentType = "posts";
  const { manager, current } = managerWith(publication);

  const changed = await manager.setSourceEditorialOptions("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "posts",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
    sticky: true,
    format: "quote",
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.publication.current.ordinal, 2);
  assert.deepEqual(changed.publication.current.content.attributes.sourceEditorial, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "posts",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
    sticky: true,
    format: "quote",
  });

  const retry = await manager.setSourceEditorialOptions("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "posts",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
    sticky: true,
    format: "quote",
  });
  assert.equal(retry.version, 2);

  await assert.rejects(
    () => manager.setSourceEditorialOptions("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "posts",
      password: "secret",
      sticky: true,
    }),
    /cannot be password protected/,
  );
  await assert.rejects(
    () => manager.setSourceEditorialOptions("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-other",
      contentType: "posts",
      password: "",
    }),
    /does not match the publication source/,
  );
  await assert.rejects(
    () => manager.setSourceEditorialOptions("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "pages",
      password: "",
    }),
    /content type does not match/,
  );
  assert.equal(current().version, 2);
});


test("canonical source REST meta is immutable idempotent and source-bound", async () => {
  const publication = importedPublication();
  publication.current.content.attributes.wordpress = {
    ...publication.current.content.attributes.wordpress,
    contentType: "books",
  };
  publication.provenance.remoteId = "55";
  const beforeAssets = structuredClone(publication.current.content.assets);
  const beforeAttributes = structuredClone(publication.current.content.attributes);
  const { manager, current } = managerWith(publication);

  const saved = await manager.setSourceMetaValues("publication-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "books",
    values: {
      isbn: "978-1-234",
      rating: 4.5,
      featured: true,
      keywords: ["systems"],
      details: { imprint: "Open Press" },
    },
  });
  assert.equal(saved.version, 2);
  assert.equal(saved.publication.current.ordinal, 2);
  assert.equal(saved.publication.current.id, "revision_metadata-revision-2");
  assert.deepEqual(saved.publication.current.content.attributes.sourceMeta, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "books",
    values: {
      isbn: "978-1-234",
      rating: 4.5,
      featured: true,
      keywords: ["systems"],
      details: { imprint: "Open Press" },
    },
  });
  assert.deepEqual(saved.publication.current.content.assets, beforeAssets);
  assert.deepEqual(saved.publication.current.content.attributes.wordpress, beforeAttributes.wordpress);

  const retry = await manager.setSourceMetaValues("publication-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "books",
    values: {
      isbn: "978-1-234",
      rating: 4.5,
      featured: true,
      keywords: ["systems"],
      details: { imprint: "Open Press" },
    },
  });
  assert.equal(retry.version, 2);
  assert.equal(retry.publication.current.id, saved.publication.current.id);

  await assert.rejects(
    () => manager.setSourceMetaValues("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-other",
      contentType: "books",
      values: { isbn: "wrong" },
    }),
    /does not match the publication source/,
  );
  await assert.rejects(
    () => manager.setSourceMetaValues("publication-wp", 2, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-main",
      contentType: "posts",
      values: { isbn: "wrong" },
    }),
    /content type does not match/,
  );
  assert.equal(current().version, 2);
});


test("workspace-native publication stores independent WordPress overrides for same route id in two groups", async () => {
  const publication = {
    id: "publication-multi-wp",
    createdAt: "2026-10-24T20:00:00.000Z",
    status: "draft",
    current: {
      id: "revision-1",
      ordinal: 1,
      createdAt: "2026-10-24T20:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Publish to two WordPress sites",
        language: "en",
        blocks: [],
        assets: [],
        tags: [],
        attributes: {
          publishingTargets: { groupIds: ["group-a", "group-b"] },
        },
      },
    },
    provenance: { source: "blogmaatic.publication-workspace" },
  };
  const routeFor = (connectionId) => ({
    id: "wordpress",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId,
      channel: "posts",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
  });
  const groups = {
    async get(groupId) {
      if (groupId === "group-a") {
        return {
          enabled: true,
          group: { id: "group-a", name: "Site A", policySetId: "allow", routes: [routeFor("wp-a")] },
        };
      }
      if (groupId === "group-b") {
        return {
          enabled: true,
          group: { id: "group-b", name: "Site B", policySetId: "allow", routes: [routeFor("wp-b")] },
        };
      }
      return undefined;
    },
  };
  const { manager, current } = managerWith(publication, groups);

  await manager.assignSourceAuthor("publication-multi-wp", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    groupId: "group-a",
    routeId: "wordpress",
    remoteId: "7",
    displayName: "Site A Editor",
  });
  await manager.setSourcePublishingState("publication-multi-wp", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    groupId: "group-a",
    routeId: "wordpress",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  });
  await manager.assignSourceAuthor("publication-multi-wp", 3, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    groupId: "group-b",
    routeId: "wordpress",
    remoteId: "12",
    displayName: "Site B Editor",
  });
  const final = await manager.setSourcePublishingState("publication-multi-wp", 4, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    groupId: "group-b",
    routeId: "wordpress",
    status: "draft",
  });

  assert.equal(final.version, 5);
  const overrides = final.publication.current.content.attributes.destinationOverrides;
  assert.equal(overrides.schemaVersion, 1);
  assert.deepEqual(overrides.groups["group-a"].routes.wordpress, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    channel: "posts",
    author: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-a",
      remoteId: "7",
      displayName: "Site A Editor",
    },
    publishing: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-a",
      status: "future",
      scheduledAt: "2026-11-01T18:30:00.000Z",
    },
  });
  assert.deepEqual(overrides.groups["group-b"].routes.wordpress, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    channel: "posts",
    author: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-b",
      remoteId: "12",
      displayName: "Site B Editor",
    },
    publishing: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-b",
      status: "draft",
    },
  });
  assert.equal(final.publication.current.content.attributes.sourceAuthor, undefined);
  assert.equal(final.publication.current.content.attributes.sourcePublishing, undefined);

  await assert.rejects(
    () => manager.assignSourceAuthor("publication-multi-wp", 5, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-b",
      groupId: "group-a",
      routeId: "wordpress",
      remoteId: "99",
      displayName: "Wrong site",
    }),
    /does not match the requested destination/,
  );
  assert.equal(current().version, 5);
});


test("route-scoped destination overrides fail closed for untargeted missing disabled and disabled-route targets", async () => {
  const route = (connectionId, enabled = true) => ({
    id: "wordpress",
    enabled,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId,
      channel: "posts",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
  });
  const publication = {
    id: "publication-route-guards",
    createdAt: "2026-10-24T20:00:00.000Z",
    status: "draft",
    current: {
      id: "revision-1",
      ordinal: 1,
      createdAt: "2026-10-24T20:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Route guard proof",
        language: "en",
        blocks: [],
        assets: [],
        tags: [],
        attributes: {
          publishingTargets: { groupIds: ["group-active", "group-disabled", "group-route-disabled"] },
        },
      },
    },
    provenance: { source: "blogmaatic.publication-workspace" },
  };
  const groups = {
    async get(groupId) {
      if (groupId === "group-active") {
        return {
          enabled: true,
          group: {
            id: groupId,
            name: "Active",
            policySetId: "allow",
            routes: [route("wp-active")],
          },
        };
      }
      if (groupId === "group-disabled") {
        return {
          enabled: false,
          group: {
            id: groupId,
            name: "Disabled",
            policySetId: "allow",
            routes: [route("wp-disabled")],
          },
        };
      }
      if (groupId === "group-route-disabled") {
        return {
          enabled: true,
          group: {
            id: groupId,
            name: "Disabled route",
            policySetId: "allow",
            routes: [route("wp-route-disabled", false)],
          },
        };
      }
      if (groupId === "group-untargeted") {
        return {
          enabled: true,
          group: {
            id: groupId,
            name: "Untargeted",
            policySetId: "allow",
            routes: [route("wp-untargeted")],
          },
        };
      }
      return undefined;
    },
  };
  const { manager, current } = managerWith(publication, groups);

  await assert.rejects(
    () => manager.assignSourceAuthor("publication-route-guards", 1, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-untargeted",
      groupId: "group-untargeted",
      routeId: "wordpress",
      remoteId: "7",
      displayName: "Untargeted",
    }),
    /does not target Publication Group/,
  );
  assert.equal(current().version, 1);

  await assert.rejects(
    () => manager.assignSourceAuthor("publication-route-guards", 1, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-active",
      groupId: "group-active",
      routeId: "missing",
      remoteId: "7",
      displayName: "Missing route",
    }),
    /does not contain route/,
  );
  assert.equal(current().version, 1);

  await assert.rejects(
    () => manager.setSourcePublishingState("publication-route-guards", 1, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-disabled",
      groupId: "group-disabled",
      routeId: "wordpress",
      status: "draft",
    }),
    /Publishing target is disabled/,
  );
  assert.equal(current().version, 1);

  await assert.rejects(
    () => manager.setSourcePublishingState("publication-route-guards", 1, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-route-disabled",
      groupId: "group-route-disabled",
      routeId: "wordpress",
      status: "draft",
    }),
    /Publishing target route is disabled/,
  );
  assert.equal(current().version, 1);
});


test("workspace-native WordPress metadata stays isolated by group when route ids collide", async () => {
  const publication = {
    id: "publication-native-metadata-matrix",
    createdAt: "2026-10-24T21:00:00.000Z",
    status: "draft",
    current: {
      id: "revision-1",
      ordinal: 1,
      createdAt: "2026-10-24T21:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Two WordPress page destinations",
        language: "en",
        blocks: [],
        assets: [],
        tags: [],
        attributes: {
          publishingTargets: { groupIds: ["group-a", "group-b"] },
        },
      },
    },
    provenance: { source: "blogmaatic.publication-workspace" },
  };
  const routeFor = (connectionId) => ({
    id: "wordpress",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId,
      channel: "pages",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
  });
  const groups = {
    async get(groupId) {
      if (groupId === "group-a") {
        return {
          enabled: true,
          group: { id: "group-a", name: "Site A", policySetId: "allow", routes: [routeFor("wp-a")] },
        };
      }
      if (groupId === "group-b") {
        return {
          enabled: true,
          group: { id: "group-b", name: "Site B", policySetId: "allow", routes: [routeFor("wp-b")] },
        };
      }
      return undefined;
    },
  };
  const { manager, current } = managerWith(publication, groups);

  await manager.setSourceTaxonomies("publication-native-metadata-matrix", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    groupId: "group-a",
    routeId: "wordpress",
    taxonomies: {
      genre: { restBase: "genres", names: ["Alpha"] },
    },
  });
  await manager.setSourceMetaValues("publication-native-metadata-matrix", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    groupId: "group-a",
    routeId: "wordpress",
    values: { rating: 1, site_note: "A" },
  });
  await manager.setSourceEditorialOptions("publication-native-metadata-matrix", 3, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    groupId: "group-a",
    routeId: "wordpress",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
  });
  await manager.setSourcePageStructure("publication-native-metadata-matrix", 4, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    groupId: "group-a",
    routeId: "wordpress",
    parentRemoteId: "101",
    template: "landing-a.php",
    menuOrder: 1,
  });

  await manager.setSourceTaxonomies("publication-native-metadata-matrix", 5, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    groupId: "group-b",
    routeId: "wordpress",
    taxonomies: {
      genre: { restBase: "genres", names: ["Beta"] },
    },
  });
  await manager.setSourceMetaValues("publication-native-metadata-matrix", 6, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    groupId: "group-b",
    routeId: "wordpress",
    values: { rating: 2, site_note: "B" },
  });
  await manager.setSourceEditorialOptions("publication-native-metadata-matrix", 7, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    groupId: "group-b",
    routeId: "wordpress",
    password: "site-b-only",
    commentStatus: "closed",
    pingStatus: "open",
  });
  const final = await manager.setSourcePageStructure("publication-native-metadata-matrix", 8, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    groupId: "group-b",
    routeId: "wordpress",
    parentRemoteId: "202",
    template: "landing-b.php",
    menuOrder: 9,
  });

  assert.equal(final.version, 9);
  const overrides = final.publication.current.content.attributes.destinationOverrides;
  const siteA = overrides.groups["group-a"].routes.wordpress;
  const siteB = overrides.groups["group-b"].routes.wordpress;

  assert.deepEqual(siteA.taxonomies, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    taxonomies: {
      genre: { restBase: "genres", names: ["Alpha"] },
    },
  });
  assert.deepEqual(siteB.taxonomies, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    taxonomies: {
      genre: { restBase: "genres", names: ["Beta"] },
    },
  });
  assert.deepEqual(siteA.meta.values, { rating: 1, site_note: "A" });
  assert.deepEqual(siteB.meta.values, { rating: 2, site_note: "B" });
  assert.deepEqual(siteA.editorial, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
  });
  assert.deepEqual(siteB.editorial, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    password: "site-b-only",
    commentStatus: "closed",
    pingStatus: "open",
  });
  assert.deepEqual(siteA.pageStructure, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "pages",
    parentRemoteId: "101",
    template: "landing-a.php",
    menuOrder: 1,
  });
  assert.deepEqual(siteB.pageStructure, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "pages",
    parentRemoteId: "202",
    template: "landing-b.php",
    menuOrder: 9,
  });

  assert.equal(final.publication.current.content.attributes.sourceTaxonomies, undefined);
  assert.equal(final.publication.current.content.attributes.sourceMeta, undefined);
  assert.equal(final.publication.current.content.attributes.sourceEditorial, undefined);
  assert.equal(final.publication.current.content.attributes.sourcePage, undefined);

  await assert.rejects(
    () => manager.setSourceMetaValues("publication-native-metadata-matrix", 9, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-a",
      contentType: "posts",
      groupId: "group-a",
      routeId: "wordpress",
      values: { rating: 3 },
    }),
    /content type/,
  );
  await assert.rejects(
    () => manager.setSourceTaxonomies("publication-native-metadata-matrix", 9, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-a",
      contentType: "pages",
      groupId: "group-a",
      taxonomies: {},
    }),
    /both groupId and routeId/,
  );
  assert.equal(current().version, 9);
});


test("route-scoped WordPress standard taxonomy stays isolated and normalized per destination", async () => {
  const publication = {
    id: "publication-standard-taxonomy-matrix",
    createdAt: "2026-10-24T23:00:00.000Z",
    status: "draft",
    current: {
      id: "revision-1",
      ordinal: 1,
      createdAt: "2026-10-24T23:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Standard taxonomy matrix",
        language: "en",
        blocks: [],
        assets: [],
        tags: ["shared-tag"],
        attributes: {
          categories: ["Shared Category"],
          publishingTargets: { groupIds: ["group-a", "group-b"] },
        },
      },
    },
    provenance: { source: "blogmaatic.publication-workspace" },
  };
  const routeFor = (connectionId) => ({
    id: "wordpress",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId,
      channel: "posts",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
  });
  const groups = {
    async get(groupId) {
      if (groupId === "group-a") {
        return {
          enabled: true,
          group: { id: "group-a", name: "Site A", policySetId: "allow", routes: [routeFor("wp-a")] },
        };
      }
      if (groupId === "group-b") {
        return {
          enabled: true,
          group: { id: "group-b", name: "Site B", policySetId: "allow", routes: [routeFor("wp-b")] },
        };
      }
      return undefined;
    },
  };
  const { manager, current } = managerWith(publication, groups);

  const siteA = await manager.setSourceStandardTaxonomy("publication-standard-taxonomy-matrix", 1, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "posts",
    groupId: "group-a",
    routeId: "wordpress",
    categories: ["Local A", "Shared Category", " Local A "],
    tags: ["site-a", "shared-tag", "site-a"],
  });
  assert.equal(siteA.version, 2);

  const siteB = await manager.setSourceStandardTaxonomy("publication-standard-taxonomy-matrix", 2, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "posts",
    groupId: "group-b",
    routeId: "wordpress",
    categories: ["Local B"],
    tags: ["site-b"],
  });
  assert.equal(siteB.version, 3);

  const overrides = siteB.publication.current.content.attributes.destinationOverrides;
  assert.deepEqual(overrides.groups["group-a"].routes.wordpress.standardTaxonomy, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-a",
    contentType: "posts",
    categories: ["Local A", "Shared Category"],
    tags: ["shared-tag", "site-a"],
  });
  assert.deepEqual(overrides.groups["group-b"].routes.wordpress.standardTaxonomy, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "posts",
    categories: ["Local B"],
    tags: ["site-b"],
  });
  assert.deepEqual(siteB.publication.current.content.attributes.categories, ["Shared Category"]);
  assert.deepEqual(siteB.publication.current.content.tags, ["shared-tag"]);

  const retry = await manager.setSourceStandardTaxonomy("publication-standard-taxonomy-matrix", 3, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-b",
    contentType: "posts",
    groupId: "group-b",
    routeId: "wordpress",
    categories: ["Local B"],
    tags: ["site-b"],
  });
  assert.equal(retry.version, 3);

  await assert.rejects(
    () => manager.setSourceStandardTaxonomy("publication-standard-taxonomy-matrix", 3, {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-a",
      contentType: "pages",
      groupId: "group-a",
      routeId: "wordpress",
      categories: [],
      tags: [],
    }),
    /content type|destination\/content type/,
  );
  assert.equal(current().version, 3);
});
