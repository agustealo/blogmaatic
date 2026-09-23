import { DatabaseSync } from "node:sqlite";

import { validatePublicationGroup, type PublicationGroup } from "@blogmaatic/core";

import { stableJson } from "./json.js";
import { decodeCursor, encodeCursor, normalizePageLimit } from "./query.js";
import type { Page, PageRequest } from "./types.js";

export interface PublicationGroupRegistryEntry {
  readonly group: PublicationGroup;
  readonly version: number;
  readonly registeredAt: string;
  readonly activeVersion: number;
  readonly enabled: boolean;
  readonly isActiveVersion: boolean;
  readonly updatedAt: string;
}

export interface PublicationGroupListQuery extends PageRequest {
  readonly enabled?: boolean;
}

export interface PublicationGroupVersionListQuery extends PageRequest {}

export interface PublicationGroupStore {
  createPublicationGroup(
    group: PublicationGroup,
    enabled: boolean,
    createdAt: string,
  ): Promise<PublicationGroupRegistryEntry>;
  updatePublicationGroup(
    group: PublicationGroup,
    expectedVersion: number,
    enabled: boolean,
    updatedAt: string,
  ): Promise<PublicationGroupRegistryEntry>;
  setPublicationGroupEnabled(
    groupId: string,
    expectedVersion: number,
    enabled: boolean,
    updatedAt: string,
  ): Promise<PublicationGroupRegistryEntry>;
  getActivePublicationGroup(groupId: string): Promise<PublicationGroupRegistryEntry | undefined>;
  getPublicationGroupVersion(groupId: string, version: number): Promise<PublicationGroupRegistryEntry | undefined>;
  listPublicationGroups(query?: PublicationGroupListQuery): Promise<Page<PublicationGroupRegistryEntry>>;
  listPublicationGroupVersions(
    groupId: string,
    query?: PublicationGroupVersionListQuery,
  ): Promise<Page<PublicationGroupRegistryEntry>>;
  listEnabledPublicationGroupsByConnection(connectionId: string): Promise<readonly PublicationGroupRegistryEntry[]>;
}

interface GroupRow {
  readonly group_id: string;
  readonly version: number;
  readonly group_json: string;
  readonly registered_at: string;
  readonly active_version: number | null;
  readonly head_enabled: number | null;
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

function parseGroup(row: GroupRow): PublicationGroupRegistryEntry {
  const group = JSON.parse(row.group_json) as PublicationGroup;
  const activeVersion = row.active_version ?? row.version;
  const isActiveVersion = activeVersion === row.version;
  return {
    group,
    version: row.version,
    registeredAt: row.registered_at,
    activeVersion,
    enabled: isActiveVersion && row.head_enabled === 1,
    isActiveVersion,
    updatedAt: row.updated_at ?? row.registered_at,
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

export class SqlitePublicationGroupStore implements PublicationGroupStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (!path.trim()) throw new Error("SQLite publication-group path is required");
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS publication_group_versions (
        group_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        group_json TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (group_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS publication_group_heads (
        group_id TEXT PRIMARY KEY,
        active_version INTEGER NOT NULL CHECK (active_version >= 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (group_id, active_version)
          REFERENCES publication_group_versions(group_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS publication_group_routes (
        group_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        route_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        route_enabled INTEGER NOT NULL CHECK (route_enabled IN (0, 1)),
        PRIMARY KEY (group_id, version, route_id),
        FOREIGN KEY (group_id, version)
          REFERENCES publication_group_versions(group_id, version)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS publication_group_head_query_idx
        ON publication_group_heads(enabled, updated_at DESC, group_id DESC);
      CREATE INDEX IF NOT EXISTS publication_group_route_connection_idx
        ON publication_group_routes(connection_id, route_enabled, group_id, version);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite publication-group store is closed");
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

  #insertVersion(group: PublicationGroup, version: number, registeredAt: string): void {
    this.#database.prepare(`
      INSERT INTO publication_group_versions (group_id, version, group_json, registered_at)
      VALUES (?, ?, ?, ?)
    `).run(group.id, version, stableJson(group), registeredAt);

    const insertRoute = this.#database.prepare(`
      INSERT INTO publication_group_routes (
        group_id, version, route_id, extension_id, connection_id, route_enabled
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const route of group.routes) {
      insertRoute.run(
        group.id,
        version,
        route.id,
        route.destination.extensionId,
        route.destination.connectionId,
        route.enabled ? 1 : 0,
      );
    }
  }

  async createPublicationGroup(
    group: PublicationGroup,
    enabled: boolean,
    createdAt: string,
  ): Promise<PublicationGroupRegistryEntry> {
    this.#assertOpen();
    validatePublicationGroup(group);
    const groupId = requireId(group.id, "Publication group id");
    this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT 1 AS present FROM publication_group_heads WHERE group_id = ?",
      ).get(groupId) as { present: number } | undefined;
      if (existing) throw new Error(`Publication group already exists: ${groupId}`);
      this.#insertVersion(group, 1, createdAt);
      this.#database.prepare(`
        INSERT INTO publication_group_heads (group_id, active_version, enabled, updated_at)
        VALUES (?, 1, ?, ?)
      `).run(groupId, enabled ? 1 : 0, createdAt);
    });
    const created = await this.getActivePublicationGroup(groupId);
    if (!created) throw new Error(`Publication group could not be read after create: ${groupId}`);
    return created;
  }

  async updatePublicationGroup(
    group: PublicationGroup,
    expectedVersion: number,
    enabled: boolean,
    updatedAt: string,
  ): Promise<PublicationGroupRegistryEntry> {
    this.#assertOpen();
    validatePublicationGroup(group);
    const groupId = requireId(group.id, "Publication group id");
    const expected = requireVersion(expectedVersion, "Expected publication group version");
    this.#transaction(() => {
      const head = this.#database.prepare(`
        SELECT active_version FROM publication_group_heads WHERE group_id = ?
      `).get(groupId) as { active_version: number } | undefined;
      if (!head) throw new Error(`Publication group is not registered: ${groupId}`);
      if (head.active_version !== expected) {
        throw new Error(`Publication group ${groupId} changed from version ${expected} to ${head.active_version}`);
      }
      const nextVersion = expected + 1;
      this.#insertVersion(group, nextVersion, updatedAt);
      this.#database.prepare(`
        UPDATE publication_group_heads
        SET active_version = ?, enabled = ?, updated_at = ?
        WHERE group_id = ? AND active_version = ?
      `).run(nextVersion, enabled ? 1 : 0, updatedAt, groupId, expected);
    });
    const updated = await this.getActivePublicationGroup(groupId);
    if (!updated) throw new Error(`Publication group could not be read after update: ${groupId}`);
    return updated;
  }

  async setPublicationGroupEnabled(
    groupId: string,
    expectedVersion: number,
    enabled: boolean,
    updatedAt: string,
  ): Promise<PublicationGroupRegistryEntry> {
    this.#assertOpen();
    const id = requireId(groupId, "Publication group id");
    const expected = requireVersion(expectedVersion, "Expected publication group version");
    this.#transaction(() => {
      const head = this.#database.prepare(`
        SELECT h.active_version, h.enabled, v.group_json
        FROM publication_group_heads h
        JOIN publication_group_versions v
          ON v.group_id = h.group_id AND v.version = h.active_version
        WHERE h.group_id = ?
      `).get(id) as { active_version: number; enabled: number; group_json: string } | undefined;
      if (!head) throw new Error(`Publication group is not registered: ${id}`);
      if (head.active_version !== expected) {
        throw new Error(`Publication group ${id} changed from version ${expected} to ${head.active_version}`);
      }
      if ((head.enabled === 1) === enabled) return;
      const nextVersion = expected + 1;
      const group = JSON.parse(head.group_json) as PublicationGroup;
      this.#insertVersion(group, nextVersion, updatedAt);
      const result = this.#database.prepare(`
        UPDATE publication_group_heads
        SET active_version = ?, enabled = ?, updated_at = ?
        WHERE group_id = ? AND active_version = ?
      `).run(nextVersion, enabled ? 1 : 0, updatedAt, id, expected);
      if (result.changes !== 1) {
        throw new Error(`Publication group ${id} changed while activation was being updated`);
      }
    });
    const updated = await this.getActivePublicationGroup(id);
    if (!updated) throw new Error(`Publication group could not be read after activation change: ${id}`);
    return updated;
  }

  async getActivePublicationGroup(groupId: string): Promise<PublicationGroupRegistryEntry | undefined> {
    this.#assertOpen();
    const id = requireId(groupId, "Publication group id");
    const row = this.#database.prepare(`
      SELECT v.group_id, v.version, v.group_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled, h.updated_at
      FROM publication_group_heads h
      JOIN publication_group_versions v
        ON v.group_id = h.group_id AND v.version = h.active_version
      WHERE h.group_id = ?
    `).get(id) as GroupRow | undefined;
    return row ? parseGroup(row) : undefined;
  }

  async getPublicationGroupVersion(
    groupId: string,
    version: number,
  ): Promise<PublicationGroupRegistryEntry | undefined> {
    this.#assertOpen();
    const id = requireId(groupId, "Publication group id");
    const requestedVersion = requireVersion(version, "Publication group version");
    const row = this.#database.prepare(`
      SELECT v.group_id, v.version, v.group_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled, h.updated_at
      FROM publication_group_versions v
      LEFT JOIN publication_group_heads h ON h.group_id = v.group_id
      WHERE v.group_id = ? AND v.version = ?
    `).get(id, requestedVersion) as GroupRow | undefined;
    return row ? parseGroup(row) : undefined;
  }

  async listPublicationGroups(
    query: PublicationGroupListQuery = {},
  ): Promise<Page<PublicationGroupRegistryEntry>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("publication-groups", query.cursor, 2);
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.enabled !== undefined) {
      where.push("h.enabled = ?");
      values.push(query.enabled ? 1 : 0);
    }
    if (cursor) {
      where.push("(h.updated_at < ? OR (h.updated_at = ? AND h.group_id < ?))");
      values.push(cursor[0]!, cursor[0]!, cursor[1]!);
    }
    const rows = this.#database.prepare(`
      SELECT v.group_id, v.version, v.group_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled, h.updated_at
      FROM publication_group_heads h
      JOIN publication_group_versions v
        ON v.group_id = h.group_id AND v.version = h.active_version
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY h.updated_at DESC, h.group_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as GroupRow[];
    const entries = rows.map(parseGroup);
    return page(entries, limit, (entry) => encodeCursor("publication-groups", [entry.updatedAt, entry.group.id]));
  }

  async listPublicationGroupVersions(
    groupId: string,
    query: PublicationGroupVersionListQuery = {},
  ): Promise<Page<PublicationGroupRegistryEntry>> {
    this.#assertOpen();
    const id = requireId(groupId, "Publication group id");
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("publication-group-versions", query.cursor, 1);
    const values: Array<string | number> = [id];
    let cursorClause = "";
    if (cursor) {
      const version = Number(cursor[0]);
      requireVersion(version, "Publication group version cursor");
      cursorClause = "AND v.version < ?";
      values.push(version);
    }
    const rows = this.#database.prepare(`
      SELECT v.group_id, v.version, v.group_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled, h.updated_at
      FROM publication_group_versions v
      LEFT JOIN publication_group_heads h ON h.group_id = v.group_id
      WHERE v.group_id = ? ${cursorClause}
      ORDER BY v.version DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as GroupRow[];
    const entries = rows.map(parseGroup);
    return page(entries, limit, (entry) => encodeCursor("publication-group-versions", [String(entry.version)]));
  }

  async listEnabledPublicationGroupsByConnection(
    connectionId: string,
  ): Promise<readonly PublicationGroupRegistryEntry[]> {
    this.#assertOpen();
    const id = requireId(connectionId, "Connection id");
    const rows = this.#database.prepare(`
      SELECT DISTINCT v.group_id, v.version, v.group_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled, h.updated_at
      FROM publication_group_heads h
      JOIN publication_group_versions v
        ON v.group_id = h.group_id AND v.version = h.active_version
      JOIN publication_group_routes r
        ON r.group_id = h.group_id AND r.version = h.active_version
      WHERE h.enabled = 1 AND r.route_enabled = 1 AND r.connection_id = ?
      ORDER BY h.group_id ASC
    `).all(id) as unknown as GroupRow[];
    return rows.map(parseGroup);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
