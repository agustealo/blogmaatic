import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadRuntimeConfig, runtimePaths } from "./config.js";

export interface BackupManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly includesSecrets: false;
  readonly files: readonly BackupManifestEntry[];
}

export interface RestoreResult {
  readonly dataDir: string;
  readonly safetyCopy?: string;
}

const manifestName = "blogmaatic-backup.json";
const stateDirectoryName = "state";

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function validateRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Backup contains an unsafe path: ${path}`);
  }
}

function safeJoin(root: string, relativePath: string): string {
  validateRelativePath(relativePath);
  const full = resolve(root, ...relativePath.split("/"));
  const prefix = `${resolve(root)}${sep}`;
  if (!full.startsWith(prefix)) throw new Error(`Backup path escapes state root: ${relativePath}`);
  return full;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(350);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export async function assertRuntimeStopped(dataDir: string): Promise<void> {
  const paths = runtimePaths(dataDir);
  if (!(await exists(paths.configPath))) return;
  const config = await loadRuntimeConfig(paths.configPath);
  const localPorts = [
    [config.operator.host, config.operator.port] as const,
    [config.controlRoom.host, config.controlRoom.port] as const,
    [config.restate.workflowHost, config.restate.workflowPort] as const,
  ];
  if (config.restate.mode === "managed-local") {
    const ingress = new URL(config.restate.ingressUrl);
    const admin = new URL(config.restate.adminUrl);
    localPorts.push(
      [ingress.hostname, Number(ingress.port || "80")],
      [admin.hostname, Number(admin.port || "80")],
    );
  }
  for (const [host, port] of localPorts) {
    if (await tcpOpen(host, port)) {
      throw new Error(`Blogmaatic backup/restore requires the runtime to be stopped; ${host}:${port} is accepting connections`);
    }
  }
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(root, full));
    else if (entry.isFile()) output.push(portablePath(relative(root, full)));
  }
  return output.sort();
}

async function digest(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  const bytes = await readFile(path);
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

async function copyState(dataDir: string, stateRoot: string): Promise<void> {
  const paths = runtimePaths(dataDir);
  await copyIfPresent(paths.configPath, join(stateRoot, "runtime.json"));

  for (const filename of await readdir(paths.dataDir).catch(() => [] as string[])) {
    if (filename === basename(paths.controlPlanePath) || filename.startsWith(`${basename(paths.controlPlanePath)}-`)) {
      await copyIfPresent(join(paths.dataDir, filename), join(stateRoot, filename));
    }
    if (filename === basename(paths.projectionStatePath) || filename.startsWith(`${basename(paths.projectionStatePath)}-`)) {
      await copyIfPresent(join(paths.dataDir, filename), join(stateRoot, filename));
    }
  }

  await copyIfPresent(paths.restateDataDir, join(stateRoot, "restate"));
}

export async function createBackup(dataDir: string, outputDirectory: string, now = new Date()): Promise<BackupManifest> {
  const source = resolve(dataDir);
  const output = resolve(outputDirectory);
  if (source === output || output.startsWith(`${source}${sep}`)) {
    throw new Error("Backup output must be outside the Blogmaatic data directory");
  }
  await assertRuntimeStopped(source);
  if (!(await exists(runtimePaths(source).configPath))) throw new Error("Blogmaatic runtime configuration does not exist");
  if (await exists(output)) throw new Error(`Backup destination already exists: ${output}`);

  const temp = `${output}.tmp-${process.pid}`;
  await rm(temp, { recursive: true, force: true });
  const stateRoot = join(temp, stateDirectoryName);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  try {
    await copyState(source, stateRoot);
    const files = await walkFiles(stateRoot);
    if (!files.includes("runtime.json")) throw new Error("Backup did not capture runtime.json");
    const entries: BackupManifestEntry[] = [];
    for (const path of files) {
      const evidence = await digest(safeJoin(stateRoot, path));
      entries.push({ path, ...evidence });
    }
    const manifest: BackupManifest = {
      schemaVersion: 1,
      createdAt: now.toISOString(),
      includesSecrets: false,
      files: entries,
    };
    await writeFile(join(temp, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, output);
    return manifest;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): BackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup manifest must be an object");
  const manifest = value as Partial<BackupManifest>;
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported Blogmaatic backup schema");
  if (manifest.includesSecrets !== false) throw new Error("Backup manifest must declare includesSecrets=false");
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("Backup manifest createdAt is invalid");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Backup manifest has no files");
  const files = manifest.files.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Backup file ${index} is invalid`);
    const item = entry as Partial<BackupManifestEntry>;
    if (typeof item.path !== "string") throw new Error(`Backup file ${index} path is invalid`);
    validateRelativePath(item.path);
    if (!Number.isSafeInteger(item.size) || (item.size as number) < 0) throw new Error(`Backup file ${item.path} size is invalid`);
    if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`Backup file ${item.path} digest is invalid`);
    return { path: item.path, size: item.size as number, sha256: item.sha256 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Backup manifest contains duplicate paths");
  if (!files.some((file) => file.path === "runtime.json")) throw new Error("Backup manifest is missing runtime.json");
  return { schemaVersion: 1, createdAt: manifest.createdAt, includesSecrets: false, files };
}

export async function verifyBackup(backupDirectory: string): Promise<BackupManifest> {
  const backup = resolve(backupDirectory);
  const manifest = parseManifest(JSON.parse(await readFile(join(backup, manifestName), "utf8")) as unknown);
  const stateRoot = join(backup, stateDirectoryName);
  const actualPaths = await walkFiles(stateRoot);
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) {
    throw new Error("Backup contents do not match the manifest");
  }
  for (const file of manifest.files) {
    const evidence = await digest(safeJoin(stateRoot, file.path));
    if (evidence.size !== file.size || evidence.sha256 !== file.sha256) {
      throw new Error(`Backup integrity check failed for ${file.path}`);
    }
  }
  await loadRuntimeConfig(join(stateRoot, "runtime.json"));
  return manifest;
}

export async function restoreBackup(
  backupDirectory: string,
  dataDir: string,
  options: { readonly replace?: boolean } = {},
): Promise<RestoreResult> {
  const backup = resolve(backupDirectory);
  const target = resolve(dataDir);
  if (backup === target || backup.startsWith(`${target}${sep}`)) {
    throw new Error("Backup source must be outside the Blogmaatic data directory");
  }
  await verifyBackup(backup);
  await assertRuntimeStopped(target);

  const targetExists = await exists(target);
  if (targetExists && !options.replace) {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error(`Restore target is not empty: ${target}; pass --replace to preserve it as a safety copy`);
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${basename(target)}.restore-${process.pid}`);
  await rm(temp, { recursive: true, force: true });
  await cp(join(backup, stateDirectoryName), temp, { recursive: true, force: false, errorOnExist: true });

  let safetyCopy: string | undefined;
  try {
    if (targetExists) {
      const entries = await readdir(target);
      if (entries.length > 0) {
        safetyCopy = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await rename(target, safetyCopy);
      } else {
        await rm(target, { recursive: true, force: true });
      }
    }
    await rename(temp, target);
    await loadRuntimeConfig(runtimePaths(target).configPath);
    return { dataDir: target, ...(safetyCopy ? { safetyCopy } : {}) };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (safetyCopy && !(await exists(target)) && await exists(safetyCopy)) {
      await rename(safetyCopy, target).catch(() => undefined);
    }
    throw error;
  }
}
