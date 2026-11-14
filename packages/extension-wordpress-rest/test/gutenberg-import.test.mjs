import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { EnvironmentSecretProvider, SecretAuthority } from "@blogmaatic/secrets";
import {
  WordPressRestPublisher,
  importWordPressContentBlocks,
} from "../dist/index.js";

function publication(blocks) {
  return {
    id: "publication-gutenberg",
    createdAt: "2026-11-13T20:00:00.000Z",
    status: "draft",
    slug: "gutenberg-proof",
    current: {
      id: "revision-gutenberg",
      ordinal: 1,
      createdAt: "2026-11-13T20:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Gutenberg proof",
        language: "en",
        blocks,
        assets: [],
        tags: [],
        attributes: {},
      },
    },
    provenance: { source: "workspace" },
  };
}

test("simple Gutenberg core blocks become editable canonical blocks", () => {
  const source = [
    "<!-- wp:paragraph -->",
    "<p>Plain paragraph</p>",
    "<!-- /wp:paragraph -->",
    "<!-- wp:heading {\"level\":3} -->",
    "<h3>Plain heading</h3>",
    "<!-- /wp:heading -->",
    "<!-- wp:quote -->",
    "<blockquote><p>Quoted text</p><cite>Ada</cite></blockquote>",
    "<!-- /wp:quote -->",
    "<!-- wp:code -->",
    "<pre><code>const value = 42;\nreturn value;</code></pre>",
    "<!-- /wp:code -->",
  ].join("\n");

  assert.deepEqual(importWordPressContentBlocks(source), [
    {
      id: "wordpress-gutenberg-paragraph-0",
      kind: "paragraph",
      data: { text: "Plain paragraph" },
    },
    {
      id: "wordpress-gutenberg-heading-1",
      kind: "heading",
      data: { level: 3, text: "Plain heading" },
    },
    {
      id: "wordpress-gutenberg-quote-2",
      kind: "quote",
      data: { text: "Quoted text", attribution: "Ada" },
    },
    {
      id: "wordpress-gutenberg-code-3",
      kind: "code",
      data: { code: "const value = 42;\nreturn value;" },
    },
  ]);
});

test("inline formatting stays raw instead of flattening rich text", () => {
  const source = "<!-- wp:paragraph --><p>Hello <strong>world</strong></p><!-- /wp:paragraph -->";
  const blocks = importWordPressContentBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "embed");
  assert.match(blocks[0].data.html, /<!-- wp:paragraph -->/);
  assert.match(blocks[0].data.html, /<strong>world<\/strong>/);
  assert.match(blocks[0].data.html, /<!-- \/wp:paragraph -->/);
});

test("custom Gutenberg blocks preserve block identity attributes and raw markup", () => {
  const source = '<!-- wp:acme/card {"variant":"hero","count":2} --><section data-card="hero">Card</section><!-- /wp:acme/card -->';
  const blocks = importWordPressContentBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "embed");
  assert.match(blocks[0].data.html, /wp:acme\/card/);
  assert.match(blocks[0].data.html, /"variant":"hero"/);
  assert.match(blocks[0].data.html, /"count":2/);
  assert.match(blocks[0].data.html, /<section data-card="hero">Card<\/section>/);
});

test("nested Gutenberg layouts remain one raw subtree with nested comments intact", () => {
  const source = [
    "<!-- wp:group -->",
    "<div class=\"wp-block-group\">",
    "<!-- wp:columns -->",
    "<div class=\"wp-block-columns\">",
    "<!-- wp:column -->",
    "<div class=\"wp-block-column\">",
    "<!-- wp:paragraph --><p>Nested</p><!-- /wp:paragraph -->",
    "</div>",
    "<!-- /wp:column -->",
    "</div>",
    "<!-- /wp:columns -->",
    "</div>",
    "<!-- /wp:group -->",
  ].join("\n");

  const blocks = importWordPressContentBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "embed");
  assert.match(blocks[0].data.html, /<!-- wp:group -->/);
  assert.match(blocks[0].data.html, /<!-- wp:columns -->/);
  assert.match(blocks[0].data.html, /<!-- wp:paragraph -->/);
  assert.match(blocks[0].data.html, /Nested/);
});

test("classic HTML without Gutenberg delimiters remains one exact raw embed", () => {
  const source = '<h2>Classic</h2><p data-x="1">Body <strong>stays raw</strong>.</p>';
  assert.deepEqual(importWordPressContentBlocks(source), [{
    id: "wordpress-source-html",
    kind: "embed",
    data: { html: source },
  }]);
});

test("malformed Gutenberg serialization fails closed to the original raw document", () => {
  const source = '<!-- wp:paragraph {"broken": } --><p>Unsafe parse</p><!-- /wp:paragraph -->';
  assert.deepEqual(importWordPressContentBlocks(source), [{
    id: "wordpress-gutenberg-malformed",
    kind: "embed",
    data: { html: source },
  }]);
});

test("mixed Gutenberg content preserves document ordering across editable and raw blocks", () => {
  const source = [
    "<!-- wp:paragraph --><p>First</p><!-- /wp:paragraph -->",
    '<!-- wp:acme/widget {"mode":"x"} --><div>Raw middle</div><!-- /wp:acme/widget -->',
    "<!-- wp:heading --><h2>Last</h2><!-- /wp:heading -->",
  ].join("\n");

  const blocks = importWordPressContentBlocks(source);
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "embed", "heading"]);
  assert.equal(blocks[0].data.text, "First");
  assert.match(blocks[1].data.html, /acme\/widget/);
  assert.equal(blocks[2].data.text, "Last");
});

test("raw Gutenberg fallback survives WordPress projection compilation", async () => {
  const raw = '<!-- wp:acme/card {"variant":"hero"} --><section>Custom card</section><!-- /wp:acme/card -->';
  const blocks = importWordPressContentBlocks(raw);
  const connection = {
    id: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    displayName: "WordPress",
    status: "active",
    settings: {
      siteUrl: "https://example.test",
      username: "editor",
    },
    secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
    createdAt: "2026-11-13T20:00:00.000Z",
    updatedAt: "2026-11-13T20:00:00.000Z",
  };
  const publisher = new WordPressRestPublisher(
    new ConnectionAuthority([connection]),
    new SecretAuthority([
      new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" }),
    ]),
  );
  const projection = await publisher.compile({
    publication: publication(blocks),
    route: {
      id: "route-wordpress",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        channel: "posts",
      },
      requiredCapabilities: ["article.create"],
      variant: { status: "draft" },
    },
  });

  assert.match(projection.payload.bodyTemplate, /<!-- wp:acme\/card/);
  assert.match(projection.payload.bodyTemplate, /"variant":"hero"/);
  assert.match(projection.payload.bodyTemplate, /<section>Custom card<\/section>/);
  assert.match(projection.payload.bodyTemplate, /<!-- \/wp:acme\/card -->/);
});


test("mismatched Gutenberg delimiters fail closed to the original raw document", () => {
  const source = "<!-- wp:paragraph --><p>Broken structure</p><!-- /wp:heading -->";
  assert.deepEqual(importWordPressContentBlocks(source), [{
    id: "wordpress-gutenberg-malformed",
    kind: "embed",
    data: { html: source },
  }]);
});
