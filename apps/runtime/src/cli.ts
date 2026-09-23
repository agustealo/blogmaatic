#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultDataDir, loadRuntimeConfig, runtimePaths, writeRuntimeConfig } from "./config.js";
import { ensureOperatorToken, readOperatorToken } from "./credentials.js";
import { configForFirstRun } from "./init.js";
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

function flag(args: ParsedArgs, name: string): boolean {
  return args.values.get(name) === true;
}

function dataDir(args: ParsedArgs): string {
  return value(args, "data-dir") ?? defaultDataDir();
}

function usage(): void {
  console.log(`Blogmaatic runtime\n\nCommands:\n  init [--data-dir PATH] [--jekyll-repo PATH] [--author-name NAME] [--author-email EMAIL] [--push] [--build-verification none|bundle] [--site-base-url URL]\n  start [--data-dir PATH]\n  doctor [--data-dir PATH] [--json]\n  version\n\nAdvanced:\n  token [--data-dir PATH]    Print the local operator credential for an external API client. The bundled Control Room does not require this.\n\nThe managed local runtime binds only to loopback and owns Restate ports 8080/9070, workflow port 9080, Operator API port 4317, and Control Room port 4320.`);
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
  console.log("Start Blogmaatic and open the one-time Control Room launch URL; browser authentication is handled by the local runtime.");
}

async function start(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const config = await loadRuntimeConfig(paths.configPath);
  const token = await readOperatorToken(paths.operatorTokenPath);
  const runtime = await startRuntime({ config, paths, operatorToken: token });
  console.log(`Operator API: ${runtime.operatorAddress}`);
  console.log(`Control Room: ${runtime.controlRoomLaunchAddress}`);
  console.log("Control Room authentication: one-time launch capability → HttpOnly runtime session");

  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolveStop) => { resolveSignal = resolveStop; });
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

async function token(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  process.stdout.write(`${await readOperatorToken(paths.operatorTokenPath)}\n`);
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
  if (args.command === "start") return start(args);
  if (args.command === "token") return token(args);
  if (args.command === "doctor") return doctor(args);
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
