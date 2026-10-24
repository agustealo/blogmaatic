import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { EnvironmentSecretProvider, SecretAuthority } from "@blogmaatic/secrets";
import { WordPressContentService, WordPressRestPublisher } from "../dist/index.js";

function makeServer() {
  const posts = new Map();
  const pages = new Map();
  const books = new Map();
  const tags = new Map();
  const categories = new Map();
  const genres = new Map();
  const media = new Map();
  const users = new Map([
    [1, { id: 1, name: "Editor", slug: "editor", link: "http://example.test/author/editor", avatar_urls: { "96": "http://example.test/avatar/editor.png" } }],
  ]);
  const mediaUploads = [];
  const termCreateRaces = new Set();
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
    author: post.author,
    parent: post.parent,
    template: post.template,
    menu_order: post.menu_order,
    password: post.password,
    comment_status: post.comment_status,
    ping_status: post.ping_status,
    sticky: post.sticky,
    format: post.format,
    meta: post.meta,
    date_gmt: post.date_gmt,
  });
  const toPost = (id, body) => {
    modification += 1;
    return {
      id,
      author: body.author ?? 1,
      link: `http://example.test/?p=${id}`,
      slug: body.slug ?? "",
      status: body.status ?? "draft",
      title: { raw: body.title ?? "" },
      excerpt: { raw: body.excerpt ?? "" },
      content: { raw: body.content ?? "" },
      categories: body.categories ?? [],
      tags: body.tags ?? [],
      featured_media: body.featured_media ?? 0,
      parent: body.parent ?? 0,
      template: body.template ?? "",
      menu_order: body.menu_order ?? 0,
      password: body.password ?? "",
      comment_status: body.comment_status ?? "open",
      ping_status: body.ping_status ?? "open",
      sticky: body.sticky ?? false,
      format: body.format ?? "standard",
      meta: body.meta ?? {},
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
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBuffer = Buffer.concat(chunks);
    const raw = rawBuffer.toString("utf8");
    let body = {};
    if (raw && (request.headers["content-type"] ?? "").includes("application/json")) {
      body = JSON.parse(raw);
    }

    if (request.method === "GET" && path === "/types") {
      return json(response, 200, {
        post: { slug: "post", name: "Posts", description: "Blog posts", hierarchical: false, viewable: true, rest_base: "posts", rest_namespace: "wp/v2", taxonomies: ["category", "post_tag"], supports: { title: true, editor: true, comments: true, "post-formats": true } },
        page: { slug: "page", name: "Pages", description: "Static pages", hierarchical: true, viewable: true, rest_base: "pages", rest_namespace: "wp/v2", taxonomies: [], supports: { title: true, editor: true, comments: true, "page-attributes": true } },
        book: { slug: "book", name: "Books", description: "Custom book entries", hierarchical: false, viewable: true, rest_base: "books", rest_namespace: "wp/v2", taxonomies: ["category"], supports: { title: true, editor: true } },
        attachment: { slug: "attachment", name: "Media", viewable: false, rest_base: "media", rest_namespace: "wp/v2", taxonomies: [] },
      });
    }
    if (request.method === "GET" && path === "/taxonomies") {
      return json(response, 200, {
        category: {
          slug: "category",
          name: "Categories",
          hierarchical: true,
          types: ["post", "book"],
          rest_base: "categories",
          rest_namespace: "wp/v2",
          visibility: { show_ui: true, show_in_rest: true },
        },
        post_tag: {
          slug: "post_tag",
          name: "Tags",
          hierarchical: false,
          types: ["post"],
          rest_base: "tags",
          rest_namespace: "wp/v2",
          visibility: { show_ui: true, show_in_rest: true },
        },
        genre: {
          slug: "genre",
          name: "Genres",
          description: "Book genres",
          hierarchical: true,
          types: ["book"],
          rest_base: "genres",
          rest_namespace: "wp/v2",
          visibility: { show_ui: true, show_in_rest: true },
        },
      });
    }
    if (request.method === "OPTIONS" && path === "/books") {
      return json(response, 200, {
        schema: {
          properties: {
            meta: {
              type: "object",
              properties: {
                isbn: { type: "string", title: "ISBN", description: "Book ISBN" },
                rating: { type: "number", default: 0 },
                edition: { type: ["integer", "null"], title: "Edition" },
                featured: { type: "boolean" },
                audience: { type: "string", enum: ["public", "members"] },
                keywords: { type: "array", items: { type: "string" } },
                details: { type: "object", properties: { imprint: { type: "string" } } },
                api_token: { type: "string" },
                internal_score: { type: "integer", readOnly: true },
              },
            },
          },
        },
      });
    }

    if (request.method === "GET" && path === "/users/me") return json(response, 200, users.get(1));
    if (request.method === "GET" && path === "/users") {
      const search = url.searchParams.get("search")?.toLowerCase();
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const filtered = [...users.values()]
        .filter((user) => !search || [user.name, user.slug].some((value) => value.toLowerCase().includes(search)))
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = (page - 1) * perPage;
      return json(response, 200, filtered.slice(start, start + perPage));
    }
    const userMatch = path.match(/^\/users\/(\d+)$/);
    if (userMatch && request.method === "GET") {
      const user = users.get(Number(userMatch[1]));
      return user ? json(response, 200, user) : json(response, 404, { code: "not_found", message: "Not found", data: { status: 404 } });
    }
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
    const revisionItemMatch = path.match(/^\/posts\/(\d+)\/revisions\/(\d+)$/);
    if (revisionItemMatch && request.method === "GET") {
      const id = Number(revisionItemMatch[1]);
      const revisionId = Number(revisionItemMatch[2]);
      const current = posts.get(id);
      if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
      return json(response, 200, {
        id: revisionId,
        parent: id,
        author: current.author,
        date_gmt: current.date_gmt,
        modified_gmt: current.modified_gmt,
        title: { raw: `Revision ${revisionId}` },
        excerpt: { raw: "<p>Revision excerpt</p>" },
        content: { raw: `<h2>Revision ${revisionId}</h2><p>Recovered body.</p>` },
      });
    }
    const revisionMatch = path.match(/^\/posts\/(\d+)\/revisions$/);
    if (revisionMatch && request.method === "GET") {
      const id = Number(revisionMatch[1]);
      const current = posts.get(id);
      if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
      return json(response, 200, [{
        id: 9000 + id,
        parent: id,
        author: current.author,
        date_gmt: current.date_gmt,
        modified_gmt: current.modified_gmt,
        title: current.title,
        excerpt: current.excerpt,
        content: current.content,
      }]);
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
      if (request.method === "DELETE" && url.searchParams.get("force") === "true") {
        posts.delete(id);
        return json(response, 200, { deleted: true, previous: current });
      }
    }

    for (const [name, collection] of [["pages", pages], ["books", books]]) {
      if (request.method === "GET" && path === "/" + name) {
        const slug = url.searchParams.get("slug");
        return json(response, 200, [...collection.values()].filter((item) => !slug || item.slug === slug));
      }
      if (request.method === "POST" && path === "/" + name) {
        const id = nextPost++;
        const item = toPost(id, body);
        collection.set(id, item);
        return json(response, 201, item);
      }
      const revisionItem = path.match(new RegExp("^/" + name + "/(\\d+)/revisions/(\\d+)$"));
      if (revisionItem && request.method === "GET") {
        const id = Number(revisionItem[1]);
        const revisionId = Number(revisionItem[2]);
        const current = collection.get(id);
        if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
        return json(response, 200, {
          id: revisionId, parent: id, author: current.author, date_gmt: current.date_gmt, modified_gmt: current.modified_gmt,
          title: current.title, excerpt: current.excerpt, content: current.content,
        });
      }
      const revisionList = path.match(new RegExp("^/" + name + "/(\\d+)/revisions$"));
      if (revisionList && request.method === "GET") {
        const id = Number(revisionList[1]);
        const current = collection.get(id);
        if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
        return json(response, 200, [{
          id: 9000 + id, parent: id, author: current.author, date_gmt: current.date_gmt, modified_gmt: current.modified_gmt,
          title: current.title, excerpt: current.excerpt, content: current.content,
        }]);
      }
      const itemMatch = path.match(new RegExp("^/" + name + "/(\\d+)$"));
      if (itemMatch) {
        const id = Number(itemMatch[1]);
        const current = collection.get(id);
        if (!current) return json(response, 404, { code: "rest_post_invalid_id", message: "Not found", data: { status: 404 } });
        if (request.method === "GET") return json(response, 200, current);
        if (request.method === "POST") {
          const item = toPost(id, { ...flatten(current), ...body });
          collection.set(id, item);
          return json(response, 200, item);
        }
        if (request.method === "DELETE" && url.searchParams.get("force") === "true") {
          collection.delete(id);
          return json(response, 200, { deleted: true, previous: current });
        }
      }
    }

    for (const [name, collection] of [["tags", tags], ["categories", categories]]) {
      if (request.method === "GET" && path === `/${name}`) {
        const slug = url.searchParams.get("slug");
        const search = url.searchParams.get("search")?.toLowerCase();
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "100");
        const filtered = [...collection.values()]
          .filter((term) => {
            if (slug && term.slug !== slug) return false;
            if (!search) return true;
            return [term.name, term.slug, term.description ?? ""]
              .some((value) => value.toLowerCase().includes(search));
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        const start = (page - 1) * perPage;
        return json(response, 200, filtered.slice(start, start + perPage));
      }
      if (request.method === "POST" && path === `/${name}`) {
        const existing = [...collection.values()].find((term) => term.slug === body.slug);
        if (existing) return json(response, 400, { code: "term_exists", message: "Exists", data: { status: 400, term_id: existing.id } });
        if (termCreateRaces.delete(`${name}:${body.slug}`)) {
          const raced = {
            id: nextTerm++,
            name: body.name,
            slug: body.slug,
            ...(body.description ? { description: body.description } : {}),
            count: 0,
          };
          collection.set(raced.id, raced);
          return json(response, 400, { code: "term_exists", message: "Exists", data: { status: 400, term_id: raced.id } });
        }
        const term = {
          id: nextTerm++,
          name: body.name,
          slug: body.slug,
          ...(body.description ? { description: body.description } : {}),
          count: 0,
        };
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
      const search = url.searchParams.get("search")?.toLowerCase();
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const filtered = [...media.values()].filter((item) => {
        if (slug && item.slug !== slug) return false;
        if (!search) return true;
        return [
          item.slug,
          item.alt_text ?? "",
          item.title?.raw ?? item.title?.rendered ?? "",
        ].some((value) => value.toLowerCase().includes(search));
      });
      const start = (page - 1) * perPage;
      return json(response, 200, filtered.slice(start, start + perPage));
    }
    if (request.method === "POST" && path === "/media") {
      mediaUploads.push({
        contentType: request.headers["content-type"],
        contentDisposition: request.headers["content-disposition"],
        byteLength: rawBuffer.length,
      });
      const id = nextMedia++;
      const contentType = request.headers["content-type"] ?? "application/octet-stream";
      const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
      const item = {
        id,
        slug: `media-${id}`,
        source_url: `http://127.0.0.1:${server.address().port}/uploads/${id}.${extension}`,
        media_type: contentType.startsWith("image/") ? "image" : "file",
        mime_type: contentType,
        alt_text: "",
        title: { raw: "" },
      };
      media.set(id, item);
      return json(response, 201, item);
    }
    const mediaMatch = path.match(/^\/media\/(\d+)$/);
    if (mediaMatch && request.method === "GET") {
      const item = media.get(Number(mediaMatch[1]));
      return item ? json(response, 200, item) : json(response, 404, { code: "not_found", message: "Not found", data: { status: 404 } });
    }
    if (mediaMatch && request.method === "POST") {
      const id = Number(mediaMatch[1]);
      const current = media.get(id);
      const item = {
        ...current,
        ...body,
        ...(typeof body.title === "string" ? { title: { raw: body.title } } : {}),
      };
      media.set(id, item);
      return json(response, 200, item);
    }
    if (mediaMatch && request.method === "DELETE" && url.searchParams.get("force") === "true") {
      const id = Number(mediaMatch[1]);
      const current = media.get(id);
      media.delete(id);
      return json(response, 200, { deleted: true, previous: current });
    }
    return json(response, 404, { code: "not_found", message: path, data: { status: 404 } });
  });
  return {
    server,
    posts,
    pages,
    books,
    tags,
    categories,
    genres,
    media,
    users,
    mediaUploads,
    termCreateRaces,
    get counts() {
      return { postCreates, postUpdates };
    },
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function validPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = 40;
      row[offset + 1] = 120;
      row[offset + 2] = 210;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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

function textPublication() {
  const base = publication("/unused");
  return {
    ...base,
    current: {
      ...base.current,
      content: {
        ...base.current.content,
        blocks: [{ id: "p1", kind: "paragraph", data: { text: "Publish by content type." } }],
        assets: [],
      },
    },
  };
}

function route(extra = {}) {
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
    variant: { ...extra },
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
    assert.equal(delivered.evidence.wordpressRevisionId, 9010);
    assert.match(delivered.evidence.wordpressRevisionModifiedGmt, /^2026-09-22T18:00:/);
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


test("source content service browses, adopts, reads revisions, trashes, restores, and permanently deletes managed posts", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-05T01:00:00.000Z",
      updatedAt: "2026-10-05T01:00:00.000Z",
    };
    const connections = new ConnectionAuthority([connection]);
    const secrets = new SecretAuthority([
      new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" }),
    ]);
    const publisher = new WordPressRestPublisher(connections, secrets);
    const content = new WordPressContentService(connections, secrets);

    api.posts.set(55, {
      id: 55,
      author: 1,
      link: "http://example.test/?p=55",
      slug: "existing-post",
      status: "publish",
      title: { raw: "Existing Post" },
      excerpt: { raw: "Existing summary" },
      content: { raw: "<p>Existing body</p>" },
      categories: [],
      tags: [],
      featured_media: 0,
      date_gmt: "2026-10-04T12:00:00",
      modified_gmt: "2026-10-04T12:30:00",
    });

    const page = await content.list("wp-1", { perPage: 30 });
    assert.equal(page.items.some((item) => item.id === 55), true);
    assert.equal((await content.get("wp-1", "55")).ownership.managed, false);
    assert.equal((await content.revisions("wp-1", "55"))[0].parent, 55);

    const importedPublication = {
      id: "publication-imported",
      createdAt: "2026-10-05T01:00:00.000Z",
      slug: "existing-post",
      status: "draft",
      current: {
        id: "revision-imported",
        ordinal: 1,
        createdAt: "2026-10-05T01:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Existing Post",
          summary: "Existing summary",
          language: "en",
          blocks: [{ id: "source", kind: "embed", data: { html: "<p>Existing body</p>" } }],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      canonicalUrl: "http://example.test/?p=55",
      provenance: { source: "wordpress" },
    };
    const projection = await publisher.compile({ publication: importedPublication, route: route() });
    const adopted = await content.adopt("wp-1", "55", projection);
    assert.equal(adopted.ownership.managed, true);
    assert.equal(adopted.ownership.publicationId, "publication-imported");

    const trashed = await content.trash("wp-1", "55");
    assert.equal(trashed.status, "trash");
    const restored = await content.restore("wp-1", "55");
    assert.equal(restored.status, "draft");
    await assert.rejects(
      content.deletePermanent("wp-1", "55"),
      /must be moved to trash/,
    );
    await content.trash("wp-1", "55");
    const deleted = await content.deletePermanent("wp-1", "55");
    assert.equal(deleted.id, 55);
    assert.equal(api.posts.has(55), false);

    api.posts.set(56, {
      id: 56,
      author: 1,
      link: "http://example.test/?p=56",
      slug: "unmanaged",
      status: "trash",
      title: { raw: "Unmanaged" },
      excerpt: { raw: "" },
      content: { raw: "<p>Do not delete me</p>" },
      categories: [],
      tags: [],
      featured_media: 0,
      date_gmt: null,
      modified_gmt: "2026-10-04T12:31:00",
    });
    await assert.rejects(
      content.deletePermanent("wp-1", "56"),
      /not owned by Blogmaatic/,
    );
    assert.equal(api.posts.has(56), true);
  } finally {
    api.server.close();
  }
});


test("source content service searches and paginates WordPress categories and tags", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    api.categories.set(41, {
      id: 41,
      name: "Publishing",
      slug: "publishing",
      description: "Publishing workflows",
      count: 8,
    });
    api.categories.set(42, {
      id: 42,
      name: "Product",
      slug: "product",
      description: "Product writing",
      count: 3,
    });
    api.tags.set(51, {
      id: 51,
      name: "Automation",
      slug: "automation",
      description: "Automation topics",
      count: 11,
    });

    const categories = await content.listTerms("wp-1", "category", {
      search: "pub",
      page: 1,
      perPage: 1,
    });
    assert.deepEqual(categories, {
      items: [{
        id: 41,
        name: "Publishing",
        slug: "publishing",
        description: "Publishing workflows",
        count: 8,
      }],
      page: 1,
      perPage: 1,
      hasMore: true,
    });

    const tags = await content.listTerms("wp-1", "tag", {
      search: "auto",
      page: 1,
      perPage: 10,
    });
    assert.deepEqual(tags.items, [{
      id: 51,
      name: "Automation",
      slug: "automation",
      description: "Automation topics",
      count: 11,
    }]);
    assert.equal(tags.hasMore, false);
  } finally {
    api.server.close();
  }
});

test("source content service verifies image bytes before WordPress upload and preserves media metadata", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const bytes = validPng(16, 9);
    const uploaded = await content.uploadMedia("wp-1", {
      bytes,
      mediaType: "image/png",
      filename: "Editorial Hero.jpeg",
      alt: "A descriptive hero",
      title: "Editorial Hero",
    });
    assert.equal(api.mediaUploads.length, 1);
    assert.equal(api.mediaUploads[0].contentType, "image/png");
    assert.match(api.mediaUploads[0].contentDisposition, /Editorial Hero\.png"/);
    assert.equal(uploaded.mediaType, "image/png");
    assert.equal(uploaded.mediaKind, "image");
    assert.equal(uploaded.alt, "A descriptive hero");
    assert.equal(uploaded.title, "Editorial Hero");

    await assert.rejects(
      content.uploadMedia("wp-1", {
        bytes,
        mediaType: "image/jpeg",
        filename: "spoofed.jpg",
      }),
      /does not match detected bytes image\/png/,
    );
    assert.equal(api.mediaUploads.length, 1);

    await content.deleteMediaPermanent("wp-1", String(uploaded.id));
    assert.equal(api.media.has(uploaded.id), false);
  } finally {
    api.server.close();
  }
});

test("source content service fetches one WordPress native revision in edit context", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    api.posts.set(55, {
      id: 55,
      author: 7,
      link: "http://example.test/?p=55",
      slug: "revision-source",
      status: "publish",
      title: { raw: "Current title" },
      excerpt: { raw: "<p>Current excerpt</p>" },
      content: { raw: "<p>Current body</p>" },
      categories: [],
      tags: [],
      featured_media: 0,
      date_gmt: "2026-10-17T19:00:00",
      modified_gmt: "2026-10-17T20:00:00",
    });
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );

    const revision = await content.getRevision("wp-1", "55", "9055");
    assert.deepEqual(revision, {
      id: 9055,
      parent: 55,
      author: 7,
      dateGmt: "2026-10-17T19:00:00",
      modifiedGmt: "2026-10-17T20:00:00",
      title: "Revision 9055",
      excerpt: "<p>Revision excerpt</p>",
      contentHtml: "<h2>Revision 9055</h2><p>Recovered body.</p>",
    });
  } finally {
    api.server.close();
  }
});

test("source content service deliberately creates taxonomy and recovers existing slug idempotently", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );

    const created = await content.createTerm("wp-1", "category", {
      name: "Deep Publishing",
      description: "Editorial automation",
    });
    assert.equal(created.name, "Deep Publishing");
    assert.equal(created.slug, "deep-publishing");
    assert.equal(created.description, "Editorial automation");

    const same = await content.createTerm("wp-1", "category", {
      name: "Different display request",
      slug: "deep-publishing",
    });
    assert.equal(same.id, created.id);
    assert.equal(api.categories.size, 1);

    api.termCreateRaces.add("tags:race-tag");
    const raced = await content.createTerm("wp-1", "tag", {
      name: "Race Tag",
      slug: "race-tag",
      description: "Created concurrently",
    });
    assert.equal(raced.slug, "race-tag");
    assert.equal(raced.description, "Created concurrently");
    assert.equal(api.tags.size, 1);

    api.tags.clear();
    api.tags.set(88, {
      id: 88,
      name: "Existing Tag",
      slug: "existing-tag",
      description: "",
      count: 2,
    });
    const recovered = await content.createTerm("wp-1", "tag", {
      name: "Existing Tag",
      slug: "existing-tag",
    });
    assert.equal(recovered.id, 88);
    assert.equal(api.tags.size, 1);
  } finally {
    api.server.close();
  }
});

test("source content service searches WordPress authors without exposing email", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    api.users.set(7, {
      id: 7,
      name: "Editor Seven",
      slug: "editor-seven",
      link: "http://example.test/author/editor-seven",
      email: "private@example.test",
      avatar_urls: { "96": "http://example.test/avatar/7.png" },
    });
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );

    const page = await content.listAuthors("wp-1", { search: "seven", page: 1, perPage: 10 });
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0], {
      id: 7,
      name: "Editor Seven",
      slug: "editor-seven",
      link: "http://example.test/author/editor-seven",
      avatarUrl: "http://example.test/avatar/7.png",
    });
    assert.equal("email" in page.items[0], false);
    assert.deepEqual(await content.getAuthor("wp-1", "7"), page.items[0]);
  } finally {
    api.server.close();
  }
});

test("WordPress compiles, delivers, and detects drift for canonical source author", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    api.users.set(7, { id: 7, name: "Editor Seven", slug: "editor-seven" });
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const item = {
      id: "publication-author",
      createdAt: "2026-10-18T10:00:00.000Z",
      slug: "author-proof",
      status: "approved",
      current: {
        id: "revision-author",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Author Proof",
          language: "en",
          blocks: [{ id: "p1", kind: "paragraph", data: { text: "By the right person." } }],
          assets: [],
          tags: [],
          attributes: {
            sourceAuthor: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              remoteId: "7",
              displayName: "Editor Seven",
            },
          },
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-1",
        remoteId: "55",
      },
    };

    const projection = await publisher.compile({ publication: item, route: route() });
    assert.equal(projection.payload.authorId, 7);
    const delivered = await publisher.deliver({ idempotencyKey: "author-proof", projection });
    const saved = api.posts.get(Number(delivered.remote.id));
    assert.equal(saved.author, 7);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

    saved.author = 1;
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
  } finally {
    api.server.close();
  }
});

test("WordPress ignores canonical source author owned by another connection", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const baseConnection = {
      extensionId: "blogmaatic.wordpress-rest",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const connections = new ConnectionAuthority([
      { ...baseConnection, id: "wp-1", displayName: "WordPress One" },
      { ...baseConnection, id: "wp-2", displayName: "WordPress Two" },
    ]);
    const publisher = new WordPressRestPublisher(
      connections,
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const item = {
      id: "publication-author-isolation",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "approved",
      current: {
        id: "revision-author-isolation",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Author Isolation",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            sourceAuthor: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              remoteId: "7",
              displayName: "Editor Seven",
            },
          },
        },
      },
      provenance: { source: "wordpress" },
    };
    const wp2Route = {
      ...route(),
      destination: { ...route().destination, connectionId: "wp-2" },
    };
    const projection = await publisher.compile({ publication: item, route: wp2Route });
    assert.equal(projection.payload.authorId, undefined);
  } finally {
    api.server.close();
  }
});

test("source content service searches and maps WordPress Media Library images", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const content = new WordPressContentService(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    api.media.set(77, {
      id: 77,
      slug: "editorial-hero",
      source_url: "http://example.test/uploads/editorial-hero.jpg",
      mime_type: "image/jpeg",
      alt_text: "Editorial hero",
      title: { raw: "Editorial Hero" },
      modified_gmt: "2026-10-18T12:00:00",
      media_details: { width: 1600, height: 900 },
    });

    const page = await content.listMedia("wp-1", { search: "editorial", page: 1, perPage: 10 });
    assert.equal(page.page, 1);
    assert.equal(page.perPage, 10);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.items[0], {
      id: 77,
      sourceUrl: "http://example.test/uploads/editorial-hero.jpg",
      slug: "editorial-hero",
      mediaType: "image/jpeg",
      alt: "Editorial hero",
      title: "Editorial Hero",
      width: 1600,
      height: 900,
      modifiedGmt: "2026-10-18T12:00:00",
    });
    assert.deepEqual(await content.getMedia("wp-1", "77"), page.items[0]);

    api.media.set(88, {
      id: 88,
      slug: "release-notes",
      source_url: "http://example.test/uploads/release-notes.pdf",
      media_type: "file",
      mime_type: "application/pdf",
      alt_text: "",
      title: { raw: "Release notes" },
    });
    await assert.rejects(
      content.getMedia("wp-1", "88"),
      /is not an image/,
    );
  } finally {
    api.server.close();
  }
});

test("WordPress reuses attached Media Library ids without re-uploading remote images", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    api.media.set(77, {
      id: 77,
      slug: "library-hero",
      source_url: `http://127.0.0.1:${port}/uploads/library-hero.jpg`,
      mime_type: "image/jpeg",
      alt_text: "Library hero",
      title: { raw: "Library Hero" },
      media_details: { width: 1600, height: 900 },
    });
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const item = {
      id: "publication-media-library",
      createdAt: "2026-10-18T10:00:00.000Z",
      slug: "media-library-reuse",
      status: "approved",
      current: {
        id: "revision-media-library",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Media Library Reuse",
          language: "en",
          blocks: [{ id: "image", kind: "image", data: { assetId: "wordpress-media-77" } }],
          assets: [{
            id: "wordpress-media-77",
            kind: "image",
            source: api.media.get(77).source_url,
            mediaType: "image/jpeg",
            alt: "Library hero",
            attributes: {
              featured: true,
              wordpressMediaId: 77,
              sourceExtensionId: "blogmaatic.wordpress-rest",
              sourceConnectionId: "wp-1",
              sourceRemoteId: "77",
            },
          }],
          tags: [],
          attributes: {},
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-1",
        remoteId: "55",
      },
    };

    const projection = await publisher.compile({ publication: item, route: route() });
    assert.equal(projection.payload.assets[0].wordpressMediaId, 77);
    const delivered = await publisher.deliver({ idempotencyKey: "reuse-media-77", projection });

    assert.equal(api.mediaUploads.length, 0);
    assert.deepEqual(delivered.evidence.mediaIds, [77]);
    const saved = api.posts.get(Number(delivered.remote.id));
    assert.equal(saved.featured_media, 77);
    assert.match(saved.content.raw, /library-hero\.jpg/);
  } finally {
    api.server.close();
  }
});

test("WordPress uploads rendered route-specific image derivatives with traceable evidence", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-wp-transform-"));
  const image = join(root, "hero.png");
  await writeFile(image, validPng(16, 9));
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
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const projection = await publisher.compile({
      publication: publication(image),
      route: route({
        imageTransform: {
          width: 12,
          height: 6,
          fit: "cover",
          format: "jpeg",
          quality: 82,
          maxBytes: 200000,
        },
      }),
    });
    const planned = projection.payload.assets[0].transform;
    assert.equal(planned.output.width, 12);
    assert.equal(planned.output.height, 6);
    assert.equal(planned.output.mediaType, "image/jpeg");

    const delivered = await publisher.deliver({ idempotencyKey: "wp-transform", projection });
    assert.equal(api.mediaUploads.length, 1);
    assert.equal(api.mediaUploads[0].contentType, "image/jpeg");
    assert.match(api.mediaUploads[0].contentDisposition, /\.jpg"/);
    assert.ok(api.mediaUploads[0].byteLength > 0);
    assert.equal(delivered.evidence.mediaTransforms.length, 1);
    assert.equal(delivered.evidence.mediaTransforms[0].transformationFingerprint, planned.transformationFingerprint);
    assert.equal(delivered.evidence.mediaTransforms[0].mediaType, "image/jpeg");
    assert.equal(delivered.evidence.mediaTransforms[0].width, 12);
    assert.equal(delivered.evidence.mediaTransforms[0].height, 6);
    assert.match(delivered.evidence.mediaTransforms[0].outputFingerprint, /^[0-9a-f]{64}$/);
  } finally {
    api.server.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("WordPress source publishing state overrides route defaults only on matching connection", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const baseConnection = {
      extensionId: "blogmaatic.wordpress-rest",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([
        { ...baseConnection, id: "wp-1", displayName: "WordPress One" },
        { ...baseConnection, id: "wp-2", displayName: "WordPress Two" },
      ]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const item = {
      id: "publication-source-state",
      createdAt: "2026-10-18T10:00:00.000Z",
      slug: "source-state-proof",
      status: "approved",
      current: {
        id: "revision-source-state",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Source state proof",
          language: "en",
          blocks: [{ id: "p1", kind: "paragraph", data: { text: "Scheduled natively." } }],
          assets: [],
          tags: [],
          attributes: {
            sourcePublishing: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              status: "future",
              scheduledAt: "2026-11-01T18:30:00.000Z",
            },
          },
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-1",
        remoteId: "55",
      },
    };
    const routeDefaultDraft = route({ status: "draft" });
    const projection = await publisher.compile({ publication: item, route: routeDefaultDraft });
    assert.equal(projection.payload.status, "future");
    assert.equal(projection.payload.scheduledAt, "2026-11-01T18:30:00.000Z");

    const delivered = await publisher.deliver({ idempotencyKey: "source-state-proof", projection });
    const saved = api.posts.get(Number(delivered.remote.id));
    assert.equal(saved.status, "future");
    assert.equal(saved.date_gmt, "2026-11-01T18:30:00");
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

    saved.date_gmt = "2026-11-02T18:30:00";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");

    const wp2Route = {
      ...routeDefaultDraft,
      destination: { ...routeDefaultDraft.destination, connectionId: "wp-2" },
    };
    const otherProjection = await publisher.compile({ publication: item, route: wp2Route });
    assert.equal(otherProjection.payload.status, "draft");
    assert.equal(otherProjection.payload.scheduledAt, undefined);
  } finally {
    api.server.close();
  }
});

test("WordPress canonical source publishing state rejects invalid schedule combinations", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
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
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const base = {
      id: "publication-invalid-source-state",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "approved",
      current: {
        id: "revision-invalid-source-state",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Invalid source state",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: { source: "wordpress" },
    };

    await assert.rejects(
      publisher.compile({
        publication: {
          ...base,
          current: {
            ...base.current,
            content: {
              ...base.current.content,
              attributes: {
                sourcePublishing: {
                  extensionId: "blogmaatic.wordpress-rest",
                  connectionId: "wp-1",
                  status: "future",
                },
              },
            },
          },
        },
        route: route({ status: "draft" }),
      }),
      /requires scheduledAt/,
    );

    await assert.rejects(
      publisher.compile({
        publication: {
          ...base,
          current: {
            ...base.current,
            content: {
              ...base.current.content,
              attributes: {
                sourcePublishing: {
                  extensionId: "blogmaatic.wordpress-rest",
                  connectionId: "wp-1",
                  status: "draft",
                  scheduledAt: "2026-11-01T18:30:00.000Z",
                },
              },
            },
          },
        },
        route: route(),
      }),
      /only allowed when status is future/,
    );
  } finally {
    api.server.close();
  }
});

test("WordPress content types are discovered and source browsing is scoped by REST base", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    api.pages.set(71, { id: 71, author: 1, link: "http://example.test/?page_id=71", slug: "about", status: "publish", title: { raw: "About" }, excerpt: { raw: "" }, content: { raw: "<p>About this site.</p>" }, categories: [], tags: [], featured_media: 0, date_gmt: "2026-10-19T13:00:00", modified_gmt: "2026-10-19T13:30:00" });
    api.books.set(81, { id: 81, author: 1, link: "http://example.test/?book=81", slug: "systems-thinking", status: "draft", title: { raw: "Systems Thinking" }, excerpt: { raw: "Book excerpt" }, content: { raw: "<p>Book body.</p>" }, categories: [], tags: [], featured_media: 0, date_gmt: null, modified_gmt: "2026-10-19T14:00:00" });
    const connection = { id: "wp-1", extensionId: "blogmaatic.wordpress-rest", displayName: "Local WordPress", status: "active", settings: { siteUrl: "http://127.0.0.1:" + port, username: "editor" }, secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" }, createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z" };
    const content = new WordPressContentService(new ConnectionAuthority([connection]), new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]));
    const types = await content.listContentTypes("wp-1");
    assert.deepEqual(types.map((type) => [type.name, type.restBase]), [["Books", "books"], ["Pages", "pages"], ["Posts", "posts"]]);
    assert.equal(types.some((type) => type.restBase === "media"), false);
    assert.deepEqual((await content.list("wp-1", { contentType: "pages", perPage: 30 })).items.map((item) => item.id), [71]);
    assert.equal((await content.get("wp-1", "71", "pages")).title, "About");
    assert.deepEqual((await content.list("wp-1", { contentType: "books", perPage: 30 })).items.map((item) => item.id), [81]);
    assert.equal((await content.revisions("wp-1", "81", "books"))[0].parent, 81);
  } finally { api.server.close(); }
});

test("WordPress route channel selects content type while status remains independent", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const connection = { id: "wp-1", extensionId: "blogmaatic.wordpress-rest", displayName: "Local WordPress", status: "active", settings: { siteUrl: "http://127.0.0.1:" + port, username: "editor" }, secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" }, createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z" };
    const publisher = new WordPressRestPublisher(new ConnectionAuthority([connection]), new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]));
    const pageRoute = { ...route(), destination: { ...route().destination, channel: "pages" } };
    const projection = await publisher.compile({ publication: textPublication(), route: pageRoute });
    assert.equal(projection.payload.contentType, "pages");
    assert.equal(projection.payload.status, "publish");
    const delivered = await publisher.deliver({ idempotencyKey: "page-route", projection });
    assert.equal(api.pages.has(Number(delivered.remote.id)), true);
    assert.equal(api.posts.has(Number(delivered.remote.id)), false);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");
  } finally { api.server.close(); }
});

test("legacy custom post type setting remains the fallback for old posts-channel routes", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const connection = { id: "wp-1", extensionId: "blogmaatic.wordpress-rest", displayName: "Legacy Books", status: "active", settings: { siteUrl: "http://127.0.0.1:" + port, username: "editor", postTypeRestBase: "books" }, secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" }, createdAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z" };
    const publisher = new WordPressRestPublisher(new ConnectionAuthority([connection]), new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]));
    const projection = await publisher.compile({ publication: textPublication(), route: route() });
    assert.equal(projection.payload.contentType, "books");
    assert.equal(projection.payload.status, "publish");
    const delivered = await publisher.deliver({ idempotencyKey: "legacy-books", projection });
    assert.equal(api.books.has(Number(delivered.remote.id)), true);
  } finally { api.server.close(); }
});


test("WordPress Page structure compiles, delivers, clears, and detects remote drift", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const connection = {
      id: "wp-1",
      extensionId: "blogmaatic.wordpress-rest",
      displayName: "Local WordPress",
      status: "active",
      settings: { siteUrl: "http://127.0.0.1:" + port, username: "editor" },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-21T18:00:00.000Z",
      updatedAt: "2026-10-21T18:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([connection]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const base = textPublication();
    const publication = {
      ...base,
      current: {
        ...base.current,
        content: {
          ...base.current.content,
          attributes: {
            ...base.current.content.attributes,
            sourcePage: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              contentType: "pages",
              parentRemoteId: "77",
              template: "templates/landing.php",
              menuOrder: 6,
            },
          },
        },
      },
    };
    const pageRoute = { ...route(), destination: { ...route().destination, channel: "pages" } };
    const projection = await publisher.compile({ publication, route: pageRoute });
    assert.equal(projection.payload.parentId, 77);
    assert.equal(projection.payload.template, "templates/landing.php");
    assert.equal(projection.payload.menuOrder, 6);

    const delivered = await publisher.deliver({ idempotencyKey: "page-structure", projection });
    const post = api.pages.get(Number(delivered.remote.id));
    assert.equal(post.parent, 77);
    assert.equal(post.template, "templates/landing.php");
    assert.equal(post.menu_order, 6);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

    post.parent = 0;
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
    post.parent = 77;
    post.template = "other.php";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
    post.template = "templates/landing.php";
    post.menu_order = 9;
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");

    const clearedPublication = {
      ...publication,
      current: {
        ...publication.current,
        id: "rev-cleared",
        ordinal: publication.current.ordinal + 1,
        content: {
          ...publication.current.content,
          attributes: {
            ...publication.current.content.attributes,
            sourcePage: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              contentType: "pages",
              parentRemoteId: null,
              template: null,
              menuOrder: 0,
            },
          },
        },
      },
    };
    const clearedProjection = await publisher.compile({ publication: clearedPublication, route: pageRoute });
    await publisher.deliver({
      idempotencyKey: "page-structure-clear",
      projection: clearedProjection,
      existingRemote: delivered.remote,
    });
    const cleared = api.pages.get(Number(delivered.remote.id));
    assert.equal(cleared.parent, 0);
    assert.equal(cleared.template, "");
    assert.equal(cleared.menu_order, 0);
  } finally {
    api.server.close();
  }
});


test("WordPress Page structure applies only to the matching source connection and content type", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const baseConnection = {
      extensionId: "blogmaatic.wordpress-rest",
      status: "active",
      settings: {
        siteUrl: `http://127.0.0.1:${port}`,
        username: "editor",
      },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-21T18:00:00.000Z",
      updatedAt: "2026-10-21T18:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([
        { ...baseConnection, id: "wp-1", displayName: "WordPress One" },
        { ...baseConnection, id: "wp-2", displayName: "WordPress Two" },
      ]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const publication = {
      id: "publication-page-isolation",
      createdAt: "2026-10-21T18:00:00.000Z",
      status: "approved",
      current: {
        id: "revision-page-isolation",
        ordinal: 1,
        createdAt: "2026-10-21T18:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Page isolation",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            sourcePage: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              contentType: "pages",
              parentRemoteId: "77",
              template: "templates/landing.php",
              menuOrder: 8,
            },
          },
        },
      },
      provenance: { source: "wordpress" },
    };

    const matching = {
      ...route(),
      destination: { ...route().destination, connectionId: "wp-1", channel: "pages" },
    };
    const matchingProjection = await publisher.compile({ publication, route: matching });
    assert.equal(matchingProjection.payload.parentId, 77);
    assert.equal(matchingProjection.payload.template, "templates/landing.php");
    assert.equal(matchingProjection.payload.menuOrder, 8);

    const otherConnection = {
      ...matching,
      destination: { ...matching.destination, connectionId: "wp-2" },
    };
    const otherConnectionProjection = await publisher.compile({ publication, route: otherConnection });
    assert.equal(otherConnectionProjection.payload.parentId, undefined);
    assert.equal(otherConnectionProjection.payload.template, undefined);
    assert.equal(otherConnectionProjection.payload.menuOrder, undefined);

    const otherType = {
      ...matching,
      destination: { ...matching.destination, channel: "posts" },
    };
    const otherTypeProjection = await publisher.compile({ publication, route: otherType });
    assert.equal(otherTypeProjection.payload.parentId, undefined);
    assert.equal(otherTypeProjection.payload.template, undefined);
    assert.equal(otherTypeProjection.payload.menuOrder, undefined);
  } finally {
    api.server.close();
  }
});


test("WordPress native editorial options deliver drift and remain source-isolated", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const baseConnection = {
      extensionId: "blogmaatic.wordpress-rest",
      status: "active",
      settings: { siteUrl: `http://127.0.0.1:${port}`, username: "editor" },
      secretRefs: { applicationPassword: "env:WP_APP_PASSWORD" },
      createdAt: "2026-10-23T15:00:00.000Z",
      updatedAt: "2026-10-23T15:00:00.000Z",
    };
    const publisher = new WordPressRestPublisher(
      new ConnectionAuthority([
        { ...baseConnection, id: "wp-1", displayName: "WordPress One" },
        { ...baseConnection, id: "wp-2", displayName: "WordPress Two" },
      ]),
      new SecretAuthority([new EnvironmentSecretProvider({ WP_APP_PASSWORD: "app password" })]),
    );
    const publication = {
      id: "publication-editorial",
      createdAt: "2026-10-23T15:00:00.000Z",
      status: "approved",
      current: {
        id: "revision-editorial",
        ordinal: 1,
        createdAt: "2026-10-23T15:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Editorial options",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            sourceEditorial: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              contentType: "posts",
              password: "",
              commentStatus: "closed",
              pingStatus: "open",
              sticky: true,
              format: "quote",
            },
          },
        },
      },
      provenance: { source: "wordpress" },
    };

    const projection = await publisher.compile({ publication, route: route() });
    assert.equal(projection.payload.password, "");
    assert.equal(projection.payload.commentStatus, "closed");
    assert.equal(projection.payload.pingStatus, "open");
    assert.equal(projection.payload.sticky, true);
    assert.equal(projection.payload.format, "quote");

    const delivered = await publisher.deliver({ idempotencyKey: "editorial-options", projection });
    const saved = api.posts.get(Number(delivered.remote.id));
    assert.equal(saved.password, "");
    assert.equal(saved.comment_status, "closed");
    assert.equal(saved.ping_status, "open");
    assert.equal(saved.sticky, true);
    assert.equal(saved.format, "quote");
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

    saved.comment_status = "open";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");

    const otherRoute = { ...route(), destination: { ...route().destination, connectionId: "wp-2" } };
    const other = await publisher.compile({ publication, route: otherRoute });
    assert.equal(other.payload.password, undefined);
    assert.equal(other.payload.sticky, undefined);
    assert.equal(other.payload.format, undefined);

    const invalid = {
      ...publication,
      current: {
        ...publication.current,
        id: "revision-editorial-invalid",
        content: {
          ...publication.current.content,
          attributes: {
            sourceEditorial: {
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-1",
              contentType: "posts",
              password: "locked",
              sticky: true,
            },
          },
        },
      },
    };
    await assert.rejects(
      publisher.compile({ publication: invalid, route: route() }),
      /cannot be password protected/,
    );
  } finally {
    api.server.close();
  }
});
