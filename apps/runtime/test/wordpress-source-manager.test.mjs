import assert from "node:assert/strict";
import test from "node:test";

import { WordPressSourceManager } from "../dist/wordpress-source-manager.js";

function snapshot(managed = false, publicationId, routeId, native = {}) {
  return {
    post: {
      id: 55,
      author: 7,
      title: "Existing WordPress article",
      excerpt: "<p>Imported summary</p>",
      contentHtml: "<h2>Imported heading</h2><p>Imported body.</p>",
      slug: "existing-wordpress-article",
      status: native.status ?? "publish",
      ...(native.password === undefined ? {} : { password: native.password }),
      ...(native.commentStatus === undefined ? {} : { commentStatus: native.commentStatus }),
      ...(native.pingStatus === undefined ? {} : { pingStatus: native.pingStatus }),
      ...(native.sticky === undefined ? {} : { sticky: native.sticky }),
      ...(native.format === undefined ? {} : { format: native.format }),
      link: "https://example.test/?p=55",
      dateGmt: native.dateGmt ?? "2026-10-04T12:00:00",
      modifiedGmt: "2026-10-04T12:30:00",
      categoryIds: [4],
      tagIds: [8],
      featuredMediaId: 12,
      ownership: {
        managed,
        ...(publicationId ? { publicationId } : {}),
        ...(routeId ? { routeId } : {}),
      },
    },
    categoryNames: ["Publishing"],
    tagNames: ["automation"],
    featuredMedia: {
      id: 12,
      slug: "hero",
      source_url: "https://example.test/uploads/hero.jpg",
    },
  };
}

test("WordPress import creates one canonical publication and recovers it on retry", async () => {
  const importedNative = {
    status: "future",
    dateGmt: "2026-11-01T18:30:00",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
    sticky: true,
    format: "quote",
  };
  let currentSnapshot = snapshot(false, undefined, undefined, importedNative);
  let stored;
  let adoptCount = 0;
  const projectionWrites = [];
  const historyWrites = [];
  let idIndex = 0;
  const ids = ["publication-id", "revision-id", "unused-id"];

  const content = {
    defaultContentType() { return "posts"; },
    async importSnapshot() {
      return currentSnapshot;
    },
    async adopt(_connectionId, _remoteId, projection) {
      adoptCount += 1;
      currentSnapshot = snapshot(true, projection.publicationId, projection.routeId, importedNative);
      return currentSnapshot.post;
    },
  };

  const publisher = {
    async compile({ publication, route }) {
      return {
        projectionId: `${publication.id}:${route.id}`,
        publicationId: publication.id,
        sourceRevisionId: publication.current.id,
        routeId: route.id,
        destination: route.destination,
        payload: {},
        fingerprint: `${publication.current.id}:${route.variant?.status ?? "publish"}:${route.variant?.slug ?? ""}`,
      };
    },
  };

  const group = {
    id: "group-main",
    name: "Main publishing",
    policySetId: "default",
    routes: [{
      id: "route-wordpress",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        channel: "posts",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
      variant: { status: "publish" },
    }],
  };

  const publicationGroups = {
    async get(id) {
      assert.equal(id, "group-main");
      return { group, version: 3, enabled: true, recordedAt: "2026-10-05T01:00:00.000Z" };
    },
  };

  const publications = {
    async findImportedSource(extensionId, connectionId, remoteId) {
      assert.equal(extensionId, "blogmaatic.wordpress-rest");
      assert.equal(connectionId, "wp-main");
      assert.equal(remoteId, "55");
      return stored;
    },
    async registerImported(publication) {
      assert.equal(stored, undefined);
      stored = {
        publication,
        version: 1,
        recordedAt: "2026-10-05T02:00:00.000Z",
        updatedAt: "2026-10-05T02:00:00.000Z",
      };
      return stored;
    },
  };

  const manager = new WordPressSourceManager({
    content,
    publisher,
    publicationGroups,
    publications,
    projectionState: {
      async put(record) {
        projectionWrites.push(record);
      },
    },
    distributionHistory: {
      async append(record) {
        if (!historyWrites.some((existing) => existing.id === record.id)) historyWrites.push(record);
      },
    },
    now: () => "2026-10-05T02:00:00.000Z",
    id: () => ids[idIndex++] ?? `id-${idIndex}`,
  });

  const first = await manager.import("wp-main", "55", {
    groupId: "group-main",
    routeId: "route-wordpress",
  });

  assert.equal(first.publication.publication.current.ordinal, 1);
  assert.equal(first.publication.publication.status, "draft");
  assert.equal(first.publication.publication.provenance.source, "wordpress");
  assert.equal(first.publication.publication.provenance.remoteId, "55");
  assert.equal(first.publication.publication.current.content.tags[0], "automation");
  assert.equal(first.publication.publication.current.content.attributes.categories[0], "Publishing");
  assert.equal(first.publication.publication.current.content.blocks[0].kind, "embed");
  assert.equal(first.publication.publication.current.content.assets[0].attributes.wordpressMediaId, 12);
  assert.deepEqual(first.publication.publication.current.content.attributes.sourceAuthor, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
  });
  assert.deepEqual(first.publication.publication.current.content.attributes.sourcePublishing, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  });
  assert.deepEqual(first.publication.publication.current.content.attributes.sourceEditorial, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "posts",
    password: "",
    commentStatus: "open",
    pingStatus: "closed",
    sticky: true,
    format: "quote",
  });
  assert.equal(first.remote.managed, true);
  assert.equal(adoptCount, 1);
  assert.equal(projectionWrites.length, 1);
  assert.equal(projectionWrites[0].remote.id, "55");
  assert.equal(historyWrites.length, 1);
  assert.equal(historyWrites[0].groupSnapshot.id, "group-main");
  assert.equal(historyWrites[0].receipt.evidence.action, "wordpress.import");

  const canonicalId = first.publication.publication.id;
  const canonicalRevision = first.publication.publication.current.id;

  const second = await manager.import("wp-main", "55", {
    groupId: "group-main",
    routeId: "route-wordpress",
  });

  assert.equal(second.publication.publication.id, canonicalId);
  assert.equal(second.publication.publication.current.id, canonicalRevision);
  assert.equal(adoptCount, 1);
  assert.equal(projectionWrites.length, 2);
  assert.equal(historyWrites.length, 1);
});


test("WordPress source assets browse safely and attach idempotently to matching source publication", async () => {
  const media = {
    id: 77,
    sourceUrl: "https://example.test/uploads/library-image.jpg",
    slug: "library-image",
    mediaType: "image/jpeg",
    title: "Library image",
    alt: "Editorial hero",
    width: 1600,
    height: 900,
    modifiedGmt: "2026-10-18T12:00:00",
  };
  let attachCalls = 0;
  let current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
  };

  const publications = {
    async get(id) {
      return id === "publication-wp" ? current : undefined;
    },
    async attachAsset(publicationId, expectedVersion, asset, featured) {
      attachCalls += 1;
      assert.equal(publicationId, "publication-wp");
      assert.equal(expectedVersion, current.version);
      assert.equal(asset.id, "wordpress-media-77");
      assert.equal(asset.source, media.sourceUrl);
      assert.equal(asset.mediaType, "image/jpeg");
      assert.equal(asset.alt, "Editorial hero");
      assert.equal(asset.attributes.wordpressMediaId, 77);
      assert.equal(asset.attributes.sourceConnectionId, "wp-main");
      assert.equal(asset.attributes.sourceRemoteId, "77");
      assert.equal(featured, true);
      current = {
        ...current,
        version: current.version + 1,
        publication: {
          ...current.publication,
          current: {
            ...current.publication.current,
            id: "revision-2",
            ordinal: 2,
            content: {
              ...current.publication.current.content,
              assets: [{ ...asset, attributes: { ...asset.attributes, featured: true } }],
            },
          },
        },
      };
      return current;
    },
  };

  const manager = new WordPressSourceManager({
    content: {
      async listMedia(connectionId, query) {
        assert.equal(connectionId, "wp-main");
        assert.deepEqual(query, { search: "hero", page: 2, perPage: 12 });
        return { items: [media], page: 2, perPage: 12, hasMore: true };
      },
      async getMedia(connectionId, remoteId) {
        assert.equal(connectionId, "wp-main");
        assert.equal(remoteId, "77");
        return media;
      },
    },
    publisher: {},
    publicationGroups: {},
    publications,
    projectionState: {},
    distributionHistory: {},
  });

  const page = await manager.listAssets("wp-main", { search: "hero", page: 2, limit: 12 });
  assert.equal(page.page, 2);
  assert.equal(page.limit, 12);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items[0], {
    connectionId: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    remoteId: "77",
    sourceUrl: media.sourceUrl,
    kind: "image",
    mediaType: "image/jpeg",
    title: "Library image",
    alt: "Editorial hero",
    width: 1600,
    height: 900,
    modifiedAt: "2026-10-18T12:00:00",
    metadata: { wordpressMediaId: 77, slug: "library-image" },
  });

  const attached = await manager.attachAsset("wp-main", "77", {
    publicationId: "publication-wp",
    expectedVersion: 4,
    featured: true,
  });
  assert.equal(attached.publication.version, 5);
  assert.equal(attached.publication.publication.current.content.assets[0].attributes.featured, true);
  assert.equal(attachCalls, 1);

  await assert.rejects(
    () => manager.attachAsset("wp-other", "77", {
      publicationId: "publication-wp",
      expectedVersion: 5,
    }),
    /does not match the publication source/,
  );
  assert.equal(attachCalls, 1);
});


test("WordPress taxonomy creation maps through the provider-neutral source boundary", async () => {
  let createInput;
  const manager = new WordPressSourceManager({
    content: {
      async createTerm(connectionId, kind, input) {
        assert.equal(connectionId, "wp-main");
        assert.equal(kind, "tag");
        createInput = input;
        return {
          id: 91,
          name: "Editorial AI",
          slug: "editorial-ai",
          description: "AI-assisted editorial work",
          count: 0,
        };
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {},
    projectionState: {},
    distributionHistory: {},
  });

  const created = await manager.createTaxonomy("wp-main", {
    kind: "tag",
    name: "Editorial AI",
    description: "AI-assisted editorial work",
  });
  assert.deepEqual(createInput, {
    name: "Editorial AI",
    description: "AI-assisted editorial work",
  });
  assert.deepEqual(created, {
    connectionId: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    kind: "tag",
    remoteId: "91",
    name: "Editorial AI",
    slug: "editorial-ai",
    description: "AI-assisted editorial work",
    count: 0,
    metadata: { wordpressTermId: 91 },
  });
});

test("WordPress taxonomy maps through the provider-neutral source boundary", async () => {
  const manager = new WordPressSourceManager({
    content: {
      async listTerms(connectionId, kind, query) {
        assert.equal(connectionId, "wp-main");
        assert.equal(kind, "category");
        assert.deepEqual(query, { search: "pub", page: 2, perPage: 12 });
        return {
          items: [{
            id: 41,
            name: "Publishing",
            slug: "publishing",
            description: "Publishing workflows",
            count: 8,
          }],
          page: 2,
          perPage: 12,
          hasMore: true,
        };
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {},
    projectionState: {},
    distributionHistory: {},
  });

  const page = await manager.listTaxonomy("wp-main", {
    kind: "category",
    search: "pub",
    page: 2,
    limit: 12,
  });
  assert.deepEqual(page, {
    items: [{
      connectionId: "wp-main",
      extensionId: "blogmaatic.wordpress-rest",
      kind: "category",
      remoteId: "41",
      name: "Publishing",
      slug: "publishing",
      description: "Publishing workflows",
      count: 8,
      metadata: { wordpressTermId: 41 },
    }],
    page: 2,
    limit: 12,
    hasMore: true,
  });
});


test("WordPress source image upload validates source/version before remote side effects and attaches uploaded media canonically", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let uploadCalls = 0;
  let deleteCalls = 0;
  let attachCalls = 0;
  let current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
  };
  const media = {
    id: 90,
    sourceUrl: "https://example.test/uploads/new-hero.png",
    slug: "new-hero",
    mediaType: "image/png",
    mediaKind: "image",
    title: "New hero",
    alt: "New hero alt",
    width: 16,
    height: 9,
    modifiedGmt: "2026-10-18T14:00:00",
  };

  const manager = new WordPressSourceManager({
    content: {
      async uploadMedia(connectionId, input) {
        uploadCalls += 1;
        assert.equal(connectionId, "wp-main");
        assert.deepEqual(input.bytes, bytes);
        assert.equal(input.mediaType, "image/png");
        assert.equal(input.filename, "hero.png");
        assert.equal(input.alt, "New hero alt");
        assert.equal(input.title, "New hero");
        return media;
      },
      async deleteMediaPermanent() {
        deleteCalls += 1;
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get(id) {
        return id === "publication-wp" ? current : undefined;
      },
      async attachAsset(publicationId, expectedVersion, asset, featured) {
        attachCalls += 1;
        assert.equal(publicationId, "publication-wp");
        assert.equal(expectedVersion, 4);
        assert.equal(asset.id, "wordpress-media-90");
        assert.equal(asset.source, media.sourceUrl);
        assert.equal(asset.mediaType, "image/png");
        assert.equal(asset.alt, "New hero alt");
        assert.equal(asset.attributes.wordpressMediaId, 90);
        assert.equal(asset.attributes.uploadedByBlogmaatic, true);
        assert.equal(featured, true);
        current = {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: {
              ...current.publication.current,
              id: "revision-2",
              ordinal: 2,
              content: {
                ...current.publication.current.content,
                assets: [{ ...asset, attributes: { ...asset.attributes, featured: true } }],
              },
            },
          },
        };
        return current;
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.uploadAsset("wp-other", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      filename: "hero.png",
      mediaType: "image/png",
      bytes,
    }),
    /does not match the publication source/,
  );
  assert.equal(uploadCalls, 0);

  await assert.rejects(
    () => manager.uploadAsset("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 3,
      filename: "hero.png",
      mediaType: "image/png",
      bytes,
    }),
    /changed from version 3 to 4/,
  );
  assert.equal(uploadCalls, 0);

  const result = await manager.uploadAsset("wp-main", {
    publicationId: "publication-wp",
    expectedVersion: 4,
    filename: "hero.png",
    mediaType: "image/png",
    bytes,
    alt: "New hero alt",
    title: "New hero",
    featured: true,
  });
  assert.equal(result.publication.version, 5);
  assert.equal(result.asset.remoteId, "90");
  assert.equal(uploadCalls, 1);
  assert.equal(attachCalls, 1);
  assert.equal(deleteCalls, 0);
});

test("WordPress source image upload compensates remote media when canonical attach loses its CAS race", async () => {
  const deleted = [];
  const manager = new WordPressSourceManager({
    content: {
      async uploadMedia() {
        return {
          id: 91,
          sourceUrl: "https://example.test/uploads/race.png",
          slug: "race",
          mediaType: "image/png",
          mediaKind: "image",
          title: "",
          alt: "",
        };
      },
      async deleteMediaPermanent(connectionId, remoteId) {
        deleted.push([connectionId, remoteId]);
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get() {
        return {
          publication: {
            id: "publication-wp",
            createdAt: "2026-10-18T10:00:00.000Z",
            status: "draft",
            current: {
              id: "revision-1",
              ordinal: 1,
              createdAt: "2026-10-18T10:00:00.000Z",
              content: {
                schemaVersion: 1,
                title: "Imported",
                language: "en",
                blocks: [],
                assets: [],
                tags: [],
                attributes: {},
              },
            },
            provenance: {
              source: "wordpress",
              extensionId: "blogmaatic.wordpress-rest",
              connectionId: "wp-main",
              remoteId: "55",
            },
          },
          version: 4,
          recordedAt: "2026-10-18T10:00:00.000Z",
          updatedAt: "2026-10-18T10:00:00.000Z",
        };
      },
      async attachAsset() {
        throw new Error("Publication publication-wp changed from version 4 to 5");
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.uploadAsset("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      filename: "race.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
    }),
    /changed from version 4 to 5/,
  );
  assert.deepEqual(deleted, [["wp-main", "91"]]);
});


test("WordPress source authors browse safely and assign through canonical source ownership", async () => {
  const author = {
    id: 7,
    name: "Editor Seven",
    slug: "editor-seven",
    link: "https://example.test/author/editor-seven",
    avatarUrl: "https://example.test/avatar/7.png",
  };
  let authorReads = 0;
  let assignment;
  const current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
  };

  const manager = new WordPressSourceManager({
    content: {
      async listAuthors(connectionId, query) {
        assert.equal(connectionId, "wp-main");
        assert.deepEqual(query, { search: "seven", page: 2, perPage: 12 });
        return { items: [author], page: 2, perPage: 12, hasMore: true };
      },
      async getAuthor(connectionId, remoteId) {
        authorReads += 1;
        assert.equal(connectionId, "wp-main");
        assert.equal(remoteId, "7");
        return author;
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get(id) {
        return id === "publication-wp" ? current : undefined;
      },
      async assignSourceAuthor(publicationId, expectedVersion, input) {
        assert.equal(publicationId, "publication-wp");
        assert.equal(expectedVersion, 4);
        assignment = input;
        return {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: {
              ...current.publication.current,
              id: "revision-2",
              ordinal: 2,
              content: {
                ...current.publication.current.content,
                attributes: { sourceAuthor: input },
              },
            },
          },
        };
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  const page = await manager.listAuthors("wp-main", { search: "seven", page: 2, limit: 12 });
  assert.deepEqual(page, {
    items: [{
      connectionId: "wp-main",
      extensionId: "blogmaatic.wordpress-rest",
      remoteId: "7",
      displayName: "Editor Seven",
      slug: "editor-seven",
      link: "https://example.test/author/editor-seven",
      avatarUrl: "https://example.test/avatar/7.png",
      metadata: { wordpressUserId: 7 },
    }],
    page: 2,
    limit: 12,
    hasMore: true,
  });
  assert.equal("email" in page.items[0], false);

  await assert.rejects(
    () => manager.assignAuthor("wp-other", "7", {
      publicationId: "publication-wp",
      expectedVersion: 4,
    }),
    /does not match the publication source/,
  );
  assert.equal(authorReads, 0);

  await assert.rejects(
    () => manager.assignAuthor("wp-main", "7", {
      publicationId: "publication-wp",
      expectedVersion: 3,
    }),
    /changed from version 3 to 4/,
  );
  assert.equal(authorReads, 0);

  const result = await manager.assignAuthor("wp-main", "7", {
    publicationId: "publication-wp",
    expectedVersion: 4,
  });
  assert.equal(authorReads, 1);
  assert.equal(result.publication.version, 5);
  assert.deepEqual(assignment, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "7",
    displayName: "Editor Seven",
  });
  assert.equal(result.author.remoteId, "7");
  assert.equal(result.author.displayName, "Editor Seven");
});


test("WordPress publishing state validates native status and schedule before canonical mutation", async () => {
  let mutations = 0;
  const current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: { schemaVersion: 1, title: "Imported", language: "en", blocks: [], assets: [], tags: [], attributes: {} },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
  };
  const manager = new WordPressSourceManager({
    content: {},
    publisher: {},
    publicationGroups: {},
    publications: {
      async get() { return current; },
      async setSourcePublishingState(publicationId, expectedVersion, state) {
        mutations += 1;
        assert.equal(publicationId, "publication-wp");
        assert.equal(expectedVersion, 4);
        return {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: {
              ...current.publication.current,
              id: "revision-2",
              ordinal: 2,
              content: {
                ...current.publication.current.content,
                attributes: { sourcePublishing: state },
              },
            },
          },
        };
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.setPublishingState("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      status: "future",
    }),
    /requires scheduledAt/,
  );
  await assert.rejects(
    () => manager.setPublishingState("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      status: "draft",
      scheduledAt: "2026-11-01T18:30:00.000Z",
    }),
    /only allowed when status is future/,
  );
  await assert.rejects(
    () => manager.setPublishingState("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      status: "trash",
    }),
    /Unsupported WordPress publishing status/,
  );
  assert.equal(mutations, 0);

  const result = await manager.setPublishingState("wp-main", {
    publicationId: "publication-wp",
    expectedVersion: 4,
    status: "future",
    scheduledAt: "2026-11-01T14:30:00-04:00",
  });
  assert.equal(result.publication.version, 5);
  assert.equal(result.status, "future");
  assert.equal(result.scheduledAt, "2026-11-01T18:30:00.000Z");
  assert.deepEqual(result.publication.publication.current.content.attributes.sourcePublishing, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    status: "future",
    scheduledAt: "2026-11-01T18:30:00.000Z",
  });
  assert.equal(mutations, 1);
});


test("WordPress revision recovery is source-bound before remote fetch and maps selected revision canonically", async () => {
  let revisionReads = 0;
  let restoreInput;
  const current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-18T10:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Current",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {},
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-18T10:00:00.000Z",
    updatedAt: "2026-10-18T10:00:00.000Z",
  };
  const revision = {
    id: 9055,
    parent: 55,
    author: 9,
    dateGmt: "2026-10-17T19:00:00",
    modifiedGmt: "2026-10-17T20:00:00",
    title: "Recovered title",
    excerpt: "<p>Recovered <strong>summary</strong></p>",
    contentHtml: "<h2>Recovered</h2><p>Body</p>",
  };
  const manager = new WordPressSourceManager({
    content: {
      defaultContentType() { return "posts"; },
      async getRevision(connectionId, remoteId, remoteRevisionId) {
        revisionReads += 1;
        assert.equal(connectionId, "wp-main");
        assert.equal(remoteId, "55");
        assert.equal(remoteRevisionId, "9055");
        return revision;
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get(id) {
        return id === "publication-wp" ? current : undefined;
      },
      async restoreSourceRevision(publicationId, expectedVersion, source) {
        assert.equal(publicationId, "publication-wp");
        assert.equal(expectedVersion, 4);
        restoreInput = source;
        return {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: {
              ...current.publication.current,
              id: "revision-2",
              ordinal: 2,
              content: {
                ...current.publication.current.content,
                title: source.title,
                summary: source.summary,
                blocks: [{ id: "restored", kind: "embed", data: { html: source.contentHtml } }],
              },
            },
          },
        };
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.restoreRevision("wp-other", "55", "9055", {
      publicationId: "publication-wp",
      expectedVersion: 4,
    }),
    /does not match the publication source identity/,
  );
  await assert.rejects(
    () => manager.restoreRevision("wp-main", "99", "9055", {
      publicationId: "publication-wp",
      expectedVersion: 4,
    }),
    /does not match the publication source identity/,
  );
  await assert.rejects(
    () => manager.restoreRevision("wp-main", "55", "9055", {
      publicationId: "publication-wp",
      expectedVersion: 3,
    }),
    /changed from version 3 to 4/,
  );
  assert.equal(revisionReads, 0);

  const result = await manager.restoreRevision("wp-main", "55", "9055", {
    publicationId: "publication-wp",
    expectedVersion: 4,
  });
  assert.equal(revisionReads, 1);
  assert.equal(result.publication.version, 5);
  assert.equal(result.revision.remoteRevisionId, "9055");
  assert.equal(result.revision.metadata.parentId, 55);
  assert.equal(result.revision.metadata.authorId, 9);
  assert.deepEqual(restoreInput, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    remoteId: "55",
    remoteRevisionId: "9055",
    title: "Recovered title",
    summary: "Recovered summary",
    contentHtml: "<h2>Recovered</h2><p>Body</p>",
    sourceModifiedAt: "2026-10-17T20:00:00",
    sourceAuthorId: 9,
  });
});


test("WordPress source content types map provider-neutrally and scope source records", async () => {
  const manager = new WordPressSourceManager({
    content: {
      defaultContentType() { return "posts"; },
      async listContentTypes(connectionId) {
        assert.equal(connectionId, "wp-main");
        return [{
          slug: "page",
          name: "Pages",
          restBase: "pages",
          hierarchical: true,
          viewable: true,
          taxonomies: [],
        }];
      },
      async list(connectionId, query) {
        assert.equal(connectionId, "wp-main");
        assert.deepEqual(query, { contentType: "pages", page: 1, perPage: 20 });
        return {
          items: [{
            id: 71,
            author: 1,
            title: "About",
            excerpt: "",
            contentHtml: "<p>About</p>",
            slug: "about",
            status: "publish",
            link: "https://example.test/about",
            dateGmt: "2026-10-19T13:00:00",
            modifiedGmt: "2026-10-19T13:30:00",
            categoryIds: [],
            tagIds: [],
            featuredMediaId: 0,
            ownership: { managed: false },
          }],
          page: 1,
          perPage: 20,
          hasMore: false,
        };
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {},
    projectionState: {},
    distributionHistory: {},
  });

  assert.deepEqual(await manager.listContentTypes("wp-main"), [{
    connectionId: "wp-main",
    extensionId: "blogmaatic.wordpress-rest",
    key: "pages",
    label: "Pages",
    hierarchical: true,
    metadata: {
      wordpressTypeSlug: "page",
      restNamespace: null,
      taxonomies: [],
    },
  }]);

  const page = await manager.list("wp-main", { contentType: "pages", page: 1, limit: 20 });
  assert.equal(page.items[0].contentType, "pages");
  assert.equal(page.items[0].remoteId, "71");
});

test("WordPress import rejects an explicit source content type that does not match the route channel", async () => {
  let snapshotReads = 0;
  const manager = new WordPressSourceManager({
    content: {
      defaultContentType() { return "posts"; },
      async importSnapshot() {
        snapshotReads += 1;
        throw new Error("must not fetch mismatched source content");
      },
    },
    publisher: {},
    publicationGroups: {
      async get(id) {
        assert.equal(id, "group-main");
        return {
          group: {
            id: "group-main",
            name: "Posts",
            policySetId: "default",
            routes: [{
              id: "route-wordpress",
              enabled: true,
              desiredState: "present",
              destination: {
                extensionId: "blogmaatic.wordpress-rest",
                connectionId: "wp-main",
                channel: "posts",
              },
              requiredCapabilities: ["article.create"],
            }],
          },
          version: 1,
          enabled: true,
        };
      },
    },
    publications: {},
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.import("wp-main", "71", {
      contentType: "pages",
      groupId: "group-main",
      routeId: "route-wordpress",
    }),
    /targets WordPress content type posts, not pages/,
  );
  assert.equal(snapshotReads, 0);
});


test("WordPress page structure verifies parent in the same content type before canonical mutation", async () => {
  let parentReads = 0;
  let mutationInput;
  const current = {
    publication: {
      id: "publication-page",
      createdAt: "2026-10-21T18:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-21T18:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Child Page",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: {
            wordpress: { connectionId: "wp-main", contentType: "pages", remoteId: "55" },
          },
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-21T18:00:00.000Z",
    updatedAt: "2026-10-21T18:00:00.000Z",
  };
  const manager = new WordPressSourceManager({
    content: {
      async listContentTypes(connectionId) {
        assert.equal(connectionId, "wp-main");
        return [
          {
            slug: "post",
            name: "Posts",
            restBase: "posts",
            hierarchical: false,
            viewable: true,
            taxonomies: ["category", "post_tag"],
          },
          {
            slug: "page",
            name: "Pages",
            restBase: "pages",
            hierarchical: true,
            viewable: true,
            taxonomies: [],
          },
        ];
      },
      async get(connectionId, remoteId, contentType) {
        parentReads += 1;
        assert.equal(connectionId, "wp-main");
        assert.equal(remoteId, "77");
        assert.equal(contentType, "pages");
        return {
          id: 77, title: "Parent", excerpt: "", contentHtml: "", slug: "parent",
          status: "publish", link: "https://example.test/?page_id=77",
          categoryIds: [], tagIds: [], ownership: { managed: false },
        };
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get(id) { return id === "publication-page" ? current : undefined; },
      async setSourcePageStructure(publicationId, expectedVersion, state) {
        mutationInput = state;
        return {
          ...current,
          version: 5,
          publication: {
            ...current.publication,
            current: {
              ...current.publication.current,
              id: "revision-2",
              ordinal: 2,
              content: {
                ...current.publication.current.content,
                attributes: {
                  ...current.publication.current.content.attributes,
                  sourcePage: state,
                },
              },
            },
          },
        };
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.setPageStructure("wp-main", {
      publicationId: "publication-page",
      expectedVersion: 4,
      contentType: "pages",
      parentRemoteId: "55",
      template: null,
      menuOrder: 0,
    }),
    /cannot be its own parent/,
  );
  assert.equal(parentReads, 0);

  await assert.rejects(
    () => manager.setPageStructure("wp-main", {
      publicationId: "publication-page",
      expectedVersion: 4,
      contentType: "posts",
      parentRemoteId: null,
      template: null,
      menuOrder: 0,
    }),
    /does not support page hierarchy/,
  );
  await assert.rejects(
    () => manager.setPageStructure("wp-main", {
      publicationId: "publication-page",
      expectedVersion: 4,
      contentType: "missing-type",
      parentRemoteId: null,
      template: null,
      menuOrder: 0,
    }),
    /is not available on this connection/,
  );
  assert.equal(parentReads, 0);

  const result = await manager.setPageStructure("wp-main", {
    publicationId: "publication-page",
    expectedVersion: 4,
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 3,
  });
  assert.equal(parentReads, 1);
  assert.equal(result.publication.version, 5);
  assert.deepEqual(mutationInput, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 3,
  });
});


test("WordPress Page import preserves native parent template and menu order from revision one", async () => {
  let stored;
  const snapshot = {
    post: {
      id: 55,
      author: 7,
      title: "Child Page",
      excerpt: "",
      contentHtml: "<p>Child body.</p>",
      slug: "child-page",
      status: "publish",
      link: "https://example.test/?page_id=55",
      dateGmt: "2026-10-21T17:00:00",
      modifiedGmt: "2026-10-21T17:30:00",
      categoryIds: [],
      tagIds: [],
      parentId: 77,
      template: "templates/landing.php",
      menuOrder: 5,
      ownership: { managed: false },
    },
    categoryNames: [],
    tagNames: [],
  };
  const group = {
    id: "group-pages",
    name: "Pages",
    policySetId: "default",
    routes: [{
      id: "route-pages",
      enabled: true,
      desiredState: "present",
      destination: {
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        channel: "pages",
      },
      requiredCapabilities: ["article.create", "article.inspect"],
    }],
  };
  const manager = new WordPressSourceManager({
    content: {
      defaultContentType() { return "posts"; },
      async importSnapshot(connectionId, remoteId, contentType) {
        assert.equal(connectionId, "wp-main");
        assert.equal(remoteId, "55");
        assert.equal(contentType, "pages");
        return snapshot;
      },
      async adopt(_connectionId, _remoteId, projection) {
        return {
          ...snapshot.post,
          ownership: {
            managed: true,
            publicationId: projection.publicationId,
            routeId: projection.routeId,
          },
        };
      },
    },
    publisher: {
      async compile({ publication, route }) {
        return {
          projectionId: publication.id + ":" + route.id,
          publicationId: publication.id,
          sourceRevisionId: publication.current.id,
          routeId: route.id,
          destination: route.destination,
          payload: {},
          fingerprint: "page-import-fingerprint",
        };
      },
    },
    publicationGroups: {
      async get(id) {
        assert.equal(id, "group-pages");
        return { group, version: 1, enabled: true, recordedAt: "2026-10-21T18:00:00.000Z" };
      },
    },
    publications: {
      async findImportedSource() { return stored; },
      async registerImported(publication) {
        stored = {
          publication,
          version: 1,
          recordedAt: "2026-10-21T18:00:00.000Z",
          updatedAt: "2026-10-21T18:00:00.000Z",
        };
        return stored;
      },
    },
    projectionState: { async put() {} },
    distributionHistory: { async append() {} },
    now: () => "2026-10-21T18:00:00.000Z",
    id: (() => {
      const ids = ["page-publication", "page-revision"];
      let index = 0;
      return () => ids[index++] ?? "page-extra";
    })(),
  });

  const result = await manager.import("wp-main", "55", {
    groupId: "group-pages",
    routeId: "route-pages",
    contentType: "pages",
  });
  assert.deepEqual(result.publication.publication.current.content.attributes.sourcePage, {
    extensionId: "blogmaatic.wordpress-rest",
    connectionId: "wp-main",
    contentType: "pages",
    parentRemoteId: "77",
    template: "templates/landing.php",
    menuOrder: 5,
  });
  assert.deepEqual(
    {
      parentRemoteId: result.publication.publication.current.content.attributes.wordpress.parentRemoteId,
      template: result.publication.publication.current.content.attributes.wordpress.template,
      menuOrder: result.publication.publication.current.content.attributes.wordpress.menuOrder,
    },
    { parentRemoteId: "77", template: "templates/landing.php", menuOrder: 5 },
  );
});


test("WordPress editorial options validate live type capabilities before canonical mutation", async () => {
  let mutations = 0;
  const current = {
    publication: {
      id: "publication-wp",
      createdAt: "2026-10-23T15:00:00.000Z",
      status: "draft",
      current: {
        id: "revision-1",
        ordinal: 1,
        createdAt: "2026-10-23T15:00:00.000Z",
        content: {
          schemaVersion: 1,
          title: "Imported",
          language: "en",
          blocks: [],
          assets: [],
          tags: [],
          attributes: { wordpress: { contentType: "posts" } },
        },
      },
      provenance: {
        source: "wordpress",
        extensionId: "blogmaatic.wordpress-rest",
        connectionId: "wp-main",
        remoteId: "55",
      },
    },
    version: 4,
    recordedAt: "2026-10-23T15:00:00.000Z",
    updatedAt: "2026-10-23T15:00:00.000Z",
  };
  const manager = new WordPressSourceManager({
    content: {
      async listContentTypes() {
        return [
          {
            slug: "post",
            name: "Posts",
            restBase: "posts",
            hierarchical: false,
            viewable: true,
            taxonomies: ["category", "post_tag"],
            supports: ["comments", "post-formats"],
          },
          {
            slug: "book",
            name: "Books",
            restBase: "books",
            hierarchical: false,
            viewable: true,
            taxonomies: [],
            supports: [],
          },
        ];
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get() { return current; },
      async setSourceEditorialOptions(publicationId, expectedVersion, state) {
        mutations += 1;
        assert.equal(publicationId, "publication-wp");
        assert.equal(expectedVersion, 4);
        return { ...current, version: 5, publication: { ...current.publication, current: { ...current.publication.current, id: "revision-2", ordinal: 2, content: { ...current.publication.current.content, attributes: { ...current.publication.current.content.attributes, sourceEditorial: state } } } } };
      },
    },
    projectionState: {},
    distributionHistory: {},
  });

  await assert.rejects(
    () => manager.setEditorialOptions("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      contentType: "posts",
      password: "locked",
      sticky: true,
    }),
    /cannot be password protected/,
  );
  assert.equal(mutations, 0);

  const result = await manager.setEditorialOptions("wp-main", {
    publicationId: "publication-wp",
    expectedVersion: 4,
    contentType: "posts",
    password: "",
    commentStatus: "closed",
    pingStatus: "open",
    sticky: true,
    format: "gallery",
  });
  assert.equal(result.publication.version, 5);
  assert.equal(result.passwordProtected, false);
  assert.equal(result.sticky, true);
  assert.equal(result.format, "gallery");
  assert.equal(mutations, 1);

  const bookCurrent = structuredClone(current);
  bookCurrent.publication.current.content.attributes.wordpress.contentType = "books";
  const bookManager = new WordPressSourceManager({
    content: {
      async listContentTypes() {
        return [{ slug: "book", name: "Books", restBase: "books", hierarchical: false, viewable: true, taxonomies: [], supports: [] }];
      },
    },
    publisher: {},
    publicationGroups: {},
    publications: {
      async get() { return bookCurrent; },
      async setSourceEditorialOptions() { throw new Error("must not mutate"); },
    },
    projectionState: {},
    distributionHistory: {},
  });
  await assert.rejects(
    () => bookManager.setEditorialOptions("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      contentType: "books",
      password: "",
      commentStatus: "open",
    }),
    /does not support discussion options/,
  );
  await assert.rejects(
    () => bookManager.setEditorialOptions("wp-main", {
      publicationId: "publication-wp",
      expectedVersion: 4,
      contentType: "books",
      password: "",
      sticky: false,
    }),
    /does not support sticky state/,
  );
});
