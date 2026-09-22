import assert from "node:assert/strict";
import test from "node:test";

import { adaptPublicationForSocial } from "../dist/index.js";

function publication(overrides = {}) {
  return {
    id: "pub-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    status: "approved",
    canonicalUrl: "https://example.com/articles/control-plane",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T12:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Publication Control Plane",
        summary: "Own once. Maintain everywhere.",
        language: "en",
        tags: ["publishing", "automation"],
        assets: [
          { id: "hero", kind: "image", source: "/tmp/hero.png", mediaType: "image/png", alt: "Diagram" },
          { id: "second", kind: "image", source: "/tmp/second.png", mediaType: "image/png" },
        ],
        attributes: {},
        blocks: [
          { id: "h1", kind: "heading", data: { text: "Why it matters", level: 2 } },
          { id: "p1", kind: "paragraph", data: { text: "One publication can have many projections." } },
          { id: "img", kind: "image", data: { assetId: "hero" } },
          { id: "gallery", kind: "gallery", data: { items: [{ assetId: "second" }] } },
          { id: "table", kind: "table", data: { headers: ["Hub", "State"], rows: [["Web", "Live"]] } },
        ],
      },
    },
    provenance: {},
    ...overrides,
  };
}

const linkedInProfile = {
  id: "linkedin",
  maxCommentaryChars: 3000,
  maxImages: 1,
  supportsArticleCard: true,
  supportedBlockKinds: ["paragraph", "image"],
};

test("adapts rich publication content and reports fidelity losses", () => {
  const result = adaptPublicationForSocial(publication(), linkedInProfile, {
    mode: "article",
    includeCanonicalUrl: false,
    includeHashtags: true,
  });

  assert.equal(result.article.source, "https://example.com/articles/control-plane");
  assert.equal(result.imageAssets.length, 1);
  assert.match(result.commentary, /Publication Control Plane/);
  assert.match(result.commentary, /#publishing #automation/);
  assert.equal(result.fidelity.exact, false);
  assert.ok(result.fidelity.issues.some((issue) => issue.code === "block.unsupported"));
  assert.ok(result.fidelity.issues.some((issue) => issue.code === "media.images_dropped"));
});

test("preserves suffix when commentary is deterministically truncated", () => {
  const result = adaptPublicationForSocial(publication(), { ...linkedInProfile, maxCommentaryChars: 90 }, {
    mode: "text",
    includeCanonicalUrl: true,
    includeHashtags: false,
  });

  assert.equal(result.commentary.length <= 90, true);
  assert.match(result.commentary, /https:\/\/example.com\/articles\/control-plane$/);
  assert.ok(result.fidelity.issues.some((issue) => issue.code === "commentary.truncated"));
});

test("fails article mode fidelity when no canonical URL exists", () => {
  const item = publication({ canonicalUrl: undefined });
  const result = adaptPublicationForSocial(item, linkedInProfile, { mode: "article" });
  assert.equal(result.article, undefined);
  assert.ok(result.fidelity.issues.some((issue) => issue.code === "article.missing_canonical"));
});
