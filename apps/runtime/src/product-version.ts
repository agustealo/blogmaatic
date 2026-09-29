import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function productVersion(): Promise<string> {
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
