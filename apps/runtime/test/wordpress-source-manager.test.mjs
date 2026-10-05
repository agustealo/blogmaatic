import assert from "node:assert/strict";
import test from "node:test";

import { WordPressSourceManager } from "../dist/wordpress-source-manager.js";

function snapshot(managed = false, publicationId, routeId) {
  return {
    post: {
      id: 55,
      author: 7,
      title: "Existing WordPress article",
      excerpt: "<p>Imported summary</p>",
      contentHtml: "<h2>Imported heading</h2><p>Imported body.</p>",
      slug: "existing-wordpress-article",
      status: "publish",
      link: "https://example.test/?p=55",
      dateGmt: "2026-10-04T12:00:00",
      modifiedGmt: "2026-10-04T12:30:00",
      categoryIds: [4],
      tagIds: [8],
      featuredMediaId: 12,
      ownership: {
        managed,
        ...(publicationId ? { publicationId } : {}),
        ...(routeId ? { routeId } : {}),
      },
    },
    categoryNames: ["Publishing"],
    tagNames: ["automation"],
    featuredMedia: {
      id: 12,
      slug: "hero",
      source_url: "https://example.test/uploads/hero.jpg",
    },
  };
}

test("WordPress import creates one canonical publication and recovers it on retry", async () => {
  let currentSnapshot = snapshot();
  let stored;
  let adoptCount = 0;
  const projectionWrites = [];
  const historyWrites = [];
  let idIndex = 0;
  const ids = ["publication-id", "revision-id", "unused-id"];

  const content = {
    async importSnapshot() {
      return currentSnapshot;
    },
    async adopt(_connectionId, _remoteId, projection) {
      adoptCount += 1;
      currentSnapshot = snapshot(true, projection.publicationId, projection.routeId);
      return currentSnapshot.post;
    },
  };

  const publisher = {
    async compile({ publication, route }) {
      return {
        projectionId: `${publication.id}:${route.id}`,
        publicationId: publication.id,
        sourceRevisionId: publication.current.id,
        routeId: route.id,
        destination: route.destination,
        payload: {},
        fingerprint: `${publication.current.id}:${route.variant?.status ?? "publish"}:${route.variant?.slug ?? ""}`,
      };
    },
  };

  const group = {
    id: "group-main",
    name: "Main publishing",
    policySetId: "default",
    routes: [{
      id: "route-wordpress",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
      variant: { status: "publish" },
    }],
  };

  const publicationGroups = {
    async get(id) {
      assert.equal(id, "group-main");
      return { group, version: 3, enabled: true, recordedAt: "2026-10-05T01:00:00.000Z" };
    },
  };

  const publications = {
    async findImportedSource(extensionId, connectionId, remoteId) {
      assert.equal(extensionId, "blogmaatic.wordpress-rest");
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "55");
      return stored;
    },
    async registerImported(publication) {
      assert.equal(stored, undefined);
      stored = {
        publication,
        version: 1,
        recordedAt: "2026-10-05T02:00:00.000Z",
        updatedAt: "2026-10-05T02:00:00.000Z",
      };
      return stored;
    },
  };

  const manager = new WordPressSourceManager({
    content,
    publisher,
    publicationGroups,
    publications,
    projectionState: {
      async put(record) {
        projectionWrites.push(record);
      },
    },
    distributionHistory: {
      async append(record) {
        if (!historyWrites.some((existing) => existing.id === record.id)) historyWrites.push(record);
      },
    },
    now: () => "2026-10-05T02:00:00.000Z",
    id: () => ids[idIndex++] ?? `id-${idIndex}`,
  });

  const first = await manager.import("wp-main", "55", {
    groupId: "group-main",
    routeId: "route-wordpress",
  });

  assert.equal(first.publication.publication.current.ordinal, 1);
  assert.equal(first.publication.publication.status, "draft");
  assert.equal(first.publication.publication.provenance.source, "wordpress");
  assert.equal(first.publication.publication.provenance.remoteId, "55");
  assert.equal(first.publication.publication.current.content.tags[0], "automation");
  assert.equal(first.publication.publication.current.content.attributes.categories[0], "Publishing");
  assert.equal(first.publication.publication.current.content.blocks[0].kind, "embed");
  assert.equal(first.publication.publication.current.content.assets[0].attributes.wordpressMediaId, 12);
  assert.equal(first.remote.managed, true);
  assert.equal(adoptCount, 1);
  assert.equal(projectionWrites.length, 1);
  assert.equal(projectionWrites[0].remote.id, "55");
  assert.equal(historyWrites.length, 1);
  assert.equal(historyWrites[0].groupSnapshot.id, "group-main");
  assert.equal(historyWrites[0].receipt.evidence.action, "wordpress.import");

  const canonicalId = first.publication.publication.id;
  const canonicalRevision = first.publication.publication.current.id;

  const second = await manager.import("wp-main", "55", {
    groupId: "group-main",
    routeId: "route-wordpress",
  });

  assert.equal(second.publication.publication.id, canonicalId);
  assert.equal(second.publication.publication.current.id, canonicalRevision);
  assert.equal(adoptCount, 1);
  assert.equal(projectionWrites.length, 2);
  assert.equal(historyWrites.length, 1);
});
