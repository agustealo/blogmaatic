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

async function findTerm(
  client: WordPressRestClient,
  taxonomy: "categories" | "tags",
  slug: string,
): Promise<WordPressTermRecord | undefined> {
  const terms = await client.requestJson<readonly WordPressTermRecord[]>(
    `/${taxonomy}?context=edit&slug=${encodeURIComponent(slug)}&per_page=100`,
  );
  return terms.find((term) => term.slug === slug);
}

async function createTerm(
  client: WordPressRestClient,
  taxonomy: "categories" | "tags",
  name: string,
  slug: string,
): Promise<WordPressTermRecord> {
  try {
    return await client.requestJson<WordPressTermRecord>(`/${taxonomy}`, {
      method: "POST",
      body: JSON.stringify({ name, slug }),
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
  taxonomy: "categories" | "tags",
  names: readonly string[],
  createMissing: boolean,
): Promise<readonly number[]> {
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
    ids.push((await createTerm(client, taxonomy, rawName, slug)).id);
  }
  return ids;
}
