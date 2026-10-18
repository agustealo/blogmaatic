import assert from "node:assert/strict";
import test from "node:test";

import { PublicationPreviewManager } from "../dist/publication-preview-manager.js";

test("destination preview compiles routes independently and sanitizes internal fields", async () => {
  const publication = {
    id: "publication-1",
    createdAt: "2026-10-18T10:00:00.000Z",
    status: "approved",
    current: {
      id: "revision-2",
      ordinal: 2,
      createdAt: "2026-10-18T10:30:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Preview me",
        language: "en",
        blocks: [],
        assets: [],
        tags: [],
        attributes: {},
      },
    },
    provenance: { source: "blogmaatic.publication-workspace" },
  };
  const routes = [
    {
      id: "route-ready",
      enabled: true,
      desiredState: "present",
      destination: { extensionId: "demo.ready", connectionId: "connection-ready", channel: "posts" },
      requiredCapabilities: ["article.create"],
    },
    {
      id: "route-error",
      enabled: true,
      desiredState: "present",
      destination: { extensionId: "demo.error", connectionId: "connection-error", channel: "feed" },
      requiredCapabilities: ["article.create"],
    },
  ];

  const publishers = new Map([
    ["demo.ready", {
      manifest: { id: "demo.ready", displayName: "Ready Network", version: "1.0.0", capabilities: ["article.create"] },
      async compile({ publication: input, route }) {
        return {
          projectionId: `${input.id}:${route.id}`,
          publicationId: input.id,
          sourceRevisionId: input.current.id,
          routeId: route.id,
          destination: route.destination,
          fingerprint: "fingerprint-ready",
          payload: {
            title: "Preview me",
            message: "Compiled social message",
            mode: "text",
            token: "must-not-leak",
            assets: [{ sourcePath: "/private/source.png", publicUrl: "https://cdn.example.test/image.png" }],
            fidelity: { score: 92, exact: false, issues: ["title truncated"] },
          },
        };
      },
    }],
    ["demo.error", {
      manifest: { id: "demo.error", displayName: "Broken Network", version: "1.0.0", capabilities: ["article.create"] },
      async compile() {
        throw new Error("Destination requires a canonical URL");
      },
    }],
  ]);

  const manager = new PublicationPreviewManager({
    publications: {
      async get(id) {
        return id === publication.id
          ? { publication, version: 2, recordedAt: publication.createdAt, updatedAt: publication.current.createdAt }
          : undefined;
      },
    },
    publicationGroups: {
      async get(id) {
        return id === "group-main"
          ? {
            group: { id, name: "Main Channels", policySetId: "default", routes },
            version: 1,
            enabled: true,
            registeredAt: publication.createdAt,
            isActiveVersion: true,
          }
          : undefined;
      },
    },
    extensions: {
      getPublisher(id) {
        const publisher = publishers.get(id);
        if (!publisher) throw new Error(`missing publisher ${id}`);
        return publisher;
      },
      publishers: {
        assertCapabilities() {},
      },
      connections: {
        get(id) {
          return { id, displayName: id === "connection-ready" ? "Main Social" : "Broken Social" };
        },
      },
    },
  });

  const preview = await manager.preview("publication-1", "group-main");
  assert.equal(preview.revisionId, "revision-2");
  assert.equal(preview.items.length, 2);

  const ready = preview.items.find((item) => item.routeId === "route-ready");
  assert.equal(ready.status, "ready");
  assert.equal(ready.destination.extensionName, "Ready Network");
  assert.equal(ready.summary.text, "Compiled social message");
  assert.equal(ready.summary.fidelity.score, 92);
  assert.equal(ready.summary.mediaCount, 1);
  assert.equal(ready.payload.token, undefined);
  assert.equal(ready.payload.assets[0].sourcePath, undefined);
  assert.equal(ready.payload.assets[0].publicUrl, "https://cdn.example.test/image.png");

  const failed = preview.items.find((item) => item.routeId === "route-error");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /canonical URL/);
});
