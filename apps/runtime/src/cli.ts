#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open as openFile, readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { defaultDataDir, loadRuntimeConfig, runtimePaths, writeRuntimeConfig, type RuntimeConfig, type RuntimePaths } from "./config.js";
import { ensureOperatorToken, readOperatorToken } from "./credentials.js";
import { configForFirstRun } from "./init.js";
import { httpOrigin } from "./network.js";
import { resolveLocalBinary } from "./processes.js";
import { startRuntime } from "./runtime.js";

interface ParsedArgs {
  readonly command: string;
  readonly values: ReadonlyMap<string, string | true>;
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const values = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token ?? ""}`);
    const key = token.slice(2);
    if (!key) throw new Error("Empty option name");
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return { command, values };
}

function value(args: ParsedArgs, name: string): string | undefined {
  const result = args.values.get(name);
  return typeof result === "string" ? result : undefined;
}

function requiredValue(args: ParsedArgs, name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`--${name} is required`);
  return result;
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.values.get(name) === true;
}

function dataDir(args: ParsedArgs): string {
  return value(args, "data-dir") ?? defaultDataDir();
}

function usage(): void {
  console.log(`Blogmaatic runtime\n\nCommands:\n  init [--data-dir PATH] [--jekyll-repo PATH] [--author-name NAME] [--author-email EMAIL] [--push] [--build-verification none|bundle] [--site-base-url URL]\n  open [--data-dir PATH] [--no-browser]\n  stop [--data-dir PATH]\n  start [--data-dir PATH]\n  doctor [--data-dir PATH] [--json]\n  backup [--data-dir PATH] --output PATH\n  verify-backup --input PATH\n  restore [--data-dir PATH] --input PATH [--replace]\n  version\n\nAdvanced:\n  token [--data-dir PATH]    Print the local operator credential for an external API client. The bundled Control Room does not require this.\n\nUse \`blogmaatic open\` for normal consumer launch. On first launch it initializes an empty secure runtime automatically, then reuses a running local runtime or starts one in the background and mints a fresh one-use Control Room browser capability. Use \`blogmaatic stop\` before offline backup or restore.\n\nBackup/restore is offline-only. Backups contain durable Blogmaatic state but never the local operator credential or OS-vault secret material. Restoring on another machine may require re-entering destination credentials.\n\nThe managed local runtime binds only to loopback and owns Restate ports 8080/9070, workflow port 9080, Operator API port 4317, and Control Room port 4320.`);
}

async function productVersion(): Promise<string> {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  const visited = new Set<string>();
  for (const start of starts) {
    let current = resolve(start);
    while (!visited.has(current)) {
      visited.add(current);
      try {
        const parsed = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === "blogmaatic" && typeof parsed.version === "string") return parsed.version;
      } catch {
        // Continue toward the filesystem root.
      }
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) break;
      current = parent;
    }
  }
  throw new Error("Blogmaatic product metadata is unavailable; the installation may be incomplete");
}

async function controlRoomIndex(): Promise<string> {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../control-room/dist/index.html");
}

async function init(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  try {
    await access(paths.configPath);
    throw new Error(`Runtime configuration already exists: ${paths.configPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const jekyllRepository = value(args, "jekyll-repo");
  const authorName = value(args, "author-name");
  const authorEmail = value(args, "author-email");
  const siteBaseUrl = value(args, "site-base-url");
  const rawBuildVerification = value(args, "build-verification");
  let buildVerification: "none" | "bundle" | undefined;
  if (rawBuildVerification !== undefined) {
    if (rawBuildVerification !== "none" && rawBuildVerification !== "bundle") {
      throw new Error("--build-verification must be none or bundle");
    }
    buildVerification = rawBuildVerification;
  }
  const config = await configForFirstRun({
    ...(jekyllRepository ? { jekyllRepository } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorEmail ? { authorEmail } : {}),
    ...(flag(args, "push") ? { push: true } : {}),
    ...(buildVerification ? { buildVerification } : {}),
    ...(siteBaseUrl ? { siteBaseUrl } : {}),
  });
  await writeRuntimeConfig(paths.configPath, config);
  const credential = await ensureOperatorToken(paths.operatorTokenPath);
  console.log(`Initialized Blogmaatic runtime at ${paths.dataDir}`);
  console.log(`Config: ${paths.configPath}`);
  console.log(`Local operator authority: ${credential.created ? "created" : "present"}`);
  if (config.connections.length === 0) console.log("No publisher connection was configured. Add a real extension connection before publishing.");
  else console.log(`Configured ${config.connections.length} real publisher connection(s).`);
  console.log("Run `blogmaatic open` to launch the Control Room; browser authentication is handled by the local runtime.");
}

async function ensureConsumerRuntime(paths: RuntimePaths): Promise<{ readonly config: RuntimeConfig; readonly operatorToken: string; readonly initialized: boolean }> {
  let config: RuntimeConfig;
  let initialized = false;
  try {
    config = await loadRuntimeConfig(paths.configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = await configForFirstRun({});
    await writeRuntimeConfig(paths.configPath, config);
    initialized = true;
  }
  const credential = await ensureOperatorToken(paths.operatorTokenPath);
  return { config, operatorToken: credential.token, initialized };
}

async function start(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const config = await loadRuntimeConfig(paths.configPath);
  const token = await readOperatorToken(paths.operatorTokenPath);
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolveStop) => { resolveSignal = resolveStop; });
  const runtime = await startRuntime({ config, paths, operatorToken: token, onShutdown: resolveSignal });
  if (!flag(args, "background")) {
    console.log(`Operator API: ${runtime.operatorAddress}`);
    console.log(`Control Room: ${runtime.controlRoomLaunchAddress}`);
    console.log("Control Room authentication: one-time launch capability → HttpOnly runtime session");
  }

  const onSignal = () => resolveSignal();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await Promise.race([signal, runtime.fatal]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.close();
  }
}

async function requestLaunch(config: RuntimeConfig, operatorToken: string): Promise<string | undefined> {
  const origin = httpOrigin(config.controlRoom.host, config.controlRoom.port);
  let response: Response;
  try {
    response = await fetch(`${origin}/local/launch`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, accept: "application/json" },
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return undefined;
  }
  if (response.status === 403) {
    throw new Error("A Control Room is already running on the configured port but rejected this data directory's local launcher credential");
  }
  if (response.status === 404) {
    throw new Error("The running Control Room does not support secure reopen. Restart Blogmaatic using the current installation.");
  }
  if (response.status !== 201) {
    throw new Error(`Control Room reopen failed with HTTP ${response.status}`);
  }
  const body = await response.json() as { readonly launchAddress?: unknown };
  if (typeof body.launchAddress !== "string") throw new Error("Control Room reopen response did not contain a launch address");
  const launch = new URL(body.launchAddress);
  if (launch.origin !== origin || !launch.pathname.startsWith("/session/") || launch.search || launch.hash) {
    throw new Error("Control Room returned an invalid launch address");
  }
  return launch.toString();
}

async function requestStop(config: RuntimeConfig, operatorToken: string): Promise<boolean> {
  const origin = httpOrigin(config.controlRoom.host, config.controlRoom.port);
  let response: Response;
  try {
    response = await fetch(`${origin}/local/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, accept: "application/json" },
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return false;
  }
  if (response.status === 403) throw new Error("The running Control Room rejected this data directory's local operator credential");
  if (response.status === 404) throw new Error("The running Control Room does not support clean shutdown. Restart it using the current installation.");
  if (response.status !== 202) throw new Error(`Control Room shutdown failed with HTTP ${response.status}`);
  return true;
}

async function startBackgroundRuntime(paths: RuntimePaths): Promise<string> {
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(paths.dataDir, "runtime.log");
  const log = await openFile(logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "start",
      "--data-dir",
      paths.dataDir,
      "--background",
    ], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
  } finally {
    await log.close();
  }
  return logPath;
}

function launchDefaultBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

async function openControlRoom(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const authority = await ensureConsumerRuntime(paths);
  const { config, operatorToken } = authority;
  if (authority.initialized) console.log(`Initialized Blogmaatic for first launch at ${paths.dataDir}`);

  let launchAddress = await requestLaunch(config, operatorToken);
  let logPath: string | undefined;
  if (!launchAddress) {
    logPath = await startBackgroundRuntime(paths);
    for (let attempt = 0; attempt < 100 && !launchAddress; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      launchAddress = await requestLaunch(config, operatorToken);
    }
  }
  if (!launchAddress) {
    throw new Error(`Blogmaatic did not become ready for Control Room launch${logPath ? `; inspect ${logPath}` : ""}`);
  }

  console.log(`Control Room: ${launchAddress}`);
  if (!flag(args, "no-browser")) launchDefaultBrowser(launchAddress);
}

async function stopControlRoom(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const config = await loadRuntimeConfig(paths.configPath);
  const operatorToken = await readOperatorToken(paths.operatorTokenPath);
  const accepted = await requestStop(config, operatorToken);
  if (!accepted) {
    console.log("Blogmaatic is not running.");
    return;
  }
  const origin = httpOrigin(config.controlRoom.host, config.controlRoom.port);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    try {
      await fetch(origin, { signal: AbortSignal.timeout(250) });
    } catch {
      console.log("Blogmaatic stopped cleanly.");
      return;
    }
  }
  throw new Error("Blogmaatic accepted shutdown but the Control Room did not stop");
}

async function token(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  process.stdout.write(`${await readOperatorToken(paths.operatorTokenPath)}\n`);
}

async function backup(args: ParsedArgs): Promise<void> {
  const source = dataDir(args);
  const output = requiredValue(args, "output");
  const manifest = await createBackup(source, output);
  console.log(`Created Blogmaatic backup: ${resolve(output)}`);
  console.log(`Verified ${manifest.files.length} durable state file(s).`);
  console.log("Credentials were not exported. OS-vault secrets remain on this machine and the local operator credential is intentionally excluded.");
}

async function verifyBackupCommand(args: ParsedArgs): Promise<void> {
  const input = requiredValue(args, "input");
  const manifest = await verifyBackup(input);
  console.log(`Backup is valid: ${resolve(input)}`);
  console.log(`Created: ${manifest.createdAt}`);
  console.log(`Durable files: ${manifest.files.length}`);
  console.log("Secret material included: no");
}

async function restore(args: ParsedArgs): Promise<void> {
  const target = dataDir(args);
  const input = requiredValue(args, "input");
  const result = await restoreBackup(input, target, { replace: flag(args, "replace") });
  const credential = await ensureOperatorToken(runtimePaths(target).operatorTokenPath);
  console.log(`Restored Blogmaatic state to ${result.dataDir}`);
  if (result.safetyCopy) console.log(`Previous local state preserved at ${result.safetyCopy}`);
  console.log(`Fresh local operator authority: ${credential.created ? "created" : "present"}`);
  console.log("Run `blogmaatic doctor` before starting. If this backup moved to another machine, re-enter destination credentials whose OS-vault items are unavailable.");
}

async function doctor(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const checks: DoctorCheck[] = [];
  const run = async (name: string, operation: () => Promise<string>): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await operation() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await run("product", async () => `Blogmaatic ${await productVersion()} on ${process.platform}/${process.arch} with ${process.version}`);
  await run("config", async () => {
    const config = await loadRuntimeConfig(paths.configPath);
    return `${config.restate.mode}; ${config.connections.length} configured connection(s)`;
  });
  await run("operator-credential", async () => {
    const credential = await readOperatorToken(paths.operatorTokenPath);
    if (credential.length < 32) throw new Error("operator credential is unexpectedly short");
    return "present; Control Room proxy keeps it server-side";
  });
  await run("control-room", async () => {
    const index = await controlRoomIndex();
    await access(index, constants.R_OK);
    return index;
  });

  let managed = false;
  try {
    managed = (await loadRuntimeConfig(paths.configPath)).restate.mode === "managed-local";
  } catch {
    // The config check already carries the diagnostic.
  }
  if (managed) {
    await run("restate-server", async () => resolveLocalBinary("restate-server"));
    await run("restate-cli", async () => resolveLocalBinary("restate"));
  }

  if (flag(args, "json")) {
    console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2));
  } else {
    for (const check of checks) console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") return usage();
  if (args.command === "init") return init(args);
  if (args.command === "open") return openControlRoom(args);
  if (args.command === "stop") return stopControlRoom(args);
  if (args.command === "start") return start(args);
  if (args.command === "token") return token(args);
  if (args.command === "doctor") return doctor(args);
  if (args.command === "backup") return backup(args);
  if (args.command === "verify-backup") return verifyBackupCommand(args);
  if (args.command === "restore") return restore(args);
  if (args.command === "version" || args.command === "--version" || args.command === "-v") {
    console.log(await productVersion());
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
