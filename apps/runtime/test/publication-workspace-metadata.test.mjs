import assert from "node:assert/strict";
import test from "node:test";

import { PublicationWorkspaceManager } from "../dist/publication-workspace-manager.js";

function managerWith(publication) {
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
    publicationGroups: {},
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
