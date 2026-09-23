import { spawn } from "node:child_process";

import type { MutableSecretProvider } from "./index.js";

const STORED_PREFIX = "blogmaatic:v1:";
const DEFAULT_SERVICE = "com.blogmaatic.secrets";
const MAX_SECRET_BYTES = 2560;
const MAX_LOCATOR_BYTES = 512;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 16 * 1024;

export interface VaultCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VaultCommandOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type VaultCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: VaultCommandOptions,
) => Promise<VaultCommandResult>;

export interface CredentialVaultBackend {
  get(locator: string): Promise<Uint8Array | undefined>;
  set(locator: string, material: Uint8Array): Promise<void>;
  delete(locator: string): Promise<boolean>;
}

function vaultError(message: string): Error {
  return new Error(message);
}

function validateLocator(locator: string): string {
  if (!locator || Buffer.byteLength(locator, "utf8") > MAX_LOCATOR_BYTES) {
    throw new Error("Vault secret locator must be between 1 and 512 UTF-8 bytes");
  }
  return locator;
}

function encodeText(value: string): string {
  return `${STORED_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function encodeMaterial(material: Uint8Array): string {
  if (material.byteLength === 0 || material.byteLength > MAX_SECRET_BYTES) {
    throw new Error(`Vault secret must be between 1 and ${MAX_SECRET_BYTES} bytes`);
  }
  const copy = Buffer.from(material);
  try {
    return `${STORED_PREFIX}${copy.toString("base64")}`;
  } finally {
    copy.fill(0);
  }
}

function decodeMaterial(output: string): Uint8Array {
  const normalized = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n")
      ? output.slice(0, -1)
      : output;
  if (!normalized.startsWith(STORED_PREFIX)) throw vaultError("OS credential store returned invalid Blogmaatic material");
  const encoded = normalized.slice(STORED_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_SECRET_BYTES / 3) * 4 + 4) {
    throw vaultError("OS credential store returned invalid Blogmaatic material");
  }
  const bytes = Buffer.from(encoded, "base64");
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_SECRET_BYTES ||
      bytes.toString("base64") !== encoded
    ) {
      throw vaultError("OS credential store returned invalid Blogmaatic material");
    }
    return Uint8Array.from(bytes);
  } finally {
    bytes.fill(0);
  }
}

function quoteSecurityInteractive(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("Invalid macOS Keychain command value");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export const runVaultCommand: VaultCommandRunner = async (executable, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise<VaultCommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let exceededOutput = false;
    let settled = false;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer, kind: "stdout" | "stderr") => {
      const next = (kind === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      if (kind === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      if (next > maxOutputBytes) {
        exceededOutput = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, Buffer.from(chunk), "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, Buffer.from(chunk), "stderr"));
    child.stdin.on("error", () => undefined);
    child.once("error", () => finishReject(vaultError("OS credential helper could not be started")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return reject(vaultError("OS credential helper timed out"));
      if (exceededOutput) return reject(vaultError("OS credential helper exceeded its output limit"));
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdin.end(options.input ?? "");
  });
};

export class MacOsKeychainBackend implements CredentialVaultBackend {
  readonly #run: VaultCommandRunner;
  readonly #service: string;
  readonly #keychain: string;

  constructor(options: {
    readonly run?: VaultCommandRunner;
    readonly service?: string;
    readonly keychain?: string;
  } = {}) {
    this.#run = options.run ?? runVaultCommand;
    this.#service = options.service ?? DEFAULT_SERVICE;
    this.#keychain = options.keychain ?? "login.keychain-db";
    if (/[\r\n\0]/u.test(this.#service) || /[\r\n\0]/u.test(this.#keychain)) {
      throw new Error("Invalid macOS Keychain configuration");
    }
  }

  #attributes(locator: string): readonly string[] {
    return ["-s", encodeText(this.#service), "-a", encodeText(validateLocator(locator))];
  }

  async #ready(): Promise<void> {
    const result = await this.#run("/usr/bin/security", ["-q", "show-keychain-info", this.#keychain]);
    if (result.code !== 0) throw vaultError("macOS Keychain is unavailable or locked");
  }

  async get(locator: string): Promise<Uint8Array | undefined> {
    await this.#ready();
    const result = await this.#run("/usr/bin/security", [
      "-q",
      "find-generic-password",
      ...this.#attributes(locator),
      "-w",
      this.#keychain,
    ]);
    if (result.code === 44) return undefined;
    if (result.code !== 0 || result.stderr !== "") throw vaultError("macOS Keychain read failed");
    return decodeMaterial(result.stdout);
  }

  async set(locator: string, material: Uint8Array): Promise<void> {
    await this.#ready();
    const command = [
      "add-generic-password",
      "-U",
      ...this.#attributes(locator),
      "-w",
      encodeMaterial(material),
      this.#keychain,
    ].map(quoteSecurityInteractive).join(" ") + "\n";
    if (Buffer.byteLength(command, "utf8") >= 4096) {
      throw new Error("Vault secret and locator exceed the macOS Keychain command limit");
    }
    const result = await this.#run("/usr/bin/security", ["-q", "-i"], { input: command });
    if (result.code !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw vaultError("macOS Keychain write failed");
    }
  }

  async delete(locator: string): Promise<boolean> {
    await this.#ready();
    const result = await this.#run("/usr/bin/security", [
      "-q",
      "delete-generic-password",
      ...this.#attributes(locator),
      this.#keychain,
    ]);
    if (result.code === 44) return false;
    if (result.code !== 0 || result.stderr !== "") throw vaultError("macOS Keychain delete failed");
    return true;
  }
}

export class LinuxSecretServiceBackend implements CredentialVaultBackend {
  readonly #run: VaultCommandRunner;
  readonly #service: string;

  constructor(options: { readonly run?: VaultCommandRunner; readonly service?: string } = {}) {
    this.#run = options.run ?? runVaultCommand;
    this.#service = options.service ?? DEFAULT_SERVICE;
  }

  #attributes(locator: string): readonly string[] {
    return ["application", encodeText(this.#service), "locator", encodeText(validateLocator(locator))];
  }

  async get(locator: string): Promise<Uint8Array | undefined> {
    const result = await this.#run("/usr/bin/secret-tool", ["lookup", "--", ...this.#attributes(locator)]);
    if (result.code === 1 && result.stdout === "" && result.stderr === "") return undefined;
    if (result.code !== 0 || result.stderr !== "") {
      throw vaultError("Linux Secret Service read failed or is unavailable");
    }
    return decodeMaterial(result.stdout);
  }

  async set(locator: string, material: Uint8Array): Promise<void> {
    const result = await this.#run(
      "/usr/bin/secret-tool",
      ["store", "--label=Blogmaatic", "--", ...this.#attributes(locator)],
      { input: encodeMaterial(material) },
    );
    if (result.code !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw vaultError("Linux Secret Service write failed or is unavailable");
    }
  }

  async delete(locator: string): Promise<boolean> {
    const result = await this.#run("/usr/bin/secret-tool", ["clear", "--", ...this.#attributes(locator)]);
    if (result.code === 1 && result.stdout === "" && result.stderr === "") return false;
    if (result.code !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw vaultError("Linux Secret Service delete failed or is unavailable");
    }
    return true;
  }
}

export function platformCredentialVaultBackend(
  platform: NodeJS.Platform = process.platform,
  run: VaultCommandRunner = runVaultCommand,
): CredentialVaultBackend {
  if (platform === "darwin") return new MacOsKeychainBackend({ run });
  if (platform === "linux") return new LinuxSecretServiceBackend({ run });
  throw new Error(`OS credential vault is not supported on this platform: ${platform}`);
}

export class OsCredentialSecretProvider implements MutableSecretProvider {
  readonly scheme = "vault";
  readonly #backend: CredentialVaultBackend;

  constructor(backend: CredentialVaultBackend = platformCredentialVaultBackend()) {
    this.#backend = backend;
  }

  resolve(locator: string): Promise<Uint8Array | undefined> {
    return this.#backend.get(validateLocator(locator));
  }

  store(locator: string, material: Uint8Array): Promise<void> {
    return this.#backend.set(validateLocator(locator), material);
  }

  delete(locator: string): Promise<boolean> {
    return this.#backend.delete(validateLocator(locator));
  }
}
