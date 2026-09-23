import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function required(path, label = path) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`Distribution input is missing: ${label}`);
  }
}

async function requiredExecutable(path, label = path) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Distribution executable is missing or not executable: ${label}`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyWorkspaceFamily(family, destinationRoot) {
  const sourceFamily = join(root, family);
  const entries = await readdir(sourceFamily, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceFamily, entry.name);
    const packagePath = join(source, "package.json");
    if (!(await exists(packagePath))) continue;
    const destination = join(destinationRoot, family, entry.name);
    await mkdir(destination, { recursive: true });
    await copyFile(packagePath, join(destination, "package.json"));
    const dist = join(source, "dist");
    if (await exists(dist)) {
      await cp(dist, join(destination, "dist"), {
        recursive: true,
        force: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(packageJson.version ?? "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Root package version is not release-safe: ${version}`);
}
if (process.platform !== "linux" && process.platform !== "darwin") {
  throw new Error(`Portable managed-runtime distributions are currently supported on linux/darwin, not ${process.platform}`);
}

const runtimeCli = join(root, "apps", "runtime", "dist", "cli.js");
const controlRoomIndex = join(root, "apps", "control-room", "dist", "index.html");
const restateServer = join(root, "node_modules", ".bin", "restate-server");
const restateCli = join(root, "node_modules", ".bin", "restate");
const lockfile = join(root, "package-lock.json");
await required(runtimeCli, "compiled runtime CLI");
await required(controlRoomIndex, "compiled Control Room");
await required(lockfile, "package-lock.json");
await requiredExecutable(restateServer, "restate-server");
await requiredExecutable(restateCli, "restate CLI");
await requiredExecutable(process.execPath, "Node.js executable");

const artifactRoot = resolve(process.env.BLOGMAATIC_ARTIFACT_DIR ?? join(root, "artifacts"));
const artifactName = `blogmaatic-${version}-${process.platform}-${process.arch}`;
const stage = join(artifactRoot, artifactName);
const archive = join(artifactRoot, `${artifactName}.tar.gz`);
const checksumPath = `${archive}.sha256`;
await rm(stage, { recursive: true, force: true });
await rm(archive, { force: true });
await rm(checksumPath, { force: true });
await mkdir(join(stage, "bin"), { recursive: true });

await copyFile(process.execPath, join(stage, "bin", "node"));
await chmod(join(stage, "bin", "node"), 0o755);
await copyFile(join(root, "package.json"), join(stage, "package.json"));
await copyFile(lockfile, join(stage, "package-lock.json"));
if (await exists(join(root, "README.md"))) await copyFile(join(root, "README.md"), join(stage, "README.md"));

await copyWorkspaceFamily("packages", stage);
await copyWorkspaceFamily("apps", stage);
await cp(join(root, "node_modules"), join(stage, "node_modules"), {
  recursive: true,
  force: true,
  dereference: false,
  verbatimSymlinks: true,
});

const launcher = `#!/bin/sh\nset -eu\nSELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nROOT=$(dirname "$SELF_DIR")\nPATH="$ROOT/bin:$PATH"\nexport PATH\nexec "$ROOT/bin/node" "$ROOT/apps/runtime/dist/cli.js" "$@"\n`;
await writeFile(join(stage, "bin", "blogmaatic"), launcher, { mode: 0o755 });
await chmod(join(stage, "bin", "blogmaatic"), 0o755);

const manifest = {
  schemaVersion: 1,
  product: "Blogmaatic",
  version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  packageManager: packageJson.packageManager,
  managedRestateVersion: "1.7.10",
  entrypoint: "bin/blogmaatic",
  authorities: {
    runtime: "apps/runtime/dist/cli.js",
    controlRoom: "apps/control-room/dist/index.html",
    dependencyGraph: "package-lock.json",
  },
};
await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

await execFileAsync("tar", ["-C", artifactRoot, "-czf", archive, artifactName]);
const digest = await sha256(archive);
await writeFile(checksumPath, `${digest}  ${artifactName}.tar.gz\n`, { mode: 0o644 });

console.log(JSON.stringify({ artifactName, stage, archive, sha256: digest }));
