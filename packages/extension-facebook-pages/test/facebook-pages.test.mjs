import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { EnvironmentSecretProvider, SecretAuthority } from "@blogmaatic/secrets";
import { FacebookPagesPublisher } from "../dist/index.js";

function makeServer() {
  const posts = new Map();
  const photos = new Map();
  const requests = [];
  let nextPhoto = 10;
  let nextPost = 20;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization });
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== "Bearer page token") {
      return json(401, { error: { message: "Bad token", code: 190 } });
    }
    if (!url.pathname.startsWith("/v26.0/")) return json(404, { error: { message: "wrong version", code: 100 } });
    const path = url.pathname.slice("/v26.0/".length);
    if (request.method === "GET" && path === "123") return json(200, { id: "123", name: "Blogmaatic Page" });
    if (request.method === "GET" && path === "123/feed") return json(200, { data: [] });

    let raw = "";
    for await (const chunk of request) raw += chunk;
    const params = new URLSearchParams(raw);

    if (request.method === "POST" && path === "123/photos") {
      const id = String(nextPhoto++);
      photos.set(id, { id, url: params.get("url") });
      return json(200, { id });
    }
    if (request.method === "POST" && path === "123/feed") {
      const id = `123_${nextPost++}`;
      const mediaIds = [...params.entries()]
        .filter(([key]) => key.startsWith("attached_media["))
        .map(([, value]) => JSON.parse(value).media_fbid);
      const post = {
        id,
        message: params.get("message") ?? "",
        permalink_url: `https://facebook.test/${id}`,
        link: params.get("link") ?? undefined,
        is_published: params.get("published") !== "false",
        scheduled_publish_time: params.get("scheduled_publish_time") ? Number(params.get("scheduled_publish_time")) : undefined,
        attachments: {
          data: mediaIds.length > 0
            ? [{ media_type: "album", subattachments: { data: mediaIds.map((mediaId) => ({ target: { id: mediaId } })) } }]
            : [],
        },
      };
      posts.set(id, post);
      return json(200, { id });
    }
    if (request.method === "GET" && posts.has(path)) return json(200, posts.get(path));
    return json(404, { error: { message: "Not found", code: 100 } });
  });
  return { server, posts, requests };
}

function publication(source = "https://cdn.example.test/hero.png") {
  return {
    id: "pub-facebook",
    createdAt: "2026-09-22T18:00:00.000Z",
    canonicalUrl: "https://example.test/article",
    status: "approved",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T18:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Publish Once",
        summary: "Maintain everywhere",
        language: "en",
        blocks: [
          { id: "p1", kind: "paragraph", data: { text: "One publication, many projections." } },
          { id: "i1", kind: "image", data: { assetId: "hero" } },
        ],
        assets: [{ id: "hero", kind: "image", source, mediaType: "image/png", alt: "Hero" }],
        tags: ["publishing"],
        attributes: {},
      },
    },
    provenance: {},
  };
}

function route(extra = {}) {
  return {
    id: "facebook-route",
    enabled: true,
    desiredState: "present",
    destination: { extensionId: "blogmaatic.facebook-pages", connectionId: "fb-1", channel: "feed" },
    requiredCapabilities: ["article.create", "article.inspect", "asset.publish"],
    variant: { mode: "image", includeHashtags: true, ...extra },
  };
}

function publisher(port, assetSourceRoots = []) {
  const connection = {
    id: "fb-1",
    extensionId: "blogmaatic.facebook-pages",
    displayName: "Facebook Page",
    status: "active",
    settings: {
      pageId: "123",
      apiRoot: `http://127.0.0.1:${port}`,
      apiVersion: "v26.0",
      assetSourceRoots,
    },
    secretRefs: { pageAccessToken: "env:FB_PAGE_TOKEN" },
    createdAt: "2026-09-22T18:00:00.000Z",
    updatedAt: "2026-09-22T18:00:00.000Z",
  };
  return new FacebookPagesPublisher(
    new ConnectionAuthority([connection]),
    new SecretAuthority([new EnvironmentSecretProvider({ FB_PAGE_TOKEN: "page token" })]),
  );
}

test("Graph v26 Page contract: auth, image upload, create, verification and immutable drift", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const extension = publisher(port);
    const connection = {
      id: "fb-1", extensionId: "blogmaatic.facebook-pages", displayName: "Facebook Page", status: "active",
      settings: { pageId: "123", apiRoot: `http://127.0.0.1:${port}`, apiVersion: "v26.0", assetSourceRoots: [] },
      secretRefs: { pageAccessToken: "env:FB_PAGE_TOKEN" }, createdAt: "x", updatedAt: "x",
    };
    assert.equal((await extension.checkHealth(connection)).state, "healthy");
    const projection = await extension.compile({ publication: publication(), route: route() });
    assert.equal((await extension.inspect({ projection })).state, "missing");
    const delivered = await extension.deliver({ idempotencyKey: "key", projection });
    const synchronized = await extension.inspect({ projection, remote: delivered.remote });
    assert.equal(synchronized.state, "synchronized");
    assert.equal(delivered.evidence.imageCount, 1);
    assert.ok(delivered.remote.version.startsWith("bm1:"));
    assert.ok(api.requests.every((request) => request.authorization === "Bearer page token"));
    assert.ok(api.requests.every((request) => request.path.startsWith("/v26.0/")));

    api.posts.get(delivered.remote.id).message = "Edited directly on Facebook";
    const drifted = await extension.inspect({ projection, remote: delivered.remote });
    assert.equal(drifted.state, "drifted");
    assert.equal(extension.planDriftReconciliation().action, "blocked");
    await assert.rejects(
      extension.deliver({ idempotencyKey: "key-2", projection, existingRemote: delivered.remote }),
      /refuses automatic replacement/,
    );
  } finally {
    api.server.close();
  }
});

test("scheduled feed creation uses Meta scheduling fields", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  try {
    const port = api.server.address().port;
    const extension = publisher(port);
    const scheduledAt = "2026-09-23T18:00:00.000Z";
    const projection = await extension.compile({ publication: publication(), route: route({ scheduledAt }) });
    const delivered = await extension.deliver({ idempotencyKey: "scheduled", projection });
    const post = api.posts.get(delivered.remote.id);
    assert.equal(post.is_published, false);
    assert.equal(post.scheduled_publish_time, Math.floor(new Date(scheduledAt).getTime() / 1000));
  } finally {
    api.server.close();
  }
});

test("local image sources are confined to configured roots", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const allowed = await mkdtemp(join(tmpdir(), "blogmaatic-fb-allowed-"));
  const outside = await mkdtemp(join(tmpdir(), "blogmaatic-fb-outside-"));
  const image = join(outside, "hero.png");
  await writeFile(image, Buffer.from([1, 2, 3]));
  try {
    const extension = publisher(api.server.address().port, [allowed]);
    await assert.rejects(
      extension.compile({ publication: publication(image), route: route() }),
      /outside the configured assetSourceRoots/,
    );
  } finally {
    api.server.close();
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
