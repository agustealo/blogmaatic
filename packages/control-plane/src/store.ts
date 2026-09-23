import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  validateAutomationDefinition,
  type AutomationDefinition,
  type AutomationRunRequest,
  type AutomationRunStatus,
} from "@blogmaatic/automation";

import { stableJson } from "./json.js";
import { decodeCursor, encodeCursor, normalizePageLimit } from "./query.js";
import { canonicalInstant } from "./schedule.js";
import type {
  AuditLedgerEntry,
  AuditLedgerInput,
  AuditListQuery,
  AutomationListQuery,
  AutomationRegistryEntry,
  AutomationSchedule,
  AutomationVersionListQuery,
  ControlPlaneRunRecord,
  ControlPlaneStore,
  ControlPlaneTriggerEvidence,
  Page,
  RunListQuery,
  ScheduleClaim,
  ScheduleListQuery,
} from "./types.js";

interface VersionRow {
  readonly automation_id: string;
  readonly version: number;
  readonly definition_json: string;
  readonly registered_at: string;
  readonly active_version: number | null;
  readonly head_enabled: number | null;
}

interface RunRow {
  readonly run_id: string;
  readonly trigger_key: string;
  readonly request_json: string;
  readonly dispatch_state: "prepared" | "started" | "launch_failed";
  readonly runtime_id: string | null;
  readonly runtime_phase: AutomationRunStatus["phase"] | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ScheduleRow {
  readonly schedule_id: string;
  readonly schedule_json: string;
  readonly enabled: number;
  readonly next_fire_at: string | null;
  readonly last_fire_at: string | null;
  readonly claim_token: string | null;
  readonly claim_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AuditRow {
  readonly audit_id: string;
  readonly correlation_id: string;
  readonly phase: AuditLedgerEntry["phase"];
  readonly actor_id: string;
  readonly actor_kind: AuditLedgerEntry["actor"]["kind"];
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly evidence_json: string;
  readonly occurred_at: string;
}

function parseDefinition(row: VersionRow): AutomationRegistryEntry {
  const stored = JSON.parse(row.definition_json) as AutomationDefinition;
  const isActiveVersion = row.active_version === row.version;
  const enabled = isActiveVersion && row.head_enabled === 1;
  return {
    definition: { ...stored, enabled },
    registeredAt: row.registered_at,
    activeVersion: row.active_version ?? row.version,
    enabled,
    isActiveVersion,
  };
}

function parseRun(row: RunRow): ControlPlaneRunRecord {
  return {
    runId: row.run_id,
    triggerKey: row.trigger_key,
    request: JSON.parse(row.request_json) as AutomationRunRequest,
    dispatchState: row.dispatch_state,
    ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
    ...(row.runtime_phase ? { runtimePhase: row.runtime_phase } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSchedule(row: ScheduleRow): AutomationSchedule {
  const stored = JSON.parse(row.schedule_json) as AutomationSchedule;
  return {
    ...stored,
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
    ...(row.last_fire_at ? { lastFireAt: row.last_fire_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAudit(row: AuditRow): AuditLedgerEntry {
  return {
    id: row.audit_id,
    correlationId: row.correlation_id,
    phase: row.phase,
    actor: { id: row.actor_id, kind: row.actor_kind },
    action: row.action,
    resource: { type: row.resource_type, id: row.resource_id },
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    evidence: JSON.parse(row.evidence_json) as AuditLedgerEntry["evidence"],
    occurredAt: row.occurred_at,
  };
}

function triggerDiscriminator(definition: AutomationDefinition): string | null {
  if (definition.trigger.kind === "event") return definition.trigger.eventType;
  if (definition.trigger.kind === "schedule") return definition.trigger.scheduleId ?? null;
  return null;
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

export class SqliteControlPlaneStore implements ControlPlaneStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (!path.trim()) throw new Error("SQLite control-plane path is required");
    this.#database = new DatabaseSync(path, { timeout: 5000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS automation_versions (
        automation_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_discriminator TEXT,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (automation_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_heads (
        automation_id TEXT PRIMARY KEY,
        active_version INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (automation_id, active_version)
          REFERENCES automation_versions(automation_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS automation_trigger_idx
        ON automation_versions(trigger_kind, trigger_discriminator, automation_id, version);

      CREATE TABLE IF NOT EXISTS trigger_inbox (
        trigger_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_runs (
        run_id TEXT PRIMARY KEY,
        trigger_key TEXT NOT NULL,
        automation_id TEXT NOT NULL,
        automation_version INTEGER NOT NULL,
        publication_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('prepared', 'started', 'launch_failed')),
        runtime_id TEXT,
        runtime_phase TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (trigger_key) REFERENCES trigger_inbox(trigger_key),
        FOREIGN KEY (automation_id, automation_version)
          REFERENCES automation_versions(automation_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS automation_runs_trigger_idx
        ON automation_runs(trigger_key, created_at, run_id);
      CREATE INDEX IF NOT EXISTS automation_runs_query_idx
        ON automation_runs(created_at DESC, run_id DESC, automation_id, publication_id);

      CREATE TABLE IF NOT EXISTS automation_schedules (
        schedule_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        automation_version INTEGER NOT NULL,
        schedule_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        next_fire_at TEXT,
        last_fire_at TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (automation_id, automation_version)
          REFERENCES automation_versions(automation_id, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS automation_schedule_due_idx
        ON automation_schedules(enabled, next_fire_at, claim_expires_at);
      CREATE INDEX IF NOT EXISTS automation_schedule_query_idx
        ON automation_schedules(updated_at DESC, schedule_id DESC);

      CREATE TABLE IF NOT EXISTS audit_ledger (
        audit_id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('intent', 'succeeded', 'failed')),
        actor_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'integration', 'system')),
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        request_id TEXT,
        run_id TEXT,
        evidence_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_ledger_order_idx
        ON audit_ledger(occurred_at DESC, audit_id DESC);
      CREATE INDEX IF NOT EXISTS audit_ledger_correlation_idx
        ON audit_ledger(correlation_id, occurred_at, audit_id);
      CREATE INDEX IF NOT EXISTS audit_ledger_resource_idx
        ON audit_ledger(resource_type, resource_id, occurred_at DESC);
    `);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLite control-plane store is closed");
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

  async registerAutomation(definition: AutomationDefinition, registeredAt: string): Promise<void> {
    this.#assertOpen();
    validateAutomationDefinition(definition);
    const definitionJson = stableJson(definition);
    this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT definition_json FROM automation_versions
        WHERE automation_id = ? AND version = ?
      `).get(definition.id, definition.version) as { definition_json: string } | undefined;
      if (existing && existing.definition_json !== definitionJson) {
        throw new Error(`Automation ${definition.id} version ${definition.version} is immutable`);
      }
      if (!existing) {
        this.#database.prepare(`
          INSERT INTO automation_versions (
            automation_id, version, definition_json, trigger_kind, trigger_discriminator, registered_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          definition.id,
          definition.version,
          definitionJson,
          definition.trigger.kind,
          triggerDiscriminator(definition),
          registeredAt,
        );
      }

      const head = this.#database.prepare(`
        SELECT active_version, enabled FROM automation_heads WHERE automation_id = ?
      `).get(definition.id) as { active_version: number; enabled: number } | undefined;
      if (definition.enabled) {
        this.#database.prepare(`
          INSERT INTO automation_heads (automation_id, active_version, enabled, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(automation_id) DO UPDATE SET
            active_version = excluded.active_version,
            enabled = 1,
            updated_at = excluded.updated_at
        `).run(definition.id, definition.version, registeredAt);
      } else if (!head) {
        this.#database.prepare(`
          INSERT INTO automation_heads (automation_id, active_version, enabled, updated_at)
          VALUES (?, ?, 0, ?)
        `).run(definition.id, definition.version, registeredAt);
      }
    });
  }

  async activateAutomation(automationId: string, version: number, enabled: boolean, updatedAt: string): Promise<void> {
    this.#assertOpen();
    const exists = this.#database.prepare(`
      SELECT 1 AS present FROM automation_versions WHERE automation_id = ? AND version = ?
    `).get(automationId, version) as { present: number } | undefined;
    if (!exists) throw new Error(`Automation ${automationId} version ${version} is not registered`);
    this.#database.prepare(`
      INSERT INTO automation_heads (automation_id, active_version, enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(automation_id) DO UPDATE SET
        active_version = excluded.active_version,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(automationId, version, enabled ? 1 : 0, updatedAt);
  }

  async getActiveAutomation(automationId: string): Promise<AutomationRegistryEntry | undefined> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT v.automation_id, v.version, v.definition_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled
      FROM automation_heads h
      JOIN automation_versions v
        ON v.automation_id = h.automation_id AND v.version = h.active_version
      WHERE h.automation_id = ?
    `).get(automationId) as VersionRow | undefined;
    return row ? parseDefinition(row) : undefined;
  }

  async getAutomationVersion(automationId: string, version: number): Promise<AutomationRegistryEntry | undefined> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT v.automation_id, v.version, v.definition_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled
      FROM automation_versions v
      LEFT JOIN automation_heads h ON h.automation_id = v.automation_id
      WHERE v.automation_id = ? AND v.version = ?
    `).get(automationId, version) as VersionRow | undefined;
    return row ? parseDefinition(row) : undefined;
  }

  async listActiveEventAutomations(eventType: string): Promise<readonly AutomationRegistryEntry[]> {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT v.automation_id, v.version, v.definition_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled
      FROM automation_heads h
      JOIN automation_versions v
        ON v.automation_id = h.automation_id AND v.version = h.active_version
      WHERE h.enabled = 1 AND v.trigger_kind = 'event' AND v.trigger_discriminator = ?
      ORDER BY v.automation_id
    `).all(eventType) as unknown as VersionRow[];
    return rows.map(parseDefinition);
  }

  async listAutomations(query: AutomationListQuery = {}): Promise<Page<AutomationRegistryEntry>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("automations", query.cursor, 1);
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.enabled !== undefined) {
      where.push("h.enabled = ?");
      values.push(query.enabled ? 1 : 0);
    }
    if (cursor) {
      where.push("h.automation_id > ?");
      values.push(cursor[0]!);
    }
    const rows = this.#database.prepare(`
      SELECT v.automation_id, v.version, v.definition_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled
      FROM automation_heads h
      JOIN automation_versions v
        ON v.automation_id = h.automation_id AND v.version = h.active_version
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY h.automation_id ASC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as VersionRow[];
    const entries = rows.map(parseDefinition);
    return page(entries, limit, (entry) => encodeCursor("automations", [entry.definition.id]));
  }

  async listAutomationVersions(
    automationId: string,
    query: AutomationVersionListQuery = {},
  ): Promise<Page<AutomationRegistryEntry>> {
    this.#assertOpen();
    if (!automationId.trim()) throw new Error("Automation id is required");
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("automation-versions", query.cursor, 1);
    const values: Array<string | number> = [automationId];
    let cursorClause = "";
    if (cursor) {
      const version = Number(cursor[0]);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("Automation version cursor is invalid");
      cursorClause = "AND v.version < ?";
      values.push(version);
    }
    const rows = this.#database.prepare(`
      SELECT v.automation_id, v.version, v.definition_json, v.registered_at,
             h.active_version, h.enabled AS head_enabled
      FROM automation_versions v
      LEFT JOIN automation_heads h ON h.automation_id = v.automation_id
      WHERE v.automation_id = ? ${cursorClause}
      ORDER BY v.version DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as VersionRow[];
    const entries = rows.map(parseDefinition);
    return page(entries, limit, (entry) => encodeCursor("automation-versions", [String(entry.definition.version)]));
  }

  async reserveRuns(
    trigger: ControlPlaneTriggerEvidence,
    requests: readonly AutomationRunRequest[],
    createdAt: string,
  ): Promise<readonly ControlPlaneRunRecord[]> {
    this.#assertOpen();
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT 1 AS present FROM trigger_inbox WHERE trigger_key = ?",
      ).get(trigger.key) as { present: number } | undefined;
      if (!existing) {
        this.#database.prepare(`
          INSERT INTO trigger_inbox (trigger_key, kind, evidence_json, received_at)
          VALUES (?, ?, ?, ?)
        `).run(trigger.key, trigger.kind, stableJson(trigger.payload), createdAt);

        const insert = this.#database.prepare(`
          INSERT INTO automation_runs (
            run_id, trigger_key, automation_id, automation_version,
            publication_id, revision_id, request_json, dispatch_state,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
        `);
        for (const request of requests) {
          insert.run(
            request.runId,
            trigger.key,
            request.definition.id,
            request.definition.version,
            request.publication.id,
            request.publication.current.id,
            stableJson(request),
            createdAt,
            createdAt,
          );
        }
      }
      return this.#runsForTrigger(trigger.key);
    });
  }

  #runsForTrigger(triggerKey: string): readonly ControlPlaneRunRecord[] {
    const rows = this.#database.prepare(`
      SELECT run_id, trigger_key, request_json, dispatch_state, runtime_id,
             runtime_phase, last_error, created_at, updated_at
      FROM automation_runs WHERE trigger_key = ? ORDER BY created_at, run_id
    `).all(triggerKey) as unknown as RunRow[];
    return rows.map(parseRun);
  }

  async getRun(runId: string): Promise<ControlPlaneRunRecord | undefined> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT run_id, trigger_key, request_json, dispatch_state, runtime_id,
             runtime_phase, last_error, created_at, updated_at
      FROM automation_runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row ? parseRun(row) : undefined;
  }

  async listRuns(query: RunListQuery = {}): Promise<Page<ControlPlaneRunRecord>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("runs", query.cursor, 2);
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.automationId) { where.push("automation_id = ?"); values.push(query.automationId); }
    if (query.publicationId) { where.push("publication_id = ?"); values.push(query.publicationId); }
    if (query.dispatchState) { where.push("dispatch_state = ?"); values.push(query.dispatchState); }
    if (query.runtimePhase) { where.push("runtime_phase = ?"); values.push(query.runtimePhase); }
    if (query.createdFrom) { where.push("created_at >= ?"); values.push(canonicalInstant(query.createdFrom)); }
    if (query.createdTo) { where.push("created_at <= ?"); values.push(canonicalInstant(query.createdTo)); }
    if (cursor) {
      where.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
      values.push(cursor[0]!, cursor[0]!, cursor[1]!);
    }
    const rows = this.#database.prepare(`
      SELECT run_id, trigger_key, request_json, dispatch_state, runtime_id,
             runtime_phase, last_error, created_at, updated_at
      FROM automation_runs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as RunRow[];
    const entries = rows.map(parseRun);
    return page(entries, limit, (entry) => encodeCursor("runs", [entry.createdAt, entry.runId]));
  }

  async markRunStarted(runId: string, runtimeId: string, updatedAt: string): Promise<void> {
    this.#assertOpen();
    this.#database.prepare(`
      UPDATE automation_runs
      SET dispatch_state = 'started', runtime_id = ?, last_error = NULL, updated_at = ?
      WHERE run_id = ?
    `).run(runtimeId, updatedAt, runId);
  }

  async markRunLaunchFailed(runId: string, error: string, updatedAt: string): Promise<void> {
    this.#assertOpen();
    this.#database.prepare(`
      UPDATE automation_runs
      SET dispatch_state = 'launch_failed', last_error = ?, updated_at = ?
      WHERE run_id = ?
    `).run(error, updatedAt, runId);
  }

  async updateRunPhase(runId: string, phase: AutomationRunStatus["phase"], updatedAt: string): Promise<void> {
    this.#assertOpen();
    this.#database.prepare(`
      UPDATE automation_runs SET runtime_phase = ?, updated_at = ? WHERE run_id = ?
    `).run(phase, updatedAt, runId);
  }

  async putSchedule(schedule: AutomationSchedule): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT claim_token, claim_expires_at
        FROM automation_schedules WHERE schedule_id = ?
      `).get(schedule.id) as { claim_token: string | null; claim_expires_at: string | null } | undefined;
      if (
        existing?.claim_token &&
        (existing.claim_expires_at === null || existing.claim_expires_at > schedule.updatedAt)
      ) {
        throw new Error(`Schedule ${schedule.id} is actively claimed and cannot be replaced`);
      }

      this.#database.prepare(`
        INSERT INTO automation_schedules (
          schedule_id, automation_id, automation_version, schedule_json,
          enabled, next_fire_at, last_fire_at, claim_token, claim_expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(schedule_id) DO UPDATE SET
          automation_id = excluded.automation_id,
          automation_version = excluded.automation_version,
          schedule_json = excluded.schedule_json,
          enabled = excluded.enabled,
          next_fire_at = excluded.next_fire_at,
          last_fire_at = excluded.last_fire_at,
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        schedule.id,
        schedule.automationId,
        schedule.automationVersion,
        stableJson(schedule),
        schedule.enabled ? 1 : 0,
        schedule.nextFireAt,
        schedule.lastFireAt ?? null,
        schedule.createdAt,
        schedule.updatedAt,
      );
    });
  }

  async getSchedule(scheduleId: string): Promise<AutomationSchedule | undefined> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT schedule_id, schedule_json, enabled, next_fire_at, last_fire_at,
             claim_token, claim_expires_at, created_at, updated_at
      FROM automation_schedules WHERE schedule_id = ?
    `).get(scheduleId) as ScheduleRow | undefined;
    return row ? parseSchedule(row) : undefined;
  }

  async listSchedules(query: ScheduleListQuery = {}): Promise<Page<AutomationSchedule>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("schedules", query.cursor, 2);
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.automationId) { where.push("automation_id = ?"); values.push(query.automationId); }
    if (query.enabled !== undefined) { where.push("enabled = ?"); values.push(query.enabled ? 1 : 0); }
    if (query.nextFireFrom) { where.push("next_fire_at >= ?"); values.push(canonicalInstant(query.nextFireFrom)); }
    if (query.nextFireTo) { where.push("next_fire_at <= ?"); values.push(canonicalInstant(query.nextFireTo)); }
    if (cursor) {
      where.push("(updated_at < ? OR (updated_at = ? AND schedule_id < ?))");
      values.push(cursor[0]!, cursor[0]!, cursor[1]!);
    }
    const rows = this.#database.prepare(`
      SELECT schedule_id, schedule_json, enabled, next_fire_at, last_fire_at,
             claim_token, claim_expires_at, created_at, updated_at
      FROM automation_schedules
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, schedule_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as ScheduleRow[];
    const entries = rows.map(parseSchedule);
    return page(entries, limit, (entry) => encodeCursor("schedules", [entry.updatedAt, entry.id]));
  }

  async claimDueSchedules(now: string, claimExpiresAt: string, limit: number): Promise<readonly ScheduleClaim[]> {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Schedule claim limit must be an integer between 1 and 1000");
    }
    return this.#transaction(() => {
      const rows = this.#database.prepare(`
        SELECT schedule_id, schedule_json, enabled, next_fire_at, last_fire_at,
               claim_token, claim_expires_at, created_at, updated_at
        FROM automation_schedules
        WHERE enabled = 1
          AND next_fire_at IS NOT NULL
          AND next_fire_at <= ?
          AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
        ORDER BY next_fire_at, schedule_id
        LIMIT ?
      `).all(now, now, limit) as unknown as ScheduleRow[];

      const claims: ScheduleClaim[] = [];
      const claim = this.#database.prepare(`
        UPDATE automation_schedules
        SET claim_token = ?, claim_expires_at = ?, updated_at = ?
        WHERE schedule_id = ?
      `);
      for (const row of rows) {
        if (!row.next_fire_at) continue;
        const token = randomUUID();
        claim.run(token, claimExpiresAt, now, row.schedule_id);
        claims.push({
          schedule: parseSchedule({ ...row, claim_token: token, claim_expires_at: claimExpiresAt, updated_at: now }),
          token,
          scheduledFor: row.next_fire_at,
          claimExpiresAt,
        });
      }
      return claims;
    });
  }

  async completeScheduleClaim(
    scheduleId: string,
    token: string,
    update: {
      readonly nextFireAt: string | null;
      readonly lastFireAt?: string;
      readonly enabled: boolean;
      readonly updatedAt: string;
    },
  ): Promise<void> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT schedule_id, schedule_json, enabled, next_fire_at, last_fire_at,
             claim_token, claim_expires_at, created_at, updated_at
      FROM automation_schedules WHERE schedule_id = ? AND claim_token = ?
    `).get(scheduleId, token) as ScheduleRow | undefined;
    if (!row) throw new Error(`Schedule ${scheduleId} claim is no longer owned by this worker`);
    const current = parseSchedule(row);
    const next: AutomationSchedule = {
      ...current,
      enabled: update.enabled,
      nextFireAt: update.nextFireAt,
      ...(update.lastFireAt ? { lastFireAt: update.lastFireAt } : {}),
      updatedAt: update.updatedAt,
    };
    this.#database.prepare(`
      UPDATE automation_schedules
      SET schedule_json = ?, enabled = ?, next_fire_at = ?, last_fire_at = ?,
          claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE schedule_id = ? AND claim_token = ?
    `).run(
      stableJson(next),
      update.enabled ? 1 : 0,
      update.nextFireAt,
      update.lastFireAt ?? row.last_fire_at,
      update.updatedAt,
      scheduleId,
      token,
    );
  }

  async releaseScheduleClaim(scheduleId: string, token: string, updatedAt: string): Promise<void> {
    this.#assertOpen();
    this.#database.prepare(`
      UPDATE automation_schedules
      SET claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE schedule_id = ? AND claim_token = ?
    `).run(updatedAt, scheduleId, token);
  }

  async appendAudit(input: AuditLedgerInput): Promise<AuditLedgerEntry> {
    this.#assertOpen();
    if (!input.correlationId.trim()) throw new Error("Audit correlation id is required");
    if (!input.actor.id.trim()) throw new Error("Audit actor id is required");
    if (!input.action.trim()) throw new Error("Audit action is required");
    if (!input.resource.type.trim() || !input.resource.id.trim()) throw new Error("Audit resource is required");
    const occurredAt = canonicalInstant(input.occurredAt);
    const entry: AuditLedgerEntry = {
      id: input.id ?? randomUUID(),
      correlationId: input.correlationId,
      phase: input.phase,
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      evidence: input.evidence,
      occurredAt,
    };
    this.#database.prepare(`
      INSERT INTO audit_ledger (
        audit_id, correlation_id, phase, actor_id, actor_kind, action,
        resource_type, resource_id, request_id, run_id, evidence_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.correlationId,
      entry.phase,
      entry.actor.id,
      entry.actor.kind,
      entry.action,
      entry.resource.type,
      entry.resource.id,
      entry.requestId ?? null,
      entry.runId ?? null,
      stableJson(entry.evidence),
      entry.occurredAt,
    );
    return entry;
  }

  async listAudit(query: AuditListQuery = {}): Promise<Page<AuditLedgerEntry>> {
    this.#assertOpen();
    const limit = normalizePageLimit(query.limit);
    const cursor = decodeCursor("audit", query.cursor, 2);
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.actorId) { where.push("actor_id = ?"); values.push(query.actorId); }
    if (query.action) { where.push("action = ?"); values.push(query.action); }
    if (query.resourceType) { where.push("resource_type = ?"); values.push(query.resourceType); }
    if (query.resourceId) { where.push("resource_id = ?"); values.push(query.resourceId); }
    if (query.phase) { where.push("phase = ?"); values.push(query.phase); }
    if (query.correlationId) { where.push("correlation_id = ?"); values.push(query.correlationId); }
    if (query.occurredFrom) { where.push("occurred_at >= ?"); values.push(canonicalInstant(query.occurredFrom)); }
    if (query.occurredTo) { where.push("occurred_at <= ?"); values.push(canonicalInstant(query.occurredTo)); }
    if (cursor) {
      where.push("(occurred_at < ? OR (occurred_at = ? AND audit_id < ?))");
      values.push(cursor[0]!, cursor[0]!, cursor[1]!);
    }
    const rows = this.#database.prepare(`
      SELECT audit_id, correlation_id, phase, actor_id, actor_kind, action,
             resource_type, resource_id, request_id, run_id, evidence_json, occurred_at
      FROM audit_ledger
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ?
    `).all(...values, limit + 1) as unknown as AuditRow[];
    const entries = rows.map(parseAudit);
    return page(entries, limit, (entry) => encodeCursor("audit", [entry.occurredAt, entry.id]));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
