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

function localPng(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  Buffer.from("IHDR").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
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


test("local image projection records deterministic destination media plan and refuses unrendered transforms", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const allowed = await mkdtemp(join(tmpdir(), "blogmaatic-fb-media-"));
  const image = join(allowed, "hero.png");
  await writeFile(image, localPng(1600, 900));
  try {
    const extension = publisher(api.server.address().port, [allowed]);
    const transformRoute = route({
      imageTransform: {
        width: 1200,
        height: 630,
        fit: "cover",
        format: "jpeg",
        quality: 82,
        maxBytes: 5000000,
        focalX: 0.4,
        focalY: 0.6,
      },
    });
    const first = await extension.compile({ publication: publication(image), route: transformRoute });
    const second = await extension.compile({ publication: publication(image), route: transformRoute });

    assert.equal(first.fingerprint, second.fingerprint);
    const asset = first.payload.images[0];
    assert.equal(asset.mediaType, "image/png");
    assert.equal(asset.transform.source.width, 1600);
    assert.equal(asset.transform.source.height, 900);
    assert.equal(asset.transform.output.width, 1200);
    assert.equal(asset.transform.output.height, 630);
    assert.equal(asset.transform.output.mediaType, "image/jpeg");
    assert.equal(asset.transform.spec.fit, "cover");
    assert.equal(asset.transform.renderRequired, true);
    assert.match(asset.transform.transformationFingerprint, /^[0-9a-f]{64}$/);

    await assert.rejects(
      extension.deliver({ idempotencyKey: "media-transform", projection: first }),
      /requires a media renderer/,
    );
    assert.equal(api.posts.size, 0);
  } finally {
    api.server.close();
    await rm(allowed, { recursive: true, force: true });
  }
});

test("local image byte type must match declared media type", async () => {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const allowed = await mkdtemp(join(tmpdir(), "blogmaatic-fb-media-type-"));
  const image = join(allowed, "hero.png");
  await writeFile(image, localPng(1200, 630));
  try {
    const extension = publisher(api.server.address().port, [allowed]);
    const mismatch = publication(image);
    mismatch.current.content.assets[0].mediaType = "image/jpeg";
    await assert.rejects(
      extension.compile({ publication: mismatch, route: route() }),
      /does not match detected bytes/,
    );
  } finally {
    api.server.close();
    await rm(allowed, { recursive: true, force: true });
  }
});
