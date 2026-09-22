import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteProjectionStateStore } from "../dist/index.js";

test("persists projection identity across store restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-state-"));
  const path = join(directory, "projection-state.sqlite");
  try {
    const first = new SqliteProjectionStateStore(path);
    await first.put({
      publicationId: "pub-1",
      routeId: "route-linkedin",
      projectionId: "pub-1:route-linkedin",
      extensionId: "blogmaatic.linkedin-rest",
      connectionId: "linkedin-company",
      sourceRevisionId: "rev-4",
      desiredFingerprint: "abc123",
      remote: {
        id: "urn:li:share:123",
        url: "https://www.linkedin.com/feed/update/urn:li:share:123",
      },
      updatedAt: "2026-09-22T18:00:00.000Z",
    });
    first.close();

    const second = new SqliteProjectionStateStore(path);
    const restored = await second.get("pub-1", "route-linkedin");
    assert.equal(restored?.remote.id, "urn:li:share:123");
    assert.equal(restored?.desiredFingerprint, "abc123");
    await second.delete("pub-1", "route-linkedin");
    assert.equal(await second.get("pub-1", "route-linkedin"), undefined);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
