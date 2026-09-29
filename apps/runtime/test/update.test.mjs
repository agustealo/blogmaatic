import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkForUpdate, prepareUpdate, verifyPreparedUpdate } from "../dist/update.js";

const ORIGINAL_FETCH = globalThis.fetch;
const LATEST_URL = "https://api.github.com/repos/agustealo/blogmaatic/releases/latest";

function packageName(version) {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `blogmaatic-${version}-macos-${process.arch}.pkg`;
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return `blogmaatic-${version}-amd64.deb`;
  }
  return null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorityFixture({ version = "9.8.7", manifestTag = `v${version}`, packageBytes = Buffer.from("verified-native-installer"), manifestSha } = {}) {
  const name = packageName(version);
  if (!name) return null;
  const tag = `v${version}`;
  const releaseRoot = `https://github.com/agustealo/blogmaatic/releases/download/${tag}`;
  const packageUrl = `${releaseRoot}/${name}`;
  const manifestUrl = `${releaseRoot}/release-manifest.json`;
  const digest = manifestSha ?? sha256(packageBytes);
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/agustealo/blogmaatic/releases/tag/${tag}`,
    assets: [
      { name: "release-manifest.json", browser_download_url: manifestUrl },
      { name, browser_download_url: packageUrl },
    ],
  };
  const manifest = {
    schemaVersion: 1,
    product: "Blogmaatic",
    version,
    tag: manifestTag,
    sourceSha: "a".repeat(40),
    assets: [{ name, size: packageBytes.length, sha256: digest }],
  };
  return { name, tag, packageBytes, packageUrl, manifestUrl, release, manifest, digest };
}

function installFetch(fixture) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === LATEST_URL) return Response.json(fixture.release);
    if (url === fixture.manifestUrl) return Response.json(fixture.manifest);
    if (url === fixture.packageUrl) return new Response(fixture.packageBytes, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("trusted update check selects the exact native release package", async (t) => {
  const fixture = authorityFixture();
  if (!fixture) return t.skip(`No native update package contract for ${process.platform}/${process.arch}`);
  installFetch(fixture);

  const status = await checkForUpdate("9.8.6");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.currentVersion, "9.8.6");
  assert.equal(status.latestVersion, "9.8.7");
  assert.equal(status.tag, fixture.tag);
  assert.equal(status.packageName, fixture.name);
  assert.equal(status.packageSha256, fixture.digest);
  assert.equal(status.packageSize, fixture.packageBytes.length);
});

test("trusted update preparation verifies bytes before staging the installer", async (t) => {
  const fixture = authorityFixture();
  if (!fixture) return t.skip(`No native update package contract for ${process.platform}/${process.arch}`);
  installFetch(fixture);
  const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-update-"));
  try {
    const prepared = await prepareUpdate("9.8.6", dataDir);
    assert.equal(prepared.updateAvailable, true);
    assert.equal(prepared.packageName, fixture.name);
    assert.deepEqual(await readFile(prepared.packagePath), fixture.packageBytes);
    await verifyPreparedUpdate(prepared);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("trusted update authority rejects manifest/tag mismatch", async (t) => {
  const fixture = authorityFixture({ manifestTag: "v9.8.8" });
  if (!fixture) return t.skip(`No native update package contract for ${process.platform}/${process.arch}`);
  installFetch(fixture);
  await assert.rejects(() => checkForUpdate("9.8.6"), /manifest tag does not match/i);
});

test("trusted update authority rejects tampered installer bytes", async (t) => {
  const fixture = authorityFixture({ manifestSha: "0".repeat(64) });
  if (!fixture) return t.skip(`No native update package contract for ${process.platform}/${process.arch}`);
  installFetch(fixture);
  const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-update-tamper-"));
  try {
    await assert.rejects(() => prepareUpdate("9.8.6", dataDir), /checksum does not match/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("trusted update check does not downgrade a newer installed version", async (t) => {
  const fixture = authorityFixture();
  if (!fixture) return t.skip(`No native update package contract for ${process.platform}/${process.arch}`);
  installFetch(fixture);
  const status = await checkForUpdate("9.9.0");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.latestVersion, "9.8.7");
});
