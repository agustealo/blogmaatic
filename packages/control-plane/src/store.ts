import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  validateAutomationDefinition,
  type AutomationDefinition,
  type AutomationRunRequest,
  type AutomationRunStatus,
} from "@blogmaatic/automation";

import { stableJson } from "./json.js";
import type {
  AutomationRegistryEntry,
  AutomationSchedule,
  ControlPlaneRunRecord,
  ControlPlaneStore,
  ControlPlaneTriggerEvidence,
  ScheduleClaim,
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

function triggerDiscriminator(definition: AutomationDefinition): string | null {
  if (definition.trigger.kind === "event") return definition.trigger.eventType;
  if (definition.trigger.kind === "schedule") return definition.trigger.scheduleId ?? null;
  return null;
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

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
