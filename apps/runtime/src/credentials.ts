import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface OperatorTokenResult {
  readonly token: string;
  readonly created: boolean;
}

function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error("Stored operator token is invalid");
  }
  return token;
}

async function readToken(path: string): Promise<string> {
  return validateToken(await readFile(path, "utf8"));
}

export async function ensureOperatorToken(path: string): Promise<OperatorTokenResult> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const token = await readToken(path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    return { token, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
    return { token, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { token: await readToken(path), created: false };
  }
}

export async function readOperatorToken(path: string): Promise<string> {
  return readToken(path);
}
