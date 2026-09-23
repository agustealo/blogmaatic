import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

function candidateRoots(): string[] {
  const roots = new Set<string>();
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let current = resolve(start);
    while (true) {
      roots.add(current);
      const parent = dirname(current);
      if (parent === current || current === parse(current).root) break;
      current = parent;
    }
  }
  return [...roots];
}

export async function resolveLocalBinary(name: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid local binary name: ${name}`);
  for (const root of candidateRoots()) {
    const path = join(root, "node_modules", ".bin", name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Keep walking toward the workspace root.
    }
  }
  throw new Error(`Local binary ${name} is unavailable. Run npm install from the Blogmaatic repository root.`);
}

export async function isTcpOpen(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function waitForTcp(host: string, port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpOpen(host, port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function rolling(buffer: string, chunk: Buffer): string {
  const next = buffer + chunk.toString("utf8");
  return next.length > 64_000 ? next.slice(-64_000) : next;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

export class ManagedRestateServer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly fatal: Promise<never>;
  #closing = false;

  private constructor(child: ChildProcessWithoutNullStreams, getLog: () => string) {
    this.#child = child;
    this.fatal = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        if (!this.#closing) {
          reject(new Error(`Managed Restate server exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}): ${getLog().trim()}`));
        }
      });
    });
    void this.fatal.catch(() => undefined);
  }

  static async start(options: {
    readonly dataDir: string;
    readonly ingressHost?: string;
    readonly ingressPort?: number;
    readonly adminHost?: string;
    readonly adminPort?: number;
  }): Promise<ManagedRestateServer> {
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error("managed-local Restate is currently supported on macOS and Linux; use restate.mode=external on this platform");
    }
    const ingressHost = options.ingressHost ?? "127.0.0.1";
    const ingressPort = options.ingressPort ?? 8080;
    const adminHost = options.adminHost ?? "127.0.0.1";
    const adminPort = options.adminPort ?? 9070;
    if (await isTcpOpen(ingressHost, ingressPort) || await isTcpOpen(adminHost, adminPort)) {
      throw new Error("Managed Restate ports are already in use; refusing to attach to an unknown local runtime");
    }
    const binary = await resolveLocalBinary("restate-server");
    const child = spawn(binary, ["--base-dir", options.dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => { log = rolling(log, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { log = rolling(log, chunk); });
    const managed = new ManagedRestateServer(child, () => log);
    try {
      await Promise.race([
        Promise.all([
          waitForTcp(ingressHost, ingressPort),
          waitForTcp(adminHost, adminPort),
        ]),
        managed.fatal,
      ]);
      return managed;
    } catch (error) {
      await managed.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
    await waitForExit(this.#child, 5000);
  }
}

export async function runLocalCommand(name: string, args: readonly string[]): Promise<void> {
  const binary = await resolveLocalBinary(name);
  const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = rolling(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = rolling(stderr, chunk); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${name} failed (${result.signal ?? `code ${result.code ?? "unknown"}`}): ${(stderr || stdout).trim()}`);
  }
}
