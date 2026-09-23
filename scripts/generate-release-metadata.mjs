import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = resolve(process.argv[2] ?? join(root, "release-assets"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(packageJson.version);
const tag = process.env.BLOGMAATIC_RELEASE_TAG?.trim() || process.env.GITHUB_REF_NAME?.trim() || `v${version}`;
const sourceSha = process.env.GITHUB_SHA?.trim() || process.env.BLOGMAATIC_RELEASE_SHA?.trim();
if (!sourceSha || !/^[0-9a-f]{40}$/i.test(sourceSha)) {
  throw new Error("GITHUB_SHA or BLOGMAATIC_RELEASE_SHA must be a 40-character Git commit SHA");
}

const generatedAt = (await execFileAsync("git", ["show", "-s", "--format=%cI", sourceSha], {
  cwd: root,
  encoding: "utf8",
})).stdout.trim();
if (!/^\d{4}-\d{2}-\d{2}T/.test(generatedAt)) {
  throw new Error(`Could not derive deterministic release timestamp from ${sourceSha}`);
}

const entries = (await readdir(assetDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => !name.endsWith(".sha256") && name !== "SHA256SUMS" && name !== "release-manifest.json")
  .sort();
if (entries.length === 0) throw new Error(`No release assets found in ${assetDir}`);

const assets = [];
for (const name of entries) {
  const bytes = await readFile(join(assetDir, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assets.push({ name, size: bytes.byteLength, sha256 });
}

await writeFile(
  join(assetDir, "SHA256SUMS"),
  `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
  { mode: 0o644 },
);

const manifest = {
  schemaVersion: 1,
  product: "Blogmaatic",
  version,
  tag,
  sourceSha,
  generatedAt,
  packageManager: packageJson.packageManager,
  nodeVersion: "24.21.0",
  managedRestateVersion: "1.7.10",
  assets,
};
await writeFile(join(assetDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ assetDir, assets: assets.length, tag, sourceSha, generatedAt }));
