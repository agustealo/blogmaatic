import "./suppress-warning.js";
import { DatabaseSync } from "node:sqlite";

import type {
  DistributionHistoryPage,
  DistributionHistoryQuery,
  DistributionHistoryRecord,
  DistributionHistoryStore,
  ProjectionStateRecord,
  ProjectionStateStore,
  RemoteIdentity,
} from "@blogmaatic/core";

interface DistributionRow {
  readonly history_id: string;
  readonly run_id: string | null;
  readonly publication_id: string;
  readonly revision_id: string;
  readonly group_id: string;
  readonly route_id: string;
  readonly projection_id: string;
  readonly extension_id: string;
  readonly connection_id: string;
  readonly channel: string;
  readonly group_json: string;
  readonly receipt_json: string;
  readonly recorded_at: string;
}

interface StateRow {
  readonly publication_id: string;
  readonly route_id: string;
  readonly projection_id: string;
  readonly extension_id: string;
  readonly connection_id: string;
  readonly source_revision_id: string;
  readonly desired_fingerprint: string;
  readonly remote_id: string;
  readonly remote_url: string | null;
  readonly remote_version: string | null;
  readonly updated_at: string;
}

function remoteFromRow(row: StateRow): RemoteIdentity {
  return {
    id: row.remote_id,
    ...(row.remote_url ? { url: row.remote_url } : {}),
    ...(row.remote_version ? { version: row.remote_version } : {}),
  };
}

function historyLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("Distribution history limit must be an integer from 1 through 200");
  }
  return value;
}

function encodeHistoryCursor(record: DistributionHistoryRecord): string {
  return Buffer.from(JSON.stringify([record.recordedAt, record.id]), "utf8").toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): readonly [string, string] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !parsed[0].trim() ||
      !parsed[1].trim()
    ) {
      throw new Error("invalid");
    }
    return [parsed[0], parsed[1]];
  } catch {
    throw new Error("Invalid distribution history cursor");
  }
}

function distributionFromRow(row: DistributionRow): DistributionHistoryRecord {
  return {
    id: row.history_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    publicationId: row.publication_id,
    revisionId: row.revision_id,
    groupId: row.group_id,
    routeId: row.route_id,
    projectionId: row.projection_id,
    destination: {
      extensionId: row.extension_id,
      connectionId: row.connection_id,
      channel: row.channel,
    },
    groupSnapshot: JSON.parse(row.group_json) as DistributionHistoryRecord["groupSnapshot"],
    receipt: JSON.parse(row.receipt_json) as DistributionHistoryRecord["receipt"],
    recordedAt: row.recorded_at,
  };
}

export class SqliteProjectionStateStore implements ProjectionStateStore, DistributionHistoryStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (!path.trim()) throw new Error("SQLite projection state path is required");
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projection_state (
        publication_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        desired_fingerprint TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        remote_url TEXT,
        remote_version TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (publication_id, route_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS projection_state_remote_idx
        ON projection_state(extension_id, connection_id, remote_id);

      CREATE TABLE IF NOT EXISTS publication_distribution_history (
        history_id TEXT PRIMARY KEY,
        run_id TEXT,
        publication_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        group_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS publication_distribution_history_query_idx
        ON publication_distribution_history(publication_id, recorded_at DESC, history_id DESC);
      CREATE INDEX IF NOT EXISTS publication_distribution_history_revision_idx
        ON publication_distribution_history(publication_id, revision_id, recorded_at DESC, history_id DESC);
      CREATE INDEX IF NOT EXISTS publication_distribution_history_remote_idx
        ON publication_distribution_history(extension_id, connection_id, route_id, recorded_at DESC);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite projection state store is closed");
  }

  async get(publicationId: string, routeId: string): Promise<ProjectionStateRecord | undefined> {
    this.#assertOpen();
    const statement = this.#database.prepare(`
      SELECT publication_id, route_id, projection_id, extension_id, connection_id,
             source_revision_id, desired_fingerprint, remote_id, remote_url,
             remote_version, updated_at
      FROM projection_state
      WHERE publication_id = ? AND route_id = ?
    `);
    const row = statement.get(publicationId, routeId) as StateRow | undefined;
    if (!row) return undefined;
    return {
      publicationId: row.publication_id,
      routeId: row.route_id,
      projectionId: row.projection_id,
      extensionId: row.extension_id,
      connectionId: row.connection_id,
      sourceRevisionId: row.source_revision_id,
      desiredFingerprint: row.desired_fingerprint,
      remote: remoteFromRow(row),
      updatedAt: row.updated_at,
    };
  }

  async put(record: ProjectionStateRecord): Promise<void> {
    this.#assertOpen();
    const statement = this.#database.prepare(`
      INSERT INTO projection_state (
        publication_id, route_id, projection_id, extension_id, connection_id,
        source_revision_id, desired_fingerprint, remote_id, remote_url,
        remote_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id, route_id) DO UPDATE SET
        projection_id = excluded.projection_id,
        extension_id = excluded.extension_id,
        connection_id = excluded.connection_id,
        source_revision_id = excluded.source_revision_id,
        desired_fingerprint = excluded.desired_fingerprint,
        remote_id = excluded.remote_id,
        remote_url = excluded.remote_url,
        remote_version = excluded.remote_version,
        updated_at = excluded.updated_at
    `);
    statement.run(
      record.publicationId,
      record.routeId,
      record.projectionId,
      record.extensionId,
      record.connectionId,
      record.sourceRevisionId,
      record.desiredFingerprint,
      record.remote.id,
      record.remote.url ?? null,
      record.remote.version ?? null,
      record.updatedAt,
    );
  }

  async delete(publicationId: string, routeId: string): Promise<void> {
    this.#assertOpen();
    const statement = this.#database.prepare(
      "DELETE FROM projection_state WHERE publication_id = ? AND route_id = ?",
    );
    statement.run(publicationId, routeId);
  }

  async append(record: DistributionHistoryRecord): Promise<void> {
    this.#assertOpen();
    if (!record.id.trim()) throw new Error("Distribution history id is required");
    if (!record.publicationId.trim() || !record.revisionId.trim()) {
      throw new Error("Distribution history publication and revision ids are required");
    }
    this.#database.prepare(`
      INSERT OR IGNORE INTO publication_distribution_history (
        history_id, run_id, publication_id, revision_id, group_id, route_id,
        projection_id, extension_id, connection_id, channel, group_json,
        receipt_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.runId ?? null,
      record.publicationId,
      record.revisionId,
      record.groupId,
      record.routeId,
      record.projectionId,
      record.destination.extensionId,
      record.destination.connectionId,
      record.destination.channel,
      JSON.stringify(record.groupSnapshot),
      JSON.stringify(record.receipt),
      record.recordedAt,
    );
  }

  async list(
    publicationId: string,
    query: DistributionHistoryQuery = {},
  ): Promise<DistributionHistoryPage> {
    this.#assertOpen();
    if (!publicationId.trim()) throw new Error("Publication id is required");
    const limit = historyLimit(query.limit);
    const cursor = decodeHistoryCursor(query.cursor);
    const where = ["publication_id = ?"];
    const values: Array<string | number> = [publicationId];
    if (query.revisionId) {
      where.push("revision_id = ?");
      values.push(query.revisionId);
    }
    if (query.routeId) {
      where.push("route_id = ?");
      values.push(query.routeId);
    }
    if (cursor) {
      where.push("(recorded_at < ? OR (recorded_at = ? AND history_id < ?))");
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.#database.prepare(`
      SELECT history_id, run_id, publication_id, revision_id, group_id, route_id,
             projection_id, extension_id, connection_id, channel, group_json,
             receipt_json, recorded_at
      FROM publication_distribution_history
      WHERE ${where.join(" AND ")}
      ORDER BY recorded_at DESC, history_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as DistributionRow[];
    const records = rows.map(distributionFromRow);
    const hasMore = records.length > limit;
    const items = hasMore ? records.slice(0, limit) : records;
    const tail = items.at(-1);
    return {
      items,
      ...(hasMore && tail ? { nextCursor: encodeHistoryCursor(tail) } : {}),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
