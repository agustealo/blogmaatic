import { sha256 } from "./fingerprint.js";
import { WordPressHttpError, WordPressRestClient } from "./client.js";
import type { WordPressTermRecord } from "./types.js";

export function termSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `term-${sha256(name).slice(0, 10)}`;
}

function taxonomyRestBase(value: string): string {
  const restBase = value.trim();
  if (!restBase || !/^[a-zA-Z0-9._-]+$/.test(restBase)) {
    throw new Error("WordPress taxonomy REST base contains unsupported characters");
  }
  return restBase;
}

async function taxonomyRequest<T>(
  client: WordPressRestClient,
  restBase: string,
  path: string,
  namespace?: string,
  init: RequestInit = {},
): Promise<T> {
  return namespace && namespace.trim() && namespace.trim() !== "wp/v2"
    ? client.requestNamespaceJson<T>(namespace, path, init)
    : client.requestJson<T>(path, init);
}

async function findTerm(
  client: WordPressRestClient,
  taxonomy: string,
  slug: string,
  namespace?: string,
): Promise<WordPressTermRecord | undefined> {
  const restBase = taxonomyRestBase(taxonomy);
  const terms = await taxonomyRequest<readonly WordPressTermRecord[]>(
    client,
    restBase,
    `/${restBase}?context=edit&slug=${encodeURIComponent(slug)}&per_page=100`,
    namespace,
  );
  return terms.find((term) => term.slug === slug);
}

export async function findOrCreateTerm(
  client: WordPressRestClient,
  taxonomy: string,
  input: {
    readonly name: string;
    readonly slug?: string;
    readonly description?: string;
  },
  namespace?: string,
): Promise<WordPressTermRecord> {
  const name = input.name.trim();
  if (!name) throw new Error("WordPress taxonomy term name is required");
  const requestedSlug = input.slug?.trim();
  if (input.slug !== undefined && !requestedSlug) {
    throw new Error("WordPress taxonomy term slug must be non-empty when provided");
  }
  const slug = requestedSlug ?? termSlug(name);
  const restBase = taxonomyRestBase(taxonomy);
  const existing = await findTerm(client, restBase, slug, namespace);
  if (existing) return existing;
  try {
    return await taxonomyRequest<WordPressTermRecord>(
      client,
      restBase,
      `/${restBase}`,
      namespace,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          slug,
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        }),
      },
    );
  } catch (error) {
    if (error instanceof WordPressHttpError && error.code === "term_exists" && error.termId) {
      return taxonomyRequest<WordPressTermRecord>(
        client,
        restBase,
        `/${restBase}/${error.termId}?context=edit`,
        namespace,
      );
    }
    throw error;
  }
}

export async function resolveTerms(
  client: WordPressRestClient,
  taxonomy: string,
  names: readonly string[],
  createMissing: boolean,
  namespace?: string,
): Promise<readonly number[]> {
  const ids: number[] = [];
  for (const rawName of [...new Set(names.map((name) => name.trim()).filter(Boolean))]) {
    const slug = termSlug(rawName);
    const existing = await findTerm(client, taxonomy, slug, namespace);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    if (!createMissing) {
      throw new Error(`WordPress ${taxonomy.slice(0, -1)} does not exist and auto-create is disabled: ${rawName}`);
    }
    ids.push((await findOrCreateTerm(client, taxonomy, { name: rawName, slug }, namespace)).id);
  }
  return ids;
}
