import { DatabaseSync } from "node:sqlite";

import { validatePublication, type Publication, type PublicationStatus } from "@blogmaatic/core";

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

      CREATE INDEX IF NOT EXISTS idx_publication_workspace_heads_status_updated
        ON publication_workspace_heads(status, updated_at DESC, publication_id DESC);
    `);
  }

  async create(publication: Publication, recordedAt: string): Promise<PublicationWorkspaceEntry> {
    this.#assertOpen();
    validatePublication(publication);
    requireId(publication.id, "Publication id");
    const transaction = this.#database.transaction(() => {
      const existing = this.#database.prepare(
        "SELECT publication_id FROM publication_workspace_heads WHERE publication_id = ?",
      ).get(publication.id);
      if (existing) throw new Error(`Publication is already registered: ${publication.id}`);
      this.#database.prepare(`
        INSERT INTO publication_workspace_versions(publication_id, version, publication_json, recorded_at)
        VALUES (?, 1, ?, ?)
      `).run(publication.id, JSON.stringify(publication), recordedAt);
      this.#database.prepare(`
        INSERT INTO publication_workspace_heads(publication_id, version, status, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(publication.id, publication.status, recordedAt);
    });
    transaction();
    return { publication, version: 1, recordedAt, updatedAt: recordedAt };
  }

  async update(publication: Publication, expectedVersion: number, recordedAt: string): Promise<PublicationWorkspaceEntry> {
    this.#assertOpen();
    validatePublication(publication);
    requireId(publication.id, "Publication id");
    requireVersion(expectedVersion, "Expected Publication Workspace version");
    const nextVersion = expectedVersion + 1;
    const transaction = this.#database.transaction(() => {
      const head = this.#database.prepare(
        "SELECT version FROM publication_workspace_heads WHERE publication_id = ?",
      ).get(publication.id) as { readonly version: number } | undefined;
      if (!head) throw new Error(`Publication is not registered: ${publication.id}`);
      if (head.version !== expectedVersion) {
        throw new Error(`Publication ${publication.id} changed from version ${expectedVersion} to ${head.version}`);
      }
      this.#database.prepare(`
        INSERT INTO publication_workspace_versions(publication_id, version, publication_json, recorded_at)
        VALUES (?, ?, ?, ?)
      `).run(publication.id, nextVersion, JSON.stringify(publication), recordedAt);
      const result = this.#database.prepare(`
        UPDATE publication_workspace_heads
        SET version = ?, status = ?, updated_at = ?
        WHERE publication_id = ? AND version = ?
      `).run(nextVersion, publication.status, recordedAt, publication.id, expectedVersion);
      if (result.changes !== 1) throw new Error(`Publication ${publication.id} changed during update`);
    });
    transaction();
    return { publication, version: nextVersion, recordedAt, updatedAt: recordedAt };
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
    requireVersion(version, "Publication Workspace version");
    const row = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_versions v
      LEFT JOIN publication_workspace_heads h ON h.publication_id = v.publication_id
      WHERE v.publication_id = ? AND v.version = ?
    `).get(id, version) as PublicationRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  async list(query: PublicationWorkspaceListQuery = {}): Promise<Page<PublicationWorkspaceEntry>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor, "publication workspace") : undefined;
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (query.status) {
      clauses.push("h.status = ?");
      values.push(query.status);
    }
    if (cursor) {
      clauses.push("(h.updated_at < ? OR (h.updated_at = ? AND h.publication_id < ?))");
      values.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_heads h
      JOIN publication_workspace_versions v
        ON v.publication_id = h.publication_id AND v.version = h.version
      ${where}
      ORDER BY h.updated_at DESC, h.publication_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as PublicationRow[];
    const items = rows.map(parseRow);
    return page(items, limit, (entry) => encodeCursor({ occurredAt: entry.updatedAt, id: entry.publication.id }));
  }

  async listVersions(publicationId: string, query: PageRequest = {}): Promise<Page<PublicationWorkspaceEntry>> {
    this.#assertOpen();
    const id = requireId(publicationId, "Publication id");
    const limit = normalizePageLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor, "publication workspace versions") : undefined;
    const upperVersion = cursor ? Number(cursor.id) : undefined;
    if (upperVersion !== undefined && (!Number.isSafeInteger(upperVersion) || upperVersion < 1)) {
      throw new Error("Publication Workspace version cursor is invalid");
    }
    const rows = this.#database.prepare(`
      SELECT v.publication_id, v.version, v.publication_json, v.recorded_at,
             h.version AS head_version, h.updated_at
      FROM publication_workspace_versions v
      LEFT JOIN publication_workspace_heads h ON h.publication_id = v.publication_id
      WHERE v.publication_id = ?
        AND (? IS NULL OR v.version < ?)
      ORDER BY v.version DESC
      LIMIT ?
    `).all(id, upperVersion ?? null, upperVersion ?? null, limit + 1) as unknown as PublicationRow[];
    const items = rows.map(parseRow);
    return page(items, limit, (entry) => encodeCursor({ occurredAt: entry.recordedAt, id: String(entry.version) }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Publication Workspace store is closed");
  }
}
