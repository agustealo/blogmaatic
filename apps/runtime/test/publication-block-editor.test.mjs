import assert from "node:assert/strict";
import test from "node:test";

import { PublicationWorkspaceManager } from "../dist/publication-workspace-manager.js";

function harness() {
  let entry;
  let idIndex = 0;
  const ids = ["publication-blocks", "revision-1", "revision-2", "revision-3", "revision-4", "revision-5"];
  const store = {
    async create(publication, recordedAt) {
      entry = { publication, version: 1, recordedAt, updatedAt: recordedAt };
      return entry;
    },
    async get(id) {
      return entry?.publication.id === id ? entry : undefined;
    },
    async update(publication, expectedVersion, updatedAt) {
      assert.equal(expectedVersion, entry.version);
      entry = {
        publication,
        version: expectedVersion + 1,
        recordedAt: entry.recordedAt,
        updatedAt,
      };
      return entry;
    },
  };
  const manager = new PublicationWorkspaceManager({
    store,
    publicationGroups: {},
    controlPlane: {},
    now: () => "2026-10-25T00:20:00.000Z",
    id: () => ids[idIndex++] ?? `block-id-${idIndex}`,
  });
  return { manager, current: () => entry };
}

test("mixed canonical blocks round-trip losslessly and reorder as immutable revisions", async () => {
  const { manager } = harness();
  const original = [
    { id: "h", kind: "heading", data: { level: 2, text: "Heading" } },
    { id: "p", kind: "paragraph", data: { text: "Paragraph" } },
    { id: "q", kind: "quote", data: { text: "Quote", attribution: "Author" } },
    { id: "c", kind: "code", data: { language: "js", code: "const x = 1;" } },
    { id: "n", kind: "callout", data: { label: "Note", text: "Notice" } },
    { id: "e", kind: "embed", data: { html: "<div>Embed</div>" } },
    { id: "g", kind: "gallery", data: { items: [{ src: "https://example.test/gallery.jpg", alt: "Gallery" }] } },
    { id: "t", kind: "table", data: { headers: ["Name"], rows: [["Blogmaatic"]] } },
  ];

  const created = await manager.create({
    title: "Block document",
    blocks: original,
    tags: ["blocks"],
    categories: ["Publishing"],
  });
  assert.deepEqual(created.publication.current.content.blocks, original);
  assert.equal(created.publication.current.ordinal, 1);

  const reordered = [
    original[1],
    { ...original[0], data: { level: 3, text: "Heading revised" } },
    ...original.slice(2),
  ];
  const updated = await manager.update(created.publication.id, {
    expectedVersion: 1,
    blocks: reordered,
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.publication.current.ordinal, 2);
  assert.notEqual(updated.publication.current.id, created.publication.current.id);
  assert.deepEqual(updated.publication.current.content.blocks, reordered);
  assert.deepEqual(updated.publication.current.content.tags, ["blocks"]);
  assert.deepEqual(updated.publication.current.content.attributes.categories, ["Publishing"]);
  assert.deepEqual(
    updated.publication.current.content.blocks.find((block) => block.id === "g").data,
    original.find((block) => block.id === "g").data,
  );
  assert.deepEqual(
    updated.publication.current.content.blocks.find((block) => block.id === "t").data,
    original.find((block) => block.id === "t").data,
  );
});

test("image block mutations require valid canonical image assets", async () => {
  const { manager, current } = harness();
  const created = await manager.create({
    title: "Image blocks",
    blocks: [{ id: "intro", kind: "paragraph", data: { text: "Intro" } }],
  });

  const attached = await manager.attachAsset(created.publication.id, 1, {
    id: "hero",
    kind: "image",
    source: "https://example.test/hero.jpg",
    mediaType: "image/jpeg",
    alt: "Hero",
  });
  assert.equal(attached.version, 2);

  const withImage = await manager.update(created.publication.id, {
    expectedVersion: 2,
    blocks: [
      { id: "intro", kind: "paragraph", data: { text: "Intro" } },
      { id: "hero-block", kind: "image", data: { assetId: "hero", caption: "Canonical hero" } },
    ],
  });
  assert.equal(withImage.version, 3);
  assert.equal(withImage.publication.current.content.blocks[1].data.assetId, "hero");

  await assert.rejects(
    () => manager.update(created.publication.id, {
      expectedVersion: 3,
      blocks: [{ id: "missing", kind: "image", data: { assetId: "missing" } }],
    }),
    /references missing asset: missing/,
  );
  assert.equal(current().version, 3);

  await assert.rejects(
    () => manager.update(created.publication.id, {
      expectedVersion: 3,
      blocks: [{ id: "legacy-image", kind: "image", data: { src: "https://cdn.example.test/legacy.jpg", alt: "Legacy" } }],
    }),
    /requires canonical assetId/,
  );
  assert.equal(current().version, 3);
});

test("direct workspace mutations reject duplicate future blocks and ambiguous legacy body writes", async () => {
  const { manager, current } = harness();
  const created = await manager.create({
    title: "Guard rails",
    blocks: [{ id: "p", kind: "paragraph", data: { text: "Safe" } }],
  });

  await assert.rejects(
    () => manager.update(created.publication.id, {
      expectedVersion: 1,
      blocks: [
        { id: "same", kind: "paragraph", data: { text: "One" } },
        { id: "same", kind: "paragraph", data: { text: "Two" } },
      ],
    }),
    /duplicate id: same/,
  );

  await assert.rejects(
    () => manager.update(created.publication.id, {
      expectedVersion: 1,
      blocks: [{ id: "future", kind: "future-widget", data: {} }],
    }),
    /unsupported kind/,
  );

  await assert.rejects(
    () => manager.update(created.publication.id, {
      expectedVersion: 1,
      body: "legacy",
      blocks: [{ id: "p2", kind: "paragraph", data: { text: "structured" } }],
    }),
    /mutually exclusive/,
  );

  assert.equal(current().version, 1);

  const statusOnly = await manager.update(created.publication.id, {
    expectedVersion: 1,
    status: "ready",
  });
  assert.deepEqual(statusOnly.publication.current.content.blocks, created.publication.current.content.blocks);
  assert.equal(statusOnly.publication.current.id, created.publication.current.id);
});
