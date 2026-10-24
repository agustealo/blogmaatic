import assert from "node:assert/strict";
import test from "node:test";

import { PublicationDestinationMatrixManager } from "../dist/publication-destination-matrix-manager.js";

function destination(extensionId, connectionId, channel) {
  return { extensionId, connectionId, channel };
}

function groupEntry(id, name, version, routes) {
  return {
    group: { id, name, policySetId: "default", routes },
    version,
    enabled: true,
    recordedAt: "2026-10-24T20:00:00.000Z",
    updatedAt: "2026-10-24T20:00:00.000Z",
  };
}

function route(id, extensionId, connectionId, channel, enabled = true) {
  return {
    id,
    destination: destination(extensionId, connectionId, channel),
    requiredCapabilities: [],
    desiredState: "present",
    enabled,
  };
}

function history({
  id,
  groupId,
  routeId,
  revisionId,
  status,
  extensionId,
  connectionId,
  channel,
  recordedAt,
  remote,
}) {
  return {
    id,
    publicationId: "publication-1",
    revisionId,
    groupId,
    routeId,
    projectionId: `projection-${id}`,
    destination: destination(extensionId, connectionId, channel),
    groupSnapshot: { id: groupId, name: groupId, policySetId: "default", routes: [] },
    receipt: {
      publicationId: "publication-1",
      revisionId,
      groupId,
      routeId,
      projectionId: `projection-${id}`,
      status,
      policy: { effect: "allow", reason: "test" },
      ...(remote ? { remote } : {}),
      completedAt: recordedAt,
    },
    recordedAt,
  };
}

test("destination matrix joins configured routes with full durable history and preview truth", async () => {
  const groups = [
    groupEntry("group-a", "Primary distribution", 4, [
      route("never", "blogmaatic.wordpress-rest", "wp-main", "posts"),
      route("current", "blogmaatic.jekyll-git", "jekyll-main", "posts"),
      route("older", "blogmaatic.linkedin-rest", "linkedin-main", "feed"),
      route("drift", "blogmaatic.facebook-pages", "facebook-main", "feed"),
      route("failed", "blogmaatic.wordpress-rest", "wp-backup", "posts"),
      route("disabled", "blogmaatic.wordpress-rest", "wp-disabled", "posts", false),
      route("shared", "blogmaatic.wordpress-rest", "wp-shared-a", "posts"),
    ]),
    groupEntry("group-b", "Secondary distribution", 2, [
      route("shared", "blogmaatic.wordpress-rest", "wp-shared-b", "posts"),
    ]),
  ];

  const pageOne = [
    history({
      id: "h-failed",
      groupId: "group-a",
      routeId: "failed",
      revisionId: "revision-current",
      status: "unreachable",
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-backup",
      channel: "posts",
      recordedAt: "2026-10-24T21:05:00.000Z",
    }),
    history({
      id: "h-drift",
      groupId: "group-a",
      routeId: "drift",
      revisionId: "revision-current",
      status: "drifted",
      extensionId: "blogmaatic.facebook-pages",
      connectionId: "facebook-main",
      channel: "feed",
      recordedAt: "2026-10-24T21:04:00.000Z",
      remote: { id: "fb-1", url: "https://example.test/fb-1" },
    }),
    history({
      id: "h-current",
      groupId: "group-a",
      routeId: "current",
      revisionId: "revision-current",
      status: "verified",
      extensionId: "blogmaatic.jekyll-git",
      connectionId: "jekyll-main",
      channel: "posts",
      recordedAt: "2026-10-24T21:03:00.000Z",
      remote: { id: "_posts/article.md", url: "https://example.test/article" },
    }),
  ];
  const pageTwo = [
    history({
      id: "h-older",
      groupId: "group-a",
      routeId: "older",
      revisionId: "revision-previous",
      status: "verified",
      extensionId: "blogmaatic.linkedin-rest",
      connectionId: "linkedin-main",
      channel: "feed",
      recordedAt: "2026-10-24T21:02:00.000Z",
      remote: { id: "li-old" },
    }),
    history({
      id: "h-shared-a-new",
      groupId: "group-a",
      routeId: "shared",
      revisionId: "revision-current",
      status: "verified",
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-shared-a",
      channel: "posts",
      recordedAt: "2026-10-24T21:01:00.000Z",
      remote: { id: "101" },
    }),
    history({
      id: "h-shared-a-old",
      groupId: "group-a",
      routeId: "shared",
      revisionId: "revision-previous",
      status: "verified",
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-shared-a",
      channel: "posts",
      recordedAt: "2026-10-24T20:59:00.000Z",
      remote: { id: "101" },
    }),
    history({
      id: "h-shared-b",
      groupId: "group-b",
      routeId: "shared",
      revisionId: "revision-previous",
      status: "verified",
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-shared-b",
      channel: "posts",
      recordedAt: "2026-10-24T20:58:00.000Z",
      remote: { id: "202" },
    }),
    // Same group/route id as current route, but old destination identity. Must not leak.
    history({
      id: "h-rewired",
      groupId: "group-a",
      routeId: "never",
      revisionId: "revision-current",
      status: "verified",
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-old-wire",
      channel: "posts",
      recordedAt: "2026-10-24T20:57:00.000Z",
      remote: { id: "999" },
    }),
  ];

  let historyCalls = 0;
  const matrix = new PublicationDestinationMatrixManager({
    publications: {
      async get(id) {
        assert.equal(id, "publication-1");
        return {
          publication: {
            id: "publication-1",
            createdAt: "2026-10-24T19:00:00.000Z",
            status: "approved",
            current: {
              id: "revision-current",
              ordinal: 8,
              createdAt: "2026-10-24T21:00:00.000Z",
              content: {
                schemaVersion: 1,
                title: "Matrix proof",
                language: "en",
                blocks: [],
                assets: [],
                tags: [],
                attributes: {},
              },
            },
            provenance: { source: "blogmaatic.publication-workspace" },
          },
          version: 9,
          recordedAt: "2026-10-24T21:00:00.000Z",
          updatedAt: "2026-10-24T21:00:00.000Z",
        };
      },
    },
    publicationGroups: {
      async list(query) {
        assert.equal(query.enabled, true);
        return { items: groups };
      },
    },
    distributions: {
      async list(publicationId, query) {
        assert.equal(publicationId, "publication-1");
        historyCalls += 1;
        if (!query.cursor) {
          assert.equal(query.limit, 200);
          return { items: pageOne, nextCursor: "page-2" };
        }
        assert.equal(query.cursor, "page-2");
        return { items: pageTwo };
      },
    },
    previews: {
      async preview(publicationId, groupId) {
        assert.equal(publicationId, "publication-1");
        const group = groups.find((entry) => entry.group.id === groupId);
        return {
          publicationId,
          revisionId: "revision-current",
          revisionOrdinal: 8,
          groupId,
          groupName: group.group.name,
          items: group.group.routes.filter((item) => item.enabled).map((item) => ({
            ...(item.id === "drift"
              ? {
                status: "error",
                routeId: item.id,
                destination: {
                  ...item.destination,
                  extensionName: "Facebook Pages",
                  connectionName: "Facebook Main",
                },
                sourceRevisionId: "revision-current",
                error: "Image exceeds destination contract",
              }
              : {
                status: "ready",
                routeId: item.id,
                destination: {
                  ...item.destination,
                  extensionName: item.destination.extensionId,
                  connectionName: item.destination.connectionId,
                },
                projectionId: `preview-${groupId}-${item.id}`,
                sourceRevisionId: "revision-current",
                fingerprint: `fingerprint-${groupId}-${item.id}`,
                payload: {},
                summary: {},
              }),
          })),
        };
      },
    },
    now: () => "2026-10-24T22:00:00.000Z",
  });

  const result = await matrix.get("publication-1");
  assert.equal(historyCalls, 2);
  assert.equal(result.currentRevisionId, "revision-current");
  assert.equal(result.currentRevisionOrdinal, 8);
  assert.equal(result.generatedAt, "2026-10-24T22:00:00.000Z");
  assert.equal(result.items.length, 7);
  assert.equal(result.items.some((item) => item.routeId === "disabled"), false);

  const byKey = new Map(result.items.map((item) => [`${item.groupId}:${item.routeId}`, item]));
  assert.equal(byKey.get("group-a:never").state, "not_sent");
  assert.equal(byKey.get("group-a:never").deliveryCount, 0);
  assert.equal(byKey.get("group-a:current").state, "current");
  assert.equal(byKey.get("group-a:current").remote.url, "https://example.test/article");
  assert.equal(byKey.get("group-a:older").state, "update_available");
  assert.equal(byKey.get("group-a:drift").state, "drifted");
  assert.equal(byKey.get("group-a:drift").preview.status, "error");
  assert.match(byKey.get("group-a:drift").preview.error, /Image exceeds/);
  assert.equal(byKey.get("group-a:failed").state, "failed");

  assert.equal(byKey.get("group-a:shared").state, "current");
  assert.equal(byKey.get("group-a:shared").deliveryCount, 2);
  assert.equal(byKey.get("group-a:shared").remote.id, "101");
  assert.equal(byKey.get("group-b:shared").state, "update_available");
  assert.equal(byKey.get("group-b:shared").deliveryCount, 1);
  assert.equal(byKey.get("group-b:shared").remote.id, "202");
  assert.notEqual(byKey.get("group-a:shared").key, byKey.get("group-b:shared").key);
});

test("destination matrix keeps receipt evidence when an entire group preview fails", async () => {
  const group = groupEntry("group-a", "Primary", 1, [
    route("wp", "blogmaatic.wordpress-rest", "wp-main", "posts"),
  ]);
  const record = history({
    id: "history-1",
    groupId: "group-a",
    routeId: "wp",
    revisionId: "revision-current",
    status: "verified",
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    channel: "posts",
    recordedAt: "2026-10-24T21:00:00.000Z",
    remote: { id: "55", url: "https://example.test/?p=55" },
  });
  const matrix = new PublicationDestinationMatrixManager({
    publications: {
      async get() {
        return {
          publication: {
            id: "publication-1",
            createdAt: "2026-10-24T19:00:00.000Z",
            status: "approved",
            current: {
              id: "revision-current",
              ordinal: 2,
              createdAt: "2026-10-24T20:00:00.000Z",
              content: {
                schemaVersion: 1,
                title: "Preview failure",
                language: "en",
                blocks: [],
                assets: [],
                tags: [],
                attributes: {},
              },
            },
            provenance: { source: "wordpress" },
          },
          version: 2,
          recordedAt: "2026-10-24T20:00:00.000Z",
          updatedAt: "2026-10-24T20:00:00.000Z",
        };
      },
    },
    publicationGroups: { async list() { return { items: [group] }; } },
    distributions: { async list() { return { items: [record] }; } },
    previews: { async preview() { throw new Error("Compiler unavailable"); } },
  });

  const result = await matrix.get("publication-1");
  assert.equal(result.items[0].state, "current");
  assert.equal(result.items[0].remote.id, "55");
  assert.equal(result.items[0].preview.status, "error");
  assert.match(result.items[0].preview.error, /Compiler unavailable/);
});
