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
  let failUploadAt = 0;
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
      if (failUploadAt === imageUploads) {
        return json(response, 500, { message: "Synthetic upload failure", status: 500 });
      }
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
    failUploadAt(number) {
      failUploadAt = number;
    },
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

async function withLocalPng(fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-linkedin-image-"));
  const path = join(directory, "hero.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path, bytes);
  try {
    return await fn({ directory, path, bytes });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withLocalPngs(count, fn) {
  const directory = await mkdtemp(join(tmpdir(), "blogmaatic-linkedin-images-"));
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  );
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(directory, `image-${index + 1}.png`);
    await writeFile(path, bytes);
    paths.push(path);
  }
  try {
    return await fn({ directory, paths, bytes });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function localImagesPublication(paths) {
  const item = publication();
  item.current.content.blocks = [
    { id: "p1", kind: "paragraph", data: { text: "Multi-image publication." } },
    ...paths.map((path, index) => ({
      id: `img-${index + 1}`,
      kind: "image",
      data: { assetId: `hero-${index + 1}` },
    })),
  ];
  item.current.content.assets = paths.map((path, index) => ({
    id: `hero-${index + 1}`,
    kind: "image",
    source: path,
    mediaType: "image/png",
    alt: `Architecture ${index + 1}`,
  }));
  return item;
}

function localImagePublication(path) {
  const item = publication();
  item.current.content.assets = [{
    id: "hero",
    kind: "image",
    source: path,
    mediaType: "image/png",
    alt: "Architecture",
  }];
  return item;
}

function selectedImageOverride(item, routeId = "linkedin-text", imageAssetIds = ["hero"]) {
  item.current.content.attributes = {
    destinationOverrides: {
      schemaVersion: 1,
      groups: {
        "group-social": {
          routes: {
            [routeId]: {
              extensionId: "blogmaatic.linkedin-rest",
              connectionId: "linkedin-company",
              channel: "posts",
              socialVariant: {
                extensionId: "blogmaatic.linkedin-rest",
                connectionId: "linkedin-company",
                channel: "posts",
                commentaryMode: "inherit",
                mediaMode: "select",
                imageAssetIds,
              },
            },
          },
        },
      },
    },
  };
  return item;
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

test("LinkedIn selected image compiles, uploads exact bytes, publishes, and detects Image URN drift", async () => {
  await withLocalPng(async ({ directory, path, bytes }) => {
    const { api, publisher } = await fixture(directory);
    try {
      const item = selectedImageOverride(localImagePublication(path));
      const projection = await publisher.compile({
        publication: item,
        route: route("text"),
        groupId: "group-social",
      });
      assert.equal(projection.payload.mode, "image");
      assert.equal(projection.payload.image.assetId, "hero");
      assert.equal(projection.payload.image.transform.output.mediaType, "image/png");

      const delivered = await publisher.deliver({
        idempotencyKey: "linkedin-image-1",
        projection,
      });
      assert.equal(api.counts.imageInitializes, 1);
      assert.equal(api.counts.imageUploads, 1);
      assert.equal(api.counts.imageReads, 1);
      assert.equal(api.counts.creates, 1);
      assert.equal(api.uploads.length, 1);
      assert.deepEqual(api.uploads[0].bytes, bytes);
      assert.equal(api.uploads[0].mediaType, "image/png");
      assert.match(delivered.evidence.media.linkedInImageUrn, /^urn:li:image:/);
      assert.equal(delivered.evidence.media.assetId, "hero");
      assert.equal(delivered.evidence.media.mediaType, "image/png");
      assert.equal(delivered.evidence.media.width, 1);
      assert.equal(delivered.evidence.media.height, 1);
      assert.equal(typeof delivered.evidence.media.outputFingerprint, "string");
      assert.equal(typeof delivered.evidence.media.transformationFingerprint, "string");
      assert.equal(typeof delivered.evidence.media.derivedAssetId, "string");

      const remote = api.posts.get(delivered.remote.id);
      assert.equal(remote.content.media.id, delivered.evidence.media.linkedInImageUrn);
      assert.equal(remote.content.media.altText, "Architecture");
      assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "synchronized");

      remote.content.media.id = "urn:li:image:tampered";
      assert.equal((await publisher.inspect({ projection, remote: delivered.remote })).state, "drifted");
    } finally {
      api.server.close();
    }
  });
});

test("LinkedIn image commentary update reuses the existing Image URN without another upload", async () => {
  await withLocalPng(async ({ directory, path }) => {
    const { api, publisher } = await fixture(directory);
    try {
      const item = selectedImageOverride(localImagePublication(path));
      const firstProjection = await publisher.compile({
        publication: item,
        route: route("text"),
        groupId: "group-social",
      });
      const delivered = await publisher.deliver({
        idempotencyKey: "linkedin-image-update",
        projection: firstProjection,
      });
      const counts = { ...api.counts };

      item.current.content.attributes.destinationOverrides.groups["group-social"].routes["linkedin-text"].socialVariant = {
        ...item.current.content.attributes.destinationOverrides.groups["group-social"].routes["linkedin-text"].socialVariant,
        commentaryMode: "override",
        commentary: "Updated image commentary",
      };
      const nextProjection = await publisher.compile({
        publication: item,
        route: route("text"),
        groupId: "group-social",
      });
      const updated = await publisher.deliver({
        idempotencyKey: "linkedin-image-update",
        projection: nextProjection,
        existingRemote: delivered.remote,
      });

      assert.equal(updated.remote.id, delivered.remote.id);
      assert.equal(api.counts.imageInitializes, counts.imageInitializes);
      assert.equal(api.counts.imageUploads, counts.imageUploads);
      assert.equal(api.counts.imageReads, counts.imageReads);
      assert.equal(api.counts.creates, counts.creates);
      assert.equal(api.counts.updates, counts.updates + 1);
      assert.equal(api.posts.get(delivered.remote.id).commentary, "Updated image commentary");
      assert.equal((await publisher.inspect({ projection: nextProjection, remote: delivered.remote })).state, "synchronized");
    } finally {
      api.server.close();
    }
  });
});

test("LinkedIn refuses image replacement in place before any second upload", async () => {
  await withLocalPng(async ({ directory, path }) => {
    const { api, publisher } = await fixture(directory);
    try {
      const item = selectedImageOverride(localImagePublication(path));
      const projection = await publisher.compile({
        publication: item,
        route: route("text"),
        groupId: "group-social",
      });
      const delivered = await publisher.deliver({ idempotencyKey: "linkedin-image-change", projection });
      const uploadCount = api.counts.imageUploads;

      await writeFile(path, Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABH0r3nAAAADUlEQVR42mNk+M8AAAICAQB7CY5qAAAAAElFTkSuQmCC",
        "base64",
      ));
      const changed = await publisher.compile({
        publication: item,
        route: route("text"),
        groupId: "group-social",
      });
      await assert.rejects(
        publisher.deliver({
          idempotencyKey: "linkedin-image-change",
          projection: changed,
          existingRemote: delivered.remote,
        }),
        /structural post content drift cannot be updated safely/,
      );
      assert.equal(api.counts.imageUploads, uploadCount);
    } finally {
      api.server.close();
    }
  });
});

test("LinkedIn image mode inherits one canonical image and media none falls back to text", async () => {
  await withLocalPng(async ({ directory, path }) => {
    const { api, publisher } = await fixture(directory);
    try {
      const item = localImagePublication(path);
      const inherited = await publisher.compile({
        publication: item,
        route: route("image"),
      });
      assert.equal(inherited.payload.mode, "image");
      assert.equal(inherited.payload.image.assetId, "hero");

      item.current.content.attributes = {
        destinationOverrides: {
          schemaVersion: 1,
          groups: {
            "group-social": {
              routes: {
                "linkedin-image": {
                  extensionId: "blogmaatic.linkedin-rest",
                  connectionId: "linkedin-company",
                  channel: "posts",
                  socialVariant: {
                    extensionId: "blogmaatic.linkedin-rest",
                    connectionId: "linkedin-company",
                    channel: "posts",
                    commentaryMode: "inherit",
                    mediaMode: "none",
                    imageAssetIds: [],
                  },
                },
              },
            },
          },
        },
      };
      const noMedia = await publisher.compile({
        publication: item,
        route: route("image"),
        groupId: "group-social",
      });
      assert.equal(noMedia.payload.mode, "text");
      assert.equal(noMedia.payload.image, undefined);
    } finally {
      api.server.close();
    }
  });
});

test("LinkedIn selected media requires exactly one image and rejects arbitrary remote image URLs", async () => {
  const { api, publisher } = await fixture();
  try {
    const remote = selectedImageOverride(publication());
    await assert.rejects(
      publisher.compile({
        publication: remote,
        route: route("text"),
        groupId: "group-social",
      }),
      /remote image URLs are not supported/,
    );

    const multiple = publication();
    multiple.current.content.assets.push({
      id: "hero-2",
      kind: "image",
      source: "https://example.com/hero-2.png",
    });
    selectedImageOverride(multiple);
    multiple.current.content.attributes.destinationOverrides.groups["group-social"].routes["linkedin-text"].socialVariant.imageAssetIds = ["hero", "hero-2"];
    await assert.rejects(
      publisher.compile({
        publication: multiple,
        route: route("text"),
        groupId: "group-social",
      }),
      /requires exactly one image/,
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
