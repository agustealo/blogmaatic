import { DatabaseSync } from "node:sqlite";

import type {
  ProjectionStateRecord,
  ProjectionStateStore,
  RemoteIdentity,
} from "@blogmaatic/core";

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

export class SqliteProjectionStateStore implements ProjectionStateStore {
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

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
