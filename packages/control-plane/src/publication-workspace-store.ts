import { DatabaseSync } from "node:sqlite";

import { validatePublication, type Publication, type PublicationStatus } from "@blogmaatic/core";

import { stableJson } from "./json.js";
import { decodeCursor, encodeCursor, normalizePageLimit } from "./query.js";
import type { Page, PageRequest } from "./types.js";

export interface PublicationWorkspaceEntry {
  readonly publication: Publication;
  readonly version: number;
  readonly recordedAt: string;
  readonly updatedAt: string;
}

export interface PublicationWorkspaceListQuery extends PageRequest {
  readonly status?: PublicationStatus;
}

export interface PublicationWorkspaceStore {
  create(publication: Publication, recordedAt: string): Promise<PublicationWorkspaceEntry>;
  update(publication: Publication, expectedVersion: number, recordedAt: string): Promise<PublicationWorkspaceEntry>;
  get(publicationId: string): Promise<PublicationWorkspaceEntry | undefined>;
  getVersion(publicationId: string, version: number): Promise<PublicationWorkspaceEntry | undefined>;
  list(query?: PublicationWorkspaceListQuery): Promise<Page<PublicationWorkspaceEntry>>;
  listVersions(publicationId: string, query?: PageRequest): Promise<Page<PublicationWorkspaceEntry>>;
}

interface PublicationRow {
  readonly publication_id: string;
  readonly version: number;
  readonly publication_json: string;
  readonly recorded_at: string;
  readonly head_version: number | null;
  readonly updated_at: string | null;
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requireVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseRow(row: PublicationRow): PublicationWorkspaceEntry {
  return {
    publication: JSON.parse(row.publication_json) as Publication,
    version: row.version,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at ?? row.recorded_at,
  };
}

function page<T>(itemsWithSentinel: readonly T[], limit: number, cursorFor: (item: T) => string): Page<T> {
  const hasMore = itemsWithSentinel.length > limit;
  const items = hasMore ? itemsWithSentinel.slice(0, limit) : [...itemsWithSentinel];
  const tail = items.at(-1);
  return {
    items,
    ...(hasMore && tail !== undefined ? { nextCursor: cursorFor(tail) } : {}),
  };
}

export class SqlitePublicationWorkspaceStore implements PublicationWorkspaceStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (!path.trim()) throw new Error("SQLite Publication Workspace path is required");
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS publication_workspace_versions (
        publication_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        publication_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (publication_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS publication_workspace_heads (
        publication_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (publication_id, version)
          REFERENCES publication_workspace_versions(publication_id, version)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS publication_workspace_head_query_idx
        ON publication_workspace_heads(status, updated_at DESC, publication_id DESC);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Publication Workspace store is closed");
  }

  #transaction<T>(fn: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async create(publication: Publication, recordedAt: string): Promise<PublicationWorkspaceEntry> {
    this.#assertOpen();
    validatePublication(publication);
    const publicationId = requireId(publication.id, "Publication id");
    this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT 1 AS present FROM publication_workspace_heads WHERE publication_id = ?",
      ).get(publicationId) as { readonly present: number } | undefined;
      if (existing) throw new Error(`Publication is already registered: ${publicationId}`);
      this.#database.prepare(`
        INSERT INTO publication_workspace_versions(publication_id, version, publication_json, recorded_at)
        VALUES (?, 1, ?, ?)
      `).run(publicationId, stableJson(publication), recordedAt);
      this.#database.prepare(`
        INSERT INTO publication_workspace_heads(publication_id, version, status, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(publicationId, publication.status, recordedAt);
    });
    const created = await this.get(publicationId);
    if (!created) throw new Error(`Publication could not be read after create: ${publicationId}`);
    return created;
  }

  async update(publication: Publication, expectedVersion: number, recordedAt: string): Promise<PublicationWorkspaceEntry> {
    this.#assertOpen();
    validatePublication(publication);
    const publicationId = requireId(publication.id, "Publication id");
    const expected = requireVersion(expectedVersion, "Expected Publication Workspace version");
    this.#transaction(() => {
      const head = this.#database.prepare(
        "SELECT version FROM publication_workspace_heads WHERE publication_id = ?",
      ).get(publicationId) as { readonly version: number } | undefined;
      if (!head) throw new Error(`Publication is not registered: ${publicationId}`);
      if (head.version !== expected) {
        throw new Error(`Publication ${publicationId} changed from version ${expected} to ${head.version}`);
      }
      const nextVersion = expected + 1;
      this.#database.prepare(`
        INSERT INTO publication_workspace_versions(publication_id, version, publication_json, recorded_at)
        VALUES (?, ?, ?, ?)
      `).run(publicationId, nextVersion, stableJson(publication), recordedAt);
      const result = this.#database.prepare(`
        UPDATE publication_workspace_heads
        SET version = ?, status = ?, updated_at = ?
        WHERE publication_id = ? AND version = ?
      `).run(nextVersion, publication.status, recordedAt, publicationId, expected);
      if (result.changes !== 1) throw new Error(`Publication ${publicationId} changed during update`);
    });
    const updated = await this.get(publicationId);
    if (!updated) throw new Error(`Publication could not be read after update: ${publicationId}`);
    return updated;
  }

  async get(publicationId: string): Promise<PublicationWorkspaceEntry | undefined> {
    this.#assertOpen();
    const id = requireId(publicationId, "Publication id");
    const row = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_heads h
      JOIN publication_workspace_versions v
        ON v.publication_id = h.publication_id AND v.version = h.version
      WHERE h.publication_id = ?
    `).get(id) as PublicationRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  async getVersion(publicationId: string, version: number): Promise<PublicationWorkspaceEntry | undefined> {
    this.#assertOpen();
    const id = requireId(publicationId, "Publication id");
    const requestedVersion = requireVersion(version, "Publication Workspace version");
    const row = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_versions v
      LEFT JOIN publication_workspace_heads h ON h.publication_id = v.publication_id
      WHERE v.publication_id = ? AND v.version = ?
    `).get(id, requestedVersion) as PublicationRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  async list(query: PublicationWorkspaceListQuery = {}): Promise<Page<PublicationWorkspaceEntry>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("publication-workspace", query.cursor, 2);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.status) {
      clauses.push("h.status = ?");
      values.push(query.status);
    }
    if (cursor) {
      clauses.push("(h.updated_at < ? OR (h.updated_at = ? AND h.publication_id < ?))");
      values.push(cursor[0]!, cursor[0]!, cursor[1]!);
    }
    const rows = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_heads h
      JOIN publication_workspace_versions v
        ON v.publication_id = h.publication_id AND v.version = h.version
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY h.updated_at DESC, h.publication_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as PublicationRow[];
    const entries = rows.map(parseRow);
    return page(entries, limit, (entry) => encodeCursor("publication-workspace", [entry.updatedAt, entry.publication.id]));
  }

  async listVersions(publicationId: string, query: PageRequest = {}): Promise<Page<PublicationWorkspaceEntry>> {
    this.#assertOpen();
    const id = requireId(publicationId, "Publication id");
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("publication-workspace-versions", query.cursor, 1);
    const values: Array<string | number> = [id];
    let cursorClause = "";
    if (cursor) {
      const version = Number(cursor[0]);
      requireVersion(version, "Publication Workspace version cursor");
      cursorClause = "AND v.version < ?";
      values.push(version);
    }
    const rows = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_versions v
      LEFT JOIN publication_workspace_heads h ON h.publication_id = v.publication_id
      WHERE v.publication_id = ? ${cursorClause}
      ORDER BY v.version DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as PublicationRow[];
    const entries = rows.map(parseRow);
    return page(entries, limit, (entry) => encodeCursor("publication-workspace-versions", [String(entry.version)]));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
