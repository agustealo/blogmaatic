import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PolicyEngine, PublicationKernel } from "@blogmaatic/core";
import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";
import { JekyllGitPublisher } from "../dist/index.js";

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const result = await execFileAsync("git", args, { cwd: root });
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-jekyll-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(root, "_config.yml"), "title: Fixture\n");
  await git(root, ["add", "_config.yml"]);
  await git(root, ["commit", "-m", "seed"]);
  return root;
}

function publication(overrides = {}) {
  return {
    id: "pub-1",
    createdAt: "2026-09-22T10:15:00.000Z",
    slug: "maintain-everywhere",
    status: "approved",
    current: {
      id: "rev-1",
      ordinal: 1,
      createdAt: "2026-09-22T11:00:00.000Z",
      content: {
        schemaVersion: 1,
        title: "Maintain Everywhere",
        language: "en",
        blocks: [
          { id: "h1", kind: "heading", data: { level: 2, text: "One publication" } },
          { id: "p1", kind: "paragraph", data: { text: "Publish once. Maintain everywhere." } },
        ],
        assets: [],
        tags: ["publishing", "automation"],
        attributes: {},
      },
    },
    canonicalUrl: "https://example.test/maintain-everywhere/",
    provenance: { author: "owner" },
    ...overrides,
  };
}

function group(connectionId = "jekyll-main") {
  return {
    id: "group-1",
    name: "Main publication",
    policySetId: "allow",
    routes: [
      {
        id: "jekyll-primary",
        enabled: true,
        desiredState: "present",
        destination: {
          extensionId: "blogmaatic.jekyll-git",
          connectionId,
          channel: "posts",
        },
        requiredCapabilities: ["article.create", "article.update", "article.inspect"],
        variant: { layout: "post", permalink: "/maintain-everywhere/" },
      },
    ],
  };
}

async function fixture() {
  const root = await repository();
  const connections = new ConnectionAuthority([
    {
      id: "jekyll-main",
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Fixture Jekyll",
      status: "active",
      settings: {
        repositoryPath: root,
        branch: "main",
        authorName: "Blogmaatic",
        authorEmail: "blogmaatic@example.test",
        push: false,
        siteBaseUrl: "https://example.test",
        buildVerification: "none",
      },
      secretRefs: {},
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z",
    },
  ]);
  const runtime = new ExtensionRuntime(connections);
  runtime.registerPublisher(new JekyllGitPublisher(connections));
  const policies = new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]);
  const kernel = new PublicationKernel(runtime.publishers, policies);
  return { root, runtime, kernel };
}

test("publishes a real Jekyll post into Git and repeated publication is a no-op", async () => {
  const { root, runtime, kernel } = await fixture();
  const health = await runtime.checkHealth("jekyll-main");
  assert.equal(health.state, "healthy");

  const first = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(first[0].status, "verified");
  assert.equal(first[0].remote.id, "_posts/2026-09-22-pub-1.md");
  assert.equal(first[0].remote.url, "https://example.test/maintain-everywhere/");

  const content = await readFile(join(root, first[0].remote.id), "utf8");
  assert.match(content, /title: "Maintain Everywhere"/);
  assert.match(content, /blogmaatic_fingerprint:/);
  assert.match(content, /Publish once\. Maintain everywhere\./);
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "2");

  const second = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(second[0].status, "verified");
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "2");
});

test("committed remote drift is repaired in place without creating another Jekyll file", async () => {
  const { root, kernel } = await fixture();
  const first = await kernel.publish({ publication: publication(), group: group() });
  const path = first[0].remote.id;
  const absolute = join(root, path);
  const content = await readFile(absolute, "utf8");
  await writeFile(absolute, content.replace("Publish once.", "Externally changed."));
  await git(root, ["add", path]);
  await git(root, ["commit", "-m", "external edit"]);

  const report = await kernel.reconcile(publication(), group());
  assert.equal(report.items[0].action, "update");
  assert.equal(report.items[0].observed.state, "drifted");

  const repaired = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(repaired[0].status, "verified");
  assert.equal(repaired[0].remote.id, path);
  assert.match(await readFile(absolute, "utf8"), /Publish once\. Maintain everywhere\./);
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "4");
  assert.equal((await git(root, ["ls-files", "_posts/*.md"])).split("\n").filter(Boolean).length, 1);
});

test("uncommitted human edits fail closed and are not overwritten", async () => {
  const { root, kernel } = await fixture();
  const first = await kernel.publish({ publication: publication(), group: group() });
  const path = first[0].remote.id;
  const absolute = join(root, path);
  const original = await readFile(absolute, "utf8");
  await writeFile(absolute, original.replace("Publish once.", "Human work in progress."));

  const receipts = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(receipts[0].status, "unreachable");
  assert.match(receipts[0].observed.detail, /uncommitted local changes/);
  assert.match(await readFile(absolute, "utf8"), /Human work in progress\./);
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "2");
});

test("local asset publication is restricted to configured source roots", async () => {
  const root = await repository();
  const assetRoot = await mkdtemp(join(tmpdir(), "blogmaatic-assets-"));
  const source = join(assetRoot, "hero image.png");
  await writeFile(source, "real-image-bytes");
  const connections = new ConnectionAuthority([
    {
      id: "jekyll-main",
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Fixture Jekyll",
      status: "active",
      settings: {
        repositoryPath: root,
        branch: "main",
        authorName: "Blogmaatic",
        authorEmail: "blogmaatic@example.test",
        assetSourceRoots: [assetRoot],
      },
      secretRefs: {},
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z",
    },
  ]);
  const runtime = new ExtensionRuntime(connections);
  runtime.registerPublisher(new JekyllGitPublisher(connections));
  const kernel = new PublicationKernel(
    runtime.publishers,
    new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]),
  );
  const item = publication({
    current: {
      ...publication().current,
      content: {
        ...publication().current.content,
        assets: [{ id: "hero", kind: "image", source, alt: "Hero" }],
        blocks: [{ id: "image", kind: "image", data: { assetId: "hero" } }],
      },
    },
  });

  const receipts = await kernel.publish({ publication: item, group: group() });
  assert.equal(receipts[0].status, "verified");
  const tracked = await git(root, ["ls-files", "assets/blogmaatic/**"]);
  assert.match(tracked, /assets\/blogmaatic\/pub-1\/hero-hero-image\.png/);
  const post = await readFile(join(root, receipts[0].remote.id), "utf8");
  assert.match(post, /!\[Hero\]\(\/assets\/blogmaatic\/pub-1\/hero-hero-image\.png\)/);
  assert.doesNotMatch(post, new RegExp(assetRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("push-enabled connections publish the exact Git commit to a real remote branch", async () => {
  const root = await repository();
  const remote = await mkdtemp(join(tmpdir(), "blogmaatic-remote-"));
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);

  const connections = new ConnectionAuthority([
    {
      id: "jekyll-main",
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Remote Jekyll",
      status: "active",
      settings: {
        repositoryPath: root,
        branch: "main",
        authorName: "Blogmaatic",
        authorEmail: "blogmaatic@example.test",
        push: true,
        remote: "origin",
      },
      secretRefs: {},
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z",
    },
  ]);
  const runtime = new ExtensionRuntime(connections);
  runtime.registerPublisher(new JekyllGitPublisher(connections));
  const kernel = new PublicationKernel(
    runtime.publishers,
    new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]),
  );

  const first = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(first[0].status, "verified");
  assert.equal(first[0].evidence.pushed, true);
  const remoteContent = await execFileAsync(
    "git",
    ["--git-dir", remote, "show", `main:${first[0].remote.id}`],
  );
  assert.match(remoteContent.stdout, /Maintain Everywhere/);
  const commitCount = await git(root, ["rev-list", "--count", "HEAD"]);

  const second = await kernel.publish({ publication: publication(), group: group() });
  assert.equal(second[0].status, "verified");
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), commitCount);
});

test("failed pre-commit build verification rolls back document mutations", async () => {
  const root = await repository();
  const bin = await mkdtemp(join(tmpdir(), "blogmaatic-bin-"));
  const bundle = join(bin, "bundle");
  await writeFile(bundle, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    const connections = new ConnectionAuthority([
      {
        id: "jekyll-main",
        extensionId: "blogmaatic.jekyll-git",
        displayName: "Build-verified Jekyll",
        status: "active",
        settings: {
          repositoryPath: root,
          branch: "main",
          authorName: "Blogmaatic",
          authorEmail: "blogmaatic@example.test",
          buildVerification: "bundle",
        },
        secretRefs: {},
        createdAt: "2026-09-22T10:00:00.000Z",
        updatedAt: "2026-09-22T10:00:00.000Z",
      },
    ]);
    const runtime = new ExtensionRuntime(connections);
    runtime.registerPublisher(new JekyllGitPublisher(connections));
    const kernel = new PublicationKernel(
      runtime.publishers,
      new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]),
    );

    await assert.rejects(
      kernel.publish({ publication: publication(), group: group() }),
      /Command failed/,
    );
    assert.equal(await git(root, ["status", "--porcelain"]), "");
    assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "1");
    await assert.rejects(
      readFile(join(root, "_posts/2026-09-22-pub-1.md"), "utf8"),
      /ENOENT/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("committed asset drift is detected and repaired with the publication projection", async () => {
  const root = await repository();
  const assetRoot = await mkdtemp(join(tmpdir(), "blogmaatic-assets-drift-"));
  const source = join(assetRoot, "hero.png");
  await writeFile(source, "source-v1");
  const connections = new ConnectionAuthority([
    {
      id: "jekyll-main",
      extensionId: "blogmaatic.jekyll-git",
      displayName: "Asset Jekyll",
      status: "active",
      settings: {
        repositoryPath: root,
        branch: "main",
        authorName: "Blogmaatic",
        authorEmail: "blogmaatic@example.test",
        assetSourceRoots: [assetRoot],
      },
      secretRefs: {},
      createdAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:00.000Z",
    },
  ]);
  const runtime = new ExtensionRuntime(connections);
  runtime.registerPublisher(new JekyllGitPublisher(connections));
  const kernel = new PublicationKernel(
    runtime.publishers,
    new PolicyEngine([{ id: "allow", defaultEffect: "allow", rules: [] }]),
  );
  const item = publication({
    current: {
      ...publication().current,
      content: {
        ...publication().current.content,
        assets: [{ id: "hero", kind: "image", source, alt: "Hero" }],
        blocks: [{ id: "image", kind: "image", data: { assetId: "hero" } }],
      },
    },
  });

  const first = await kernel.publish({ publication: item, group: group() });
  assert.equal(first[0].status, "verified");
  const assetPath = (await git(root, ["ls-files", "assets/blogmaatic/**"])).trim();
  await writeFile(join(root, assetPath), "external-drift");
  await git(root, ["add", assetPath]);
  await git(root, ["commit", "-m", "external asset edit"]);

  const report = await kernel.reconcile(item, group());
  assert.equal(report.items[0].action, "update");
  assert.equal(report.items[0].observed.state, "drifted");

  const repaired = await kernel.publish({ publication: item, group: group() });
  assert.equal(repaired[0].status, "verified");
  assert.equal(await readFile(join(root, assetPath), "utf8"), "source-v1");
});
