import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePublicationWorkspaceCreateBody,
  parsePublicationWorkspaceUpdateBody,
} from "../dist/publication-workspace-validation.js";

test("publication metadata accepts categories and featured image tri-state", () => {
  assert.deepEqual(
    parsePublicationWorkspaceCreateBody({
      title: "Metadata",
      categories: ["News", "Guides"],
    }),
    {
      title: "Metadata",
      categories: ["News", "Guides"],
    },
  );

  assert.deepEqual(
    parsePublicationWorkspaceUpdateBody({
      expectedVersion: 3,
      categories: ["Tutorials"],
      featuredAssetId: " hero ",
    }),
    {
      expectedVersion: 3,
      categories: ["Tutorials"],
      featuredAssetId: "hero",
    },
  );

  assert.deepEqual(
    parsePublicationWorkspaceUpdateBody({
      expectedVersion: 3,
      featuredAssetId: null,
    }),
    {
      expectedVersion: 3,
      featuredAssetId: null,
    },
  );
});

test("publication metadata rejects malformed category and featured image values", () => {
  assert.throws(
    () => parsePublicationWorkspaceCreateBody({ title: "Bad", categories: [""] }),
    /categories must be an array of non-empty strings/,
  );
  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({ expectedVersion: 1, featuredAssetId: "" }),
    /featuredAssetId must be a non-empty string or null/,
  );
  assert.throws(
    () => parsePublicationWorkspaceUpdateBody({ expectedVersion: 1, featuredAssetId: 42 }),
    /featuredAssetId must be a non-empty string or null/,
  );
});
