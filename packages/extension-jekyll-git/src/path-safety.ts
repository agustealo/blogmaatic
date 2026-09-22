import { isAbsolute, resolve, sep } from "node:path";

export function safeSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!normalized) {
    throw new Error(`Value cannot be converted to a safe path segment: ${value}`);
  }
  return normalized;
}

export function safeRepositoryPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw new Error(`Unsafe repository-relative path: ${relativePath}`);
  }
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, ...relativePath.split("/"));
  const prefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
  if (candidate !== rootResolved && !candidate.startsWith(prefix)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return candidate;
}
