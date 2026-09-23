import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const signed = process.argv.includes("--signed");
const adhocSigned = process.argv.includes("--adhoc-signed");
if (signed && adhocSigned) throw new Error("Choose exactly one macOS signing mode: --signed or --adhoc-signed");

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function stageRoot(version) {
  const artifactRoot = resolve(process.env.BLOGMAATIC_ARTIFACT_DIR ?? join(root, "artifacts"));
  const name = `blogmaatic-${version}-${process.platform}-${process.arch}`;
  const path = join(artifactRoot, name);
  if (!(await exists(path))) {
    throw new Error(`Portable distribution stage is missing: ${path}. Run distribution:stage first.`);
  }
  return { artifactRoot, name, path };
}

async function machoFiles(rootPath) {
  const results = [];
  const visit = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const result = await execFileAsync("file", [candidate], { encoding: "utf8" });
      if (result.stdout.includes("Mach-O")) results.push(candidate);
    }
  };
  await visit(rootPath);
  return results.sort((a, b) => b.length - a.length || b.localeCompare(a));
}

async function signMacPayload(payload, { identity, timestamp }) {
  const files = await machoFiles(payload);
  if (files.length === 0) throw new Error("No Mach-O executables were found in the macOS payload");
  const nodePath = resolve(payload, "opt", "blogmaatic", "bin", "node");
  const nodeEntitlements = resolve(root, "packaging", "macos", "node-entitlements.plist");
  if (!(await exists(nodeEntitlements))) throw new Error(`Node entitlements are missing: ${nodeEntitlements}`);

  for (const path of files) {
    const args = ["--force", "--options", "runtime"];
    if (timestamp) args.push("--timestamp");
    if (resolve(path) === nodePath) args.push("--entitlements", nodeEntitlements);
    args.push("--sign", identity, path);
    await execFileAsync("codesign", args, { encoding: "utf8" });
    await execFileAsync("codesign", ["--verify", "--strict", "--verbose=2", path], { encoding: "utf8" });
  }

  const nodeDetails = await execFileAsync("codesign", ["--display", "--verbose=4", "--entitlements", ":-", nodePath], { encoding: "utf8" });
  const diagnostic = `${nodeDetails.stdout}\n${nodeDetails.stderr}`;
  if (!diagnostic.includes("runtime") || !diagnostic.includes("com.apple.security.cs.allow-jit")) {
    throw new Error(`Bundled Node is missing Hardened Runtime/JIT signing authority: ${diagnostic}`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = String(packageJson.version ?? "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Root package version is not release-safe: ${version}`);
}

const { artifactRoot, name, path: portableStage } = await stageRoot(version);
const payload = join(artifactRoot, `${name}-native-root`);
await rm(payload, { recursive: true, force: true });
await mkdir(join(payload, "opt"), { recursive: true });
await cp(portableStage, join(payload, "opt", "blogmaatic"), {
  recursive: true,
  force: true,
  dereference: false,
  verbatimSymlinks: true,
});
await mkdir(join(payload, "usr", "local", "bin"), { recursive: true });
const nativeLauncher = join(payload, "usr", "local", "bin", "blogmaatic");
await writeFile(nativeLauncher, [
  "#!/bin/sh",
  "set -eu",
  "exec /opt/blogmaatic/bin/blogmaatic \"$@\"",
  "",
].join("\n"), { mode: 0o755 });
await chmod(nativeLauncher, 0o755);

let output;
if (process.platform === "linux") {
  if (signed || adhocSigned) throw new Error("macOS signing modes are not valid for Linux packages");
  const controlDir = join(payload, "DEBIAN");
  await mkdir(controlDir, { recursive: true });
  const architecture = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  if (!architecture) throw new Error(`Unsupported Debian architecture: ${process.arch}`);
  await writeFile(join(controlDir, "control"), [
    "Package: blogmaatic",
    `Version: ${version}`,
    "Section: web",
    "Priority: optional",
    `Architecture: ${architecture}`,
    "Maintainer: Agustealo Johnson <8550514+agustealo@users.noreply.github.com>",
    "Depends: git, ca-certificates",
    "Homepage: https://github.com/agustealo/blogmaatic",
    "Description: Publication automation control plane runtime and Control Room",
    " Blogmaatic connects publishing destinations through durable automation workflows.",
    "",
  ].join("\n"), { mode: 0o644 });
  output = join(artifactRoot, `blogmaatic-${version}-${architecture}.deb`);
  await rm(output, { force: true });
  await execFileAsync("dpkg-deb", ["--build", "--root-owner-group", payload, output], { encoding: "utf8" });
} else if (process.platform === "darwin") {
  if (signed) {
    const applicationIdentity = process.env.APPLE_DEVELOPER_ID_APPLICATION?.trim();
    if (!applicationIdentity) throw new Error("APPLE_DEVELOPER_ID_APPLICATION is required for signed macOS packaging");
    await signMacPayload(payload, { identity: applicationIdentity, timestamp: true });
  } else if (adhocSigned) {
    await signMacPayload(payload, { identity: "-", timestamp: false });
  }

  output = join(artifactRoot, `blogmaatic-${version}-macos-${process.arch}.pkg`);
  await rm(output, { force: true });
  const args = [
    "--root", payload,
    "--identifier", "com.blogmaatic.runtime",
    "--version", version,
    "--install-location", "/",
  ];
  if (signed) {
    const installerIdentity = process.env.APPLE_DEVELOPER_ID_INSTALLER?.trim();
    if (!installerIdentity) throw new Error("APPLE_DEVELOPER_ID_INSTALLER is required for signed macOS packaging");
    args.push("--sign", installerIdentity);
  }
  args.push(output);
  await execFileAsync("pkgbuild", args, { encoding: "utf8" });
  if (signed) {
    const signature = await execFileAsync("pkgutil", ["--check-signature", output], { encoding: "utf8" });
    if (!signature.stdout.includes("Developer ID Installer")) {
      throw new Error(`macOS installer does not have a Developer ID Installer signature: ${signature.stdout}`);
    }
  }
} else {
  throw new Error(`Native package generation is not supported on ${process.platform}`);
}

const digest = await sha256(output);
await writeFile(`${output}.sha256`, `${digest}  ${basename(output)}\n`, { mode: 0o644 });
await rm(payload, { recursive: true, force: true });
console.log(JSON.stringify({
  output,
  sha256: digest,
  payloadSigning: signed ? "developer-id" : adhocSigned ? "adhoc-hardened" : "none",
  installerSigned: process.platform === "darwin" && signed,
}));
