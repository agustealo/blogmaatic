import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePublicationWorkspaceCreateBody,
  parsePublicationWorkspaceUpdateBody,
} from "../dist/publication-workspace-validation.js";

test("workspace accepts mixed canonical blocks without flattening", () => {
  const blocks = [
    { id: "heading", kind: "heading", data: { level: 2, text: "A heading" } },
    { id: "paragraph", kind: "paragraph", data: { text: "Body" } },
    { id: "quote", kind: "quote", data: { text: "Quoted", attribution: "Source" } },
    { id: "code", kind: "code", data: { language: "js", code: "const x = 1;" } },
    { id: "callout", kind: "callout", data: { label: "Note", text: "Remember this" } },
    { id: "embed", kind: "embed", data: { html: "<div>trusted canonical html</div>" } },
    { id: "gallery", kind: "gallery", data: { items: [{ src: "https://example.test/one.jpg" }] } },
    { id: "table", kind: "table", data: { headers: ["A"], rows: [["B"]] } },
  ];

  const parsed = parsePublicationWorkspaceCreateBody({
    title: "Blocks",
    blocks,
  });
  assert.deepEqual(parsed.blocks, blocks);

  const update = parsePublicationWorkspaceUpdateBody({
    expectedVersion: 2,
    blocks: [...blocks].reverse(),
  });
  assert.deepEqual(update.blocks, [...blocks].reverse());
});

test("workspace block validation rejects ambiguity, duplicate ids, future kinds, and unsafe JSON", () => {
  assert.throws(
    () => parsePublicationWorkspaceCreateBody({
      title: "Ambiguous",
      body: "legacy body",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "block" } }],
    }),
    /blocks and body are mutually exclusive/,
  );

  assert.throws(
    () => parsePublicationWorkspaceCreateBody({
      title: "Ambiguous format",
      bodyFormat: "html",
      blocks: [{ id: "p1", kind: "paragraph", data: { text: "block" } }],
    }),
    /bodyFormat cannot be used with blocks/,
  );

  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({
      expectedVersion: 1,
      blocks: [
        { id: "same", kind: "paragraph", data: { text: "one" } },
        { id: "same", kind: "quote", data: { text: "two" } },
      ],
    }),
    /duplicate id: same/,
  );

  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({
      expectedVersion: 1,
      blocks: [{ id: "future", kind: "future-widget", data: {} }],
    }),
    /kind is unsupported/,
  );

  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({
      expectedVersion: 1,
      blocks: [{ id: "unsafe", kind: "paragraph", data: { text: undefined } }],
    }),
    /JSON-safe values/,
  );

  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({
      expectedVersion: 1,
      blocks: [{ id: "nan", kind: "paragraph", data: { score: Number.NaN } }],
    }),
    /JSON-safe values/,
  );
});
