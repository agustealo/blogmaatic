import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqlitePublicationWorkspaceStore } from "../dist/index.js";

function publication(title = "Consumer proof", status = "draft") {
  return {
    id: "publication-proof",
    createdAt: "2026-09-28T18:00:00.000Z",
    slug: "consumer-proof",
    status,
    current: {
      id: title === "Consumer proof" ? "revision-1" : "revision-2",
      ordinal: title === "Consumer proof" ? 1 : 2,
      createdAt: title === "Consumer proof" ? "2026-09-28T18:00:00.000Z" : "2026-09-28T18:05:00.000Z",
      content: {
        schemaVersion: 1,
        title,
        language: "en",
        blocks: [{ id: "paragraph-1", kind: "paragraph", data: { text: "Real content." } }],
        assets: [],
        tags: ["consumer"],
        attributes: {},
      },
    },
    provenance: { source: "test" },
  };
}

async function withStore(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-publication-workspace-"));
  const path = join(directory, "control.sqlite");
  const store = new SqlitePublicationWorkspaceStore(path);
  try {
    await fn({ store, path });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("publication workspace is immutable, optimistic, filtered, and cursor-paginated", async () => {
  await withStore(async ({ store }) => {
    const created = await store.create(publication(), "2026-09-28T18:00:00.000Z");
    assert.equal(created.version, 1);
    assert.equal(created.publication.current.id, "revision-1");

    const updated = await store.update(publication("Consumer proof revised", "ready"), 1, "2026-09-28T18:05:00.000Z");
    assert.equal(updated.version, 2);
    assert.equal(updated.publication.status, "ready");

    const original = await store.getVersion("publication-proof", 1);
    assert.equal(original.publication.current.content.title, "Consumer proof");
    assert.equal(original.publication.status, "draft");

    await assert.rejects(
      () => store.update(publication("Stale write"), 1, "2026-09-28T18:06:00.000Z"),
      /changed from version 1 to 2/,
    );

    const ready = await store.list({ status: "ready", limit: 1 });
    assert.equal(ready.items.length, 1);
    assert.equal(ready.items[0].publication.id, "publication-proof");

    const versions = await store.listVersions("publication-proof", { limit: 1 });
    assert.deepEqual(versions.items.map((entry) => entry.version), [2]);
    assert.ok(versions.nextCursor);
    const secondPage = await store.listVersions("publication-proof", { limit: 1, cursor: versions.nextCursor });
    assert.deepEqual(secondPage.items.map((entry) => entry.version), [1]);
  });
});

test("publication workspace survives restart on the shared control-plane database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-publication-workspace-restart-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = new SqlitePublicationWorkspaceStore(path);
    await first.create(publication(), "2026-09-28T18:00:00.000Z");
    first.close();

    const second = new SqlitePublicationWorkspaceStore(path);
    try {
      const restored = await second.get("publication-proof");
      assert.equal(restored.version, 1);
      assert.equal(restored.publication.current.content.title, "Consumer proof");
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
