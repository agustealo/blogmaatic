import assert from "node:assert/strict";
import test from "node:test";

import { parsePublicationWorkspaceListQuery } from "../dist/publication-workspace-validation.js";

test("publication list query accepts trimmed search with status and pagination", () => {
  assert.deepEqual(
    parsePublicationWorkspaceListQuery({
      search: "  wordpress safety  ",
      status: "approved",
      limit: "30",
      cursor: "cursor-1",
    }),
    {
      search: "wordpress safety",
      status: "approved",
      limit: 30,
      cursor: "cursor-1",
    },
  );
});

test("publication list query rejects empty, oversized, and unknown search input", () => {
  assert.throws(
    () => parsePublicationWorkspaceListQuery({ search: "   " }),
    /search must be a non-empty string/,
  );
  assert.throws(
    () => parsePublicationWorkspaceListQuery({ search: "x".repeat(201) }),
    /search must not exceed 200 characters/,
  );
  assert.throws(
    () => parsePublicationWorkspaceListQuery({ search: "valid", surprise: "nope" }),
    /unknown field: surprise/,
  );
});
