import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractOnly = process.argv.includes("--contract-only");

function fail(message) {
  throw new Error(`Release contract violation: ${message}`);
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const version = String(packageJson.version ?? "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`package.json version is not valid SemVer: ${version}`);
}
if (String(lockfile.version ?? "") !== version) {
  fail(`package-lock.json version ${lockfile.version ?? "<missing>"} does not match package.json ${version}`);
}
if (String(lockfile.packages?.[""]?.version ?? "") !== version) {
  fail(`package-lock root version ${lockfile.packages?.[""]?.version ?? "<missing>"} does not match package.json ${version}`);
}
if (packageJson.packageManager !== "npm@11.19.0") {
  fail(`packageManager must remain exactly npm@11.19.0, received ${packageJson.packageManager}`);
}
const expectedTag = `v${version}`;
const requestedTag = process.env.BLOGMAATIC_RELEASE_TAG?.trim() || process.env.GITHUB_REF_NAME?.trim() || expectedTag;
if (requestedTag !== expectedTag) fail(`tag ${requestedTag} must exactly match package version ${expectedTag}`);

if (!contractOnly) {
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== `refs/tags/${expectedTag}`) {
    fail(`release workflow must run from refs/tags/${expectedTag}, received ${process.env.GITHUB_REF}`);
  }
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
    fail(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked out HEAD ${head}`);
  }
  const tagCommit = (await execFileAsync("git", ["rev-parse", `${expectedTag}^{commit}`], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (tagCommit !== head) fail(`tag ${expectedTag} resolves to ${tagCommit}, but checkout is ${head}`);
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", head, "origin/master"], { cwd: root, encoding: "utf8" });
  } catch {
    fail(`tagged commit ${head} is not contained in origin/master`);
  }
}

console.log(JSON.stringify({ ok: true, version, tag: expectedTag, contractOnly }));
