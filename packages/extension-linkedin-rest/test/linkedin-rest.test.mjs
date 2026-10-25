import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { EnvironmentSecretProvider, SecretAuthority } from "@blogmaatic/secrets";
import { LinkedInRestPublisher } from "../dist/index.js";

function makeServer() {
  const posts = new Map();
  const images = new Map();
  const uploads = [];
  let nextId = 100;
  let nextImageId = 500;
  let creates = 0;
  let updates = 0;
  let imageInitializes = 0;
  let imageUploads = 0;
  let imageReads = 0;
  let lastModifiedAt = 1790100000000;
  const requiredAuthor = "urn:li:organization:2414183";

  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer linked-in-token") {
      return json(response, 401, { message: "Unauthorized", status: 401 });
    }

    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname.replace(/^\/rest/, "");
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBuffer = Buffer.concat(chunks);

    const uploadMatch = path.match(/^\/upload\/(image-\d+)$/);
    if (uploadMatch && request.method === "PUT") {
      imageUploads += 1;
      const key = uploadMatch[1];
      const image = images.get(key);
      if (!image) return json(response, 404, { message: "Unknown upload", status: 404 });
      uploads.push({
        key,
        bytes: rawBuffer,
        mediaType: request.headers["content-type"],
      });
      images.set(key, { ...image, status: "AVAILABLE" });
      response.writeHead(201);
      return response.end();
    }

    if (request.headers["linkedin-version"] !== "202609") {
      return json(response, 400, { message: "Wrong LinkedIn version", status: 400 });
    }
    if (request.headers["x-restli-protocol-version"] !== "2.0.0") {
      return json(response, 400, { message: "Wrong Rest.li protocol", status: 400 });
    }

    const raw = rawBuffer.toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;

    if (request.method === "POST" && path === "/images" && url.searchParams.get("action") === "initializeUpload") {
      imageInitializes += 1;
      const key = `image-${nextImageId++}`;
      const imageUrn = `urn:li:image:${key.replace(/-/g, "")}`;
      images.set(key, {
        id: imageUrn,
        owner: body?.initializeUploadRequest?.owner,
        status: "WAITING_UPLOAD",
      });
      const port = server.address().port;
      return json(response, 200, {
        value: {
          uploadUrl: `http://127.0.0.1:${port}/upload/${key}`,
          uploadUrlExpiresAt: Date.now() + 60_000,
          image: imageUrn,
        },
      });
    }

    const encodedImage = path.match(/^\/images\/(.+)$/)?.[1];
    if (encodedImage && request.method === "GET") {
      imageReads += 1;
      const urn = decodeURIComponent(encodedImage);
      const image = [...images.values()].find((candidate) => candidate.id === urn);
      return image
        ? json(response, 200, image)
        : json(response, 404, { message: "Image not found", status: 404 });
    }

    if (request.method === "GET" && path === "/posts" && url.searchParams.get("q") === "author") {
      return json(response, 200, { elements: [...posts.values()].slice(0, 1) });
    }

    if (request.method === "POST" && path === "/posts") {
      creates += 1;
      const id = `urn:li:share:${nextId++}`;
      const record = {
        ...body,
        id,
        author: body.author,
        commentary: body.commentary,
        visibility: body.visibility,
        lifecycleState: body.lifecycleState,
        distribution: body.distribution,
        content: body.content,
        lastModifiedAt: ++lastModifiedAt,
      };
      posts.set(id, record);
      return json(response, 201, {}, { "x-restli-id": id });
    }

    const encoded = path.match(/^\/posts\/(.+)$/)?.[1];
    if (encoded) {
      const id = decodeURIComponent(encoded);
      const current = posts.get(id);
      if (!current) return json(response, 404, { message: "Not found", status: 404 });
      if (request.method === "GET") return json(response, 200, current);
      if (request.method === "POST") {
        if (request.headers["x-restli-method"] !== "PARTIAL_UPDATE") {
          return json(response, 400, { message: "Missing PARTIAL_UPDATE", status: 400 });
        }
        updates += 1;
        const commentary = body?.patch?.$set?.commentary;
        const next = {
          ...current,
          ...(typeof commentary === "string" ? { commentary } : {}),
          lastModifiedAt: ++lastModifiedAt,
        };
        posts.set(id, next);
        response.writeHead(204);
        return response.end();
      }
    }

    return json(response, 404, { message: `${request.method} ${path}`, status: 404 });
  });

  return {
    server,
    posts,
    images,
    uploads,
    requiredAuthor,
    get counts() {
      return { creates, updates, imageInitializes, imageUploads, imageReads };
    },
  };
}

function publication() {
  return {
    id: "pub-linkedin",
    createdAt: "2026-09-22T18:00:00.000Z",
    slug: "publication-control-plane",
    status: "approved",
    canonicalUrl: "https://example.com/publication-control-plane",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T18:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Publication Control Plane",
        summary: "Own once. Maintain everywhere.",
        language: "en",
        blocks: [
          { id: "h1", kind: "heading", data: { text: "Why this matters", level: 2 } },
          { id: "p1", kind: "paragraph", data: { text: "A publication can have many destination projections." } },
          { id: "img1", kind: "image", data: { assetId: "hero" } },
        ],
        assets: [{ id: "hero", kind: "image", source: "https://example.com/hero.png", alt: "Architecture" }],
        tags: ["publishing", "automation"],
        attributes: {},
      },
    },
    provenance: {},
  };
}

function connection(port, assetRoot) {
  return {
    id: "linkedin-company",
    extensionId: "blogmaatic.linkedin-rest",
    displayName: "Company LinkedIn",
    status: "active",
    settings: {
      apiRoot: `http://127.0.0.1:${port}/rest`,
      apiVersion: "202609",
      authorUrn: "urn:li:organization:2414183",
      ...(assetRoot ? { assetSourceRoots: [assetRoot] } : {}),
    },
    secretRefs: { accessToken: "env:LINKEDIN_TOKEN" },
    createdAt: "2026-09-22T18:00:00.000Z",
    updatedAt: "2026-09-22T18:00:00.000Z",
  };
}

function route(mode = "text") {
  return {
    id: `linkedin-${mode}`,
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: "blogmaatic.linkedin-rest",
      connectionId: "linkedin-company",
      channel: "posts",
    },
    requiredCapabilities: ["article.create", "article.update", "article.inspect"],
    variant: {
      mode,
      includeHashtags: true,
      includeCanonicalUrl: mode === "text",
    },
  };
}

async function fixture(assetRoot) {
  const api = makeServer();
  await new Promise((resolve) => api.server.listen(0, "127.0.0.1", resolve));
  const port = api.server.address().port;
  const record = connection(port, assetRoot);
  const publisher = new LinkedInRestPublisher(
    new ConnectionAuthority([record]),
    new SecretAuthority([
      new EnvironmentSecretProvider({ LINKEDIN_TOKEN: "linked-in-token" }),
    ]),
  );
  return { api, record, publisher };
}

test("LinkedIn text projection publishes, reports fidelity, detects drift, and updates in place", async () => {
  const { api, record, publisher } = await fixture();
  try {
    assert.equal((await publisher.checkHealth(record)).state, "healthy");
    const projection = await publisher.compile({ publication: publication(), route: route("text") });
    assert.equal((await publisher.inspect({ projection })).state, "missing");
    assert.match(JSON.stringify(projection.payload), /block.unsupported/);
    const delivered = await publisher.deliver({ idempotencyKey: "linkedin-key-1", projection });
    assert.equal(api.counts.creates, 1);
    assert.match(delivered.remote.id, /^urn:li:share:/);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

    const remote = api.posts.get(delivered.remote.id);
    remote.commentary = "Human changed commentary";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");

    const updated = await publisher.deliver({
      idempotencyKey: "linkedin-key-1",
      projection,
      existingRemote: delivered.remote,
    });
    assert.equal(updated.remote.id, delivered.remote.id);
    assert.equal(api.counts.creates, 1);
    assert.equal(api.counts.updates, 1);
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");
  } finally {
    api.server.close();
  }
});

test("LinkedIn article projection fails closed when article-card structure drifts", async () => {
  const { api, publisher } = await fixture();
  try {
    const projection = await publisher.compile({ publication: publication(), route: route("article") });
    const delivered = await publisher.deliver({ idempotencyKey: "linkedin-key-article", projection });
    const remote = api.posts.get(delivered.remote.id);
    remote.content.article.title = "Externally changed card title";
    assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
    await assert.rejects(
      publisher.deliver({
        idempotencyKey: "linkedin-key-article",
        projection,
        existingRemote: delivered.remote,
      }),
      /structural post content drift cannot be updated safely/,
    );
    assert.equal(api.counts.creates, 1);
    assert.equal(api.counts.updates, 0);
  } finally {
    api.server.close();
  }
});


test("LinkedIn route-scoped commentary override preserves canonical article structure", async () => {
  const { api, publisher } = await fixture();
  try {
    const item = publication();
    item.current.content.attributes = {
      destinationOverrides: {
        schemaVersion: 1,
        groups: {
          "group-social": {
            routes: {
              "linkedin-article": {
                extensionId: "blogmaatic.linkedin-rest",
                connectionId: "linkedin-company",
                channel: "posts",
                socialVariant: {
                  extensionId: "blogmaatic.linkedin-rest",
                  connectionId: "linkedin-company",
                  channel: "posts",
                  commentaryMode: "override",
                  commentary: "Exact LinkedIn commentary",
                  mediaMode: "none",
                  imageAssetIds: [],
                },
              },
            },
          },
        },
      },
    };
    const projection = await publisher.compile({
      publication: item,
      route: route("article"),
      groupId: "group-social",
    });
    assert.equal(projection.payload.commentary, "Exact LinkedIn commentary");
    assert.equal(projection.payload.article.source, item.canonicalUrl);
    assert.equal(projection.payload.article.title, item.current.content.title);
    const inherited = await publisher.compile({ publication: item, route: route("article") });
    assert.notEqual(inherited.payload.commentary, "Exact LinkedIn commentary");
    assert.notEqual(projection.fingerprint, inherited.fingerprint);
  } finally {
    api.server.close();
  }
});

test("LinkedIn selected social media override fails closed until media publishing exists", async () => {
  const { api, publisher } = await fixture();
  try {
    const item = publication();
    item.current.content.attributes = {
      destinationOverrides: {
        schemaVersion: 1,
        groups: {
          "group-social": {
            routes: {
              "linkedin-text": {
                extensionId: "blogmaatic.linkedin-rest",
                connectionId: "linkedin-company",
                channel: "posts",
                socialVariant: {
                  extensionId: "blogmaatic.linkedin-rest",
                  connectionId: "linkedin-company",
                  channel: "posts",
                  commentaryMode: "inherit",
                  mediaMode: "select",
                  imageAssetIds: ["hero"],
                },
              },
            },
          },
        },
      },
    };
    await assert.rejects(
      publisher.compile({ publication: item, route: route("text"), groupId: "group-social" }),
      /does not support selected social media assets/,
    );
  } finally {
    api.server.close();
  }
});

test("LinkedIn rejects tampered social destination identity", async () => {
  const { api, publisher } = await fixture();
  try {
    const item = publication();
    item.current.content.attributes = {
      destinationOverrides: {
        schemaVersion: 1,
        groups: {
          "group-social": {
            routes: {
              "linkedin-text": {
                extensionId: "blogmaatic.linkedin-rest",
                connectionId: "wrong-company",
                channel: "posts",
                socialVariant: {
                  extensionId: "blogmaatic.linkedin-rest",
                  connectionId: "linkedin-company",
                  channel: "posts",
                  commentaryMode: "inherit",
                  mediaMode: "inherit",
                  imageAssetIds: [],
                },
              },
            },
          },
        },
      },
    };
    await assert.rejects(
      publisher.compile({ publication: item, route: route("text"), groupId: "group-social" }),
      /identity does not match/,
    );
  } finally {
    api.server.close();
  }
});
