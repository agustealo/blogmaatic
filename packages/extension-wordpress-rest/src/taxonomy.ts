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

function requireTaxonomyRestBase(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error("WordPress taxonomy REST base contains unsupported characters");
  }
  return normalized;
}

async function findTerm(
  client: WordPressRestClient,
  taxonomy: string,
  slug: string,
): Promise<WordPressTermRecord | undefined> {
  taxonomy = requireTaxonomyRestBase(taxonomy);
  const terms = await client.requestJson<readonly WordPressTermRecord[]>(
    `/${taxonomy}?context=edit&slug=${encodeURIComponent(slug)}&per_page=100`,
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
): Promise<WordPressTermRecord> {
  taxonomy = requireTaxonomyRestBase(taxonomy);
  const name = input.name.trim();
  if (!name) throw new Error("WordPress taxonomy term name is required");
  const requestedSlug = input.slug?.trim();
  if (input.slug !== undefined && !requestedSlug) {
    throw new Error("WordPress taxonomy term slug must be non-empty when provided");
  }
  const slug = requestedSlug ?? termSlug(name);
  const existing = await findTerm(client, taxonomy, slug);
  if (existing) return existing;
  try {
    return await client.requestJson<WordPressTermRecord>(`/${taxonomy}`, {
      method: "POST",
      body: JSON.stringify({
        name,
        slug,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof WordPressHttpError && error.code === "term_exists" && error.termId) {
      return client.requestJson<WordPressTermRecord>(`/${taxonomy}/${error.termId}?context=edit`);
    }
    throw error;
  }
}

export async function resolveTerms(
  client: WordPressRestClient,
  taxonomy: string,
  names: readonly string[],
  createMissing: boolean,
): Promise<readonly number[]> {
  taxonomy = requireTaxonomyRestBase(taxonomy);
  const ids: number[] = [];
  for (const rawName of [...new Set(names.map((name) => name.trim()).filter(Boolean))]) {
    const slug = termSlug(rawName);
    const existing = await findTerm(client, taxonomy, slug);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    if (!createMissing) {
      throw new Error(`WordPress ${taxonomy.slice(0, -1)} does not exist and auto-create is disabled: ${rawName}`);
    }
    ids.push((await findOrCreateTerm(client, taxonomy, { name: rawName, slug })).id);
  }
  return ids;
}
