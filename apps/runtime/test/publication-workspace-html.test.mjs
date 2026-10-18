import assert from "node:assert/strict";
import test from "node:test";

import { PublicationWorkspaceManager } from "../dist/publication-workspace-manager.js";

test("imported HTML remains an editable canonical embed block across revisions", async () => {
  let entry;
  const store = {
    async create(publication, recordedAt) {
      entry = {
        publication,
        version: 1,
        recordedAt,
        updatedAt: recordedAt,
      };
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
        recordedAt: updatedAt,
        updatedAt,
      };
      return entry;
    },
  };

  let idIndex = 0;
  const ids = ["next-revision"];
  const manager = new PublicationWorkspaceManager({
    store,
    publicationGroups: {},
    controlPlane: {},
    now: () => "2026-10-05T04:00:00.000Z",
    id: () => ids[idIndex++] ?? `id-${idIndex}`,
  });

  const imported = await manager.registerImported({
    id: "publication-imported",
    createdAt: "2026-10-05T03:00:00.000Z",
    slug: "imported",
    status: "draft",
    current: {
      id: "revision-imported",
      ordinal: 1,
      createdAt: "2026-10-05T03:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Imported",
        language: "en",
        blocks: [{
          id: "wordpress-source-html",
          kind: "embed",
          data: { html: "<h2>Original</h2><p>Body</p>" },
        }],
        assets: [],
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
  });

  const updated = await manager.update(imported.publication.id, {
    expectedVersion: imported.version,
    body: "<h2>Edited</h2><p>Still structured.</p>",
    bodyFormat: "html",
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.publication.current.ordinal, 2);
  assert.equal(updated.publication.current.id, "revision_next-revision");
  assert.equal(updated.publication.current.content.blocks.length, 1);
  assert.equal(updated.publication.current.content.blocks[0].kind, "embed");
  assert.equal(
    updated.publication.current.content.blocks[0].data.html,
    "<h2>Edited</h2><p>Still structured.</p>",
  );
  assert.equal(updated.publication.provenance.source, "wordpress");
});
