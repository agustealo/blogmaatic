import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageArg = process.argv[2];
if (!packageArg) throw new Error("Usage: node scripts/smoke-native-package.mjs <package>");
const packagePath = resolve(packageArg);
const dataDir = await mkdtemp(join(tmpdir(), "blogmaatic-native-state-"));
const repository = await mkdtemp(join(tmpdir(), "blogmaatic-native-jekyll-"));

async function exec(file, args, options = {}) {
  return execFileAsync(file, args, { encoding: "utf8", ...options });
}

async function git(args) {
  return (await exec("git", args, { cwd: repository })).stdout.trim();
}

async function install() {
  if (process.platform === "linux") {
    assert.match(basename(packagePath), /\.deb$/);
    await exec("sudo", ["dpkg", "-i", packagePath]);
  } else if (process.platform === "darwin") {
    assert.match(basename(packagePath), /\.pkg$/);
    await exec("sudo", ["installer", "-pkg", packagePath, "-target", "/"]);
  } else {
    throw new Error(`Native installer smoke is unsupported on ${process.platform}`);
  }
}

async function cleanupInstall() {
  await exec("sudo", ["rm", "-f", "/usr/local/bin/blogmaatic"]).catch(() => undefined);
  await exec("sudo", ["rm", "-rf", "/opt/blogmaatic"]).catch(() => undefined);
}

try {
  await install();
  const binary = "/usr/local/bin/blogmaatic";
  const version = (await exec(binary, ["version"])).stdout.trim();
  assert.match(version, /^Blogmaatic \d+\.\d+\.\d+/);

  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Native Package Fixture"]);
  await git(["config", "user.email", "native-package@example.test"]);
  await writeFile(join(repository, "_config.yml"), "title: Native Package Fixture\n");
  await git(["add", "_config.yml"]);
  await git(["commit", "-m", "seed"]);

  await exec(binary, [
    "init",
    "--data-dir", dataDir,
    "--jekyll-repo", repository,
    "--author-name", "Blogmaatic Native Package",
    "--author-email", "native-package@example.test",
    "--site-base-url", "https://example.test",
  ]);

  const doctor = await exec(binary, ["doctor", "--json", "--data-dir", dataDir]);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks?.config?.ok, true);
  assert.equal(report.checks?.operatorToken?.ok, true);
  assert.equal(report.checks?.controlRoom?.ok, true);
  assert.equal(report.checks?.restateServer?.ok, true);
  assert.equal(report.checks?.restateCli?.ok, true);

  console.log(`Native installer smoke passed: ${basename(packagePath)}`);
} finally {
  await cleanupInstall();
  await rm(dataDir, { recursive: true, force: true });
  await rm(repository, { recursive: true, force: true });
}
