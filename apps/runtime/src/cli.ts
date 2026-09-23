#!/usr/bin/env node
import { access } from "node:fs/promises";

import { defaultDataDir, loadRuntimeConfig, runtimePaths, writeRuntimeConfig } from "./config.js";
import { ensureOperatorToken, readOperatorToken } from "./credentials.js";
import { configForFirstRun } from "./init.js";
import { startRuntime } from "./runtime.js";

interface ParsedArgs {
  readonly command: string;
  readonly values: ReadonlyMap<string, string | true>;
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
  console.log(`Blogmaatic runtime\n\nCommands:\n  init [--data-dir PATH] [--jekyll-repo PATH] [--author-name NAME] [--author-email EMAIL] [--push] [--build-verification none|bundle] [--site-base-url URL]\n  start [--data-dir PATH]\n  token [--data-dir PATH]\n\nThe managed local runtime binds only to loopback and owns Restate ports 8080/9070, workflow port 9080, Operator API port 4317, and Control Room port 4320.`);
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
  const buildVerification = value(args, "build-verification");
  if (buildVerification && buildVerification !== "none" && buildVerification !== "bundle") {
    throw new Error("--build-verification must be none or bundle");
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
  console.log(`Operator credential: ${paths.operatorTokenPath}${credential.created ? " (created)" : ""}`);
  if (config.connections.length === 0) console.log("No publisher connection was configured. Add a real extension connection before publishing.");
  else console.log(`Configured ${config.connections.length} real publisher connection(s).`);
  console.log("Use `npm run runtime:token -- --data-dir <path>` when you need to paste the local operator credential into the Control Room.");
}

async function start(args: ParsedArgs): Promise<void> {
  const paths = runtimePaths(dataDir(args));
  const config = await loadRuntimeConfig(paths.configPath);
  const token = await readOperatorToken(paths.operatorTokenPath);
  const runtime = await startRuntime({ config, paths, operatorToken: token });
  console.log(`Operator API: ${runtime.operatorAddress}`);
  console.log(`Control Room: ${runtime.controlRoomAddress}`);
  console.log(`Credential file: ${paths.operatorTokenPath}`);

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h") return usage();
  if (args.command === "init") return init(args);
  if (args.command === "start") return start(args);
  if (args.command === "token") return token(args);
  throw new Error(`Unknown command: ${args.command}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
