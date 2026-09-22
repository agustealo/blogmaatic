import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { EnvironmentSecretProvider, SecretAuthority } from "@blogmaatic/secrets";
import { WordPressRestPublisher } from "../dist/index.js";

function makeServer() {
  const posts = new Map();
  const tags = new Map();
  const categories = new Map();
  const media = new Map();
  let nextPost = 10;
  let nextTerm = 20;
  let nextMedia = 30;
  let postCreates = 0;
  let postUpdates = 0;
  let modification = 0;
  const authorization = `Basic ${Buffer.from("editor:app password").toString("base64")}`;
  const json = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const flatten = (post) => ({
    title: post.title.raw,
    excerpt: post.excerpt.raw,
    content: post.content.raw,
    slug: post.slug,
    status: post.status,
    categories: post.categories,
    tags: post.tags,
    featured_media: post.featured_media,
    date_gmt: post.date_gmt,
  });
  const toPost = (id, body) => {
    modification += 1;
    return {
      id,
      link: `http://example.test/?p=${id}`,
      slug: body.slug ?? "",
      status: body.status ?? "draft",
      title: { raw: body.title ?? "" },
      excerpt: { raw: body.excerpt ?? "" },
      content: { raw: body.content ?? "" },
      categories: body.categories ?? [],
      tags: body.tags ?? [],
      featured_media: body.featured_media ?? 0,
      date_gmt: body.date_gmt ?? null,
      modified_gmt: `2026-09-22T18:00:${String(modification).padStart(2, "0")}`,
    };
  };
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== authorization) {
      return json(response, 401, {
        code: "rest_not_logged_in",
        message: "Unauthorized",
        data: { status: 401 },
      });
    }
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace("/wp-json/wp/v2", "");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body = {};
    if (raw && (request.headers["content-type"] ?? "").includes("application/json")) {
      body = JSON.parse(raw);
    }

    if (request.method === "GET" && path === "/users/me") return json(response, 200, { id: 1, name: "Editor" });
    if (request.method === "GET" && path === "/posts") {
      const slug = url.searchParams.get("slug");
      return json(response, 200, [...posts.values()].filter((post) => !slug || post.slug === slug));
    }
    if (request.method === "POST" && path === "/posts") {
      postCreates += 1;
      const id = nextPost++;
      const post = toPost(id, body);
      posts.set(id, post);
      return json(response, 201, post);
    }
    const postMatch = path.match(/^\/posts\/(\d+)$/);
    if (postMatch) {
      const id = Number(postMatch[1]);
      const current = posts.get(id);
      if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
      if (request.method === "GET") return json(response, 200, current);
      if (request.method === "POST") {
        postUpdates += 1;
        const post = toPost(id, { ...flatten(current), ...body });
        posts.set(id, post);
        return json(response, 200, post);
      }
    }

    for (const [name, collection] of [["tags", tags], ["categories", categories]]) {
      if (request.method === "GET" && path === `/${name}`) {
        const slug = url.searchParams.get("slug");
        return json(response, 200, [...collection.values()].filter((term) => !slug || term.slug === slug));
      }
      if (request.method === "POST" && path === `/${name}`) {
        const existing = [...collection.values()].find((term) => term.slug === body.slug);
        if (existing) return json(response, 400, { code: "term_exists", message: "Exists", data: { status: 400, term_id: existing.id } });
        const term = { id: nextTerm++, name: body.name, slug: body.slug };
        collection.set(term.id, term);
        return json(response, 201, term);
      }
      const termMatch = path.match(new RegExp(`^/${name}/(\\d+)$`));
      if (termMatch && request.method === "GET") {
        const term = collection.get(Number(termMatch[1]));
        return term ? json(response, 200, term) : json(response, 404, { code: "not_found", message: "Not found", data: { status: 404 } });
      }
    }

    if (request.method === "GET" && path === "/media") {
      const slug = url.searchParams.get("slug");
      return json(response, 200, [...media.values()].filter((item) => !slug || item.slug === slug));
    }
    if (request.method === "POST" && path === "/media") {
      const id = nextMedia++;
      const item = {
        id,
        slug: `media-${id}`,
        source_url: `http://127.0.0.1:${server.address().port}/uploads/${id}.png`,
      };
      media.set(id, item);
      return json(response, 201, item);
    }
    const mediaMatch = path.match(/^\/media\/(\d+)$/);
    if (mediaMatch && request.method === "POST") {
      const id = Number(mediaMatch[1]);
      const item = { ...media.get(id), ...body };
      media.set(id, item);
      return json(response, 200, item);
    }
    return json(response, 404, { code: "not_found", message: path, data: { status: 404 } });
  });
  return {
    server,
    posts,
    get counts() {
      return { postCreates, postUpdates };
    },
  };
}

function publication(assetPath) {
  return {
    id: "pub-1",
    createdAt: "2026-09-22T17:00:00.000Z",
    slug: "maintain-everywhere",
    status: "approved",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T17:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Maintain Everywhere",
        summary: "Summary",
        language: "en",
        blocks: [
          { id: "p1", kind: "paragraph", data: { text: "Publish once." } },
          { id: "i1", kind: "image", data: { assetId: "hero" } },
        ],
        assets: [
          {
            id: "hero",
            kind: "image",
            source: assetPath,
            mediaType: "image/png",
            alt: "Hero",
            attributes: { featured: true },
          },
        ],
        tags: ["technology"],
        attributes: { categories: ["Publishing"] },
      },
    },
    provenance: { author: "owner" },
  };
}

function route() {
  return {
    id: "route-1",
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.wordpress-rest",
      connectionId: "wp-1",
      channel: "posts",
    },
    requiredCapabilities: [
      "article.create",
      "article.update",
      "article.inspect",
      "asset.publish",
      "taxonomy.publish",
    ],
    variant: {},
  };
}

test("real HTTP WordPress contract: auth, media, taxonomy, create, drift repair, verification", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-wp-"));
  const image = join(root, "hero.png");
  await writeFile(image, Buffer.from([1, 2, 3, 4]));
  try {
    const port = api.server.address().port;
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
        assetSourceRoots: [root],
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-09-22T17:00:00.000Z",
      updatedAt: "2026-09-22T17:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([
        new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" }),
      ]),
    );
    assert.equal((await publisher.checkHealth(connection)).state, "healthy");
    const projection = await publisher.compile({ publication: publication(image), route: route() });
    assert.equal((await publisher.inspect({ projection })).state, "missing");
    const delivered = await publisher.deliver({ idempotencyKey: "key-1", projection });
    assert.equal(api.counts.postCreates, 1);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");
    const post = api.posts.get(Number(delivered.remote.id));
    assert.match(post.content.raw, /blogmaatic:/);
    assert.ok(post.featured_media > 0);
    post.title.raw = "Human changed title";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
    await publisher.deliver({
      idempotencyKey: "key-1",
      projection,
      existingRemote: delivered.remote,
    });
    assert.equal(api.counts.postCreates, 1);
    assert.ok(api.counts.postUpdates >= 1);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");
  } finally {
    api.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("health failure redacts a missing Application Password locator", async () => {
  const connection = {
    id: "wp-1",
    extensionId: "blogmaatic.wordpress-rest",
    displayName: "WordPress",
    status: "active",
    settings: { siteUrl: "http://127.0.0.1:65530", username: "editor" },
    secretRefs: { applicationPassword: "env:DO_NOT_LEAK_THIS_NAME" },
    createdAt: "2026-09-22T17:00:00.000Z",
    updatedAt: "2026-09-22T17:00:00.000Z",
  };
  const publisher = new WordPressRestPublisher(
    new ConnectionAuthority([connection]),
    new SecretAuthority([new EnvironmentSecretProvider({})]),
  );
  const health = await publisher.checkHealth(connection);
  assert.equal(health.state, "unhealthy");
  assert.match(health.detail, /env:\[redacted\]/);
  assert.doesNotMatch(health.detail, /DO_NOT_LEAK_THIS_NAME/);
});

test("compile rejects local assets outside configured source roots", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "blogmaatic-allowed-"));
  const outside = await mkdtemp(join(tmpdir(), "blogmaatic-outside-"));
  const image = join(outside, "hero.png");
  await writeFile(image, Buffer.from([9, 8, 7]));
  try {
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "WordPress",
      status: "active",
      settings: {
        siteUrl: "http://127.0.0.1:65530",
        username: "editor",
        assetSourceRoots: [allowed],
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-09-22T17:00:00.000Z",
      updatedAt: "2026-09-22T17:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([
        new EnvironmentSecretProvider({ WP_APP_PASSWORD: "secret" }),
      ]),
    );
    await assert.rejects(
      publisher.compile({ publication: publication(image), route: route() }),
      /outside configured asset roots/,
    );
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
