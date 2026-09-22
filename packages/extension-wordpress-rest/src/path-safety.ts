import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function approvedLocalPath(
  source: string,
  approvedRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(source)) throw new Error(`Local asset path must be absolute: ${source}`);
  if (approvedRoots.length === 0) {
    throw new Error("Local asset publication requires at least one configured assetSourceRoots entry");
  }
  const actual = await realpath(source);
  for (const root of approvedRoots) {
    const actualRoot = await realpath(resolve(root));
    const rel = relative(actualRoot, actual);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return actual;
  }
  throw new Error(`Local asset source is outside configured asset roots: ${source}`);
}
