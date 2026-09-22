import {
  automationMatchesPublication,
  validateAutomationDefinition,
  validateAutomationRunRequest,
  type AutomationDefinition,
  type AutomationRunRequest,
  type AutomationRunTrigger,
} from "@blogmaatic/automation";

import { deterministicId, deterministicRunId, safeErrorMessage } from "./json.js";
import {
  addMilliseconds,
  canonicalInstant,
  createScheduleSnapshot,
  nextScheduleFireAfterNow,
  scheduleLatenessMs,
} from "./schedule.js";
import type {
  AutomationLauncher,
  AutomationSchedule,
  AutomationScheduleInput,
  Clock,
  ControlPlaneRunRecord,
  ControlPlaneStore,
  ControlPlaneTriggerEvidence,
  ManualAutomationCommand,
  PublicationAutomationEvent,
  ScheduleDispatchResult,
} from "./types.js";

const systemClock: Clock = { now: () => new Date().toISOString() };

export interface AutomationControlPlaneOptions {
  readonly store: ControlPlaneStore;
  readonly launcher: AutomationLauncher;
  readonly clock?: Clock;
  readonly scheduleClaimLeaseMs?: number;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function assertInstant(value: string, label: string): void {
  try {
    canonicalInstant(value);
  } catch {
    throw new Error(`${label} must be an ISO date-time with an offset or Z suffix`);
  }
}

function eventTrigger(event: PublicationAutomationEvent): AutomationRunTrigger {
  return {
    kind: "event",
    eventType: event.type,
    eventId: event.id,
    occurredAt: canonicalInstant(event.occurredAt),
  };
}

function requestFor(
  definition: AutomationDefinition,
  triggerKey: string,
  trigger: AutomationRunTrigger,
  publication: PublicationAutomationEvent["publication"],
  groups: PublicationAutomationEvent["groups"],
): AutomationRunRequest {
  const runId = deterministicRunId([
    triggerKey,
    definition.id,
    definition.version,
    publication.id,
    publication.current.id,
  ]);
  const request: AutomationRunRequest = {
    runId,
    definition,
    trigger,
    publication,
    groups,
  };
  validateAutomationRunRequest(request);
  return request;
}

export class AutomationControlPlane {
  readonly #store: ControlPlaneStore;
  readonly #launcher: AutomationLauncher;
  readonly #clock: Clock;
  readonly #scheduleClaimLeaseMs: number;

  constructor(options: AutomationControlPlaneOptions) {
    this.#store = options.store;
    this.#launcher = options.launcher;
    this.#clock = options.clock ?? systemClock;
    this.#scheduleClaimLeaseMs = options.scheduleClaimLeaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.#scheduleClaimLeaseMs) || this.#scheduleClaimLeaseMs < 1_000) {
      throw new Error("Schedule claim lease must be at least 1000ms");
    }
  }

  #now(): string {
    return canonicalInstant(this.#clock.now());
  }

  async registerAutomation(definition: AutomationDefinition): Promise<void> {
    validateAutomationDefinition(definition);
    await this.#store.registerAutomation(definition, this.#now());
  }

  async activateAutomation(automationId: string, version: number, enabled = true): Promise<void> {
    assertNonEmpty(automationId, "Automation id");
    await this.#store.activateAutomation(automationId, version, enabled, this.#now());
  }

  async routeEvent(event: PublicationAutomationEvent): Promise<readonly ControlPlaneRunRecord[]> {
    assertNonEmpty(event.id, "Publication event id");
    assertNonEmpty(event.type, "Publication event type");
    assertNonEmpty(event.source, "Publication event source");
    assertInstant(event.occurredAt, "Publication event occurredAt");

    const trigger = eventTrigger(event);
    const triggerKey = deterministicId("evt", [event.source, event.id]);
    const candidates = await this.#store.listActiveEventAutomations(event.type);
    const requests = candidates
      .map((entry) => entry.definition)
      .filter((definition) => automationMatchesPublication(definition, event.publication, trigger))
      .map((definition) => requestFor(definition, triggerKey, trigger, event.publication, event.groups));

    const evidence: ControlPlaneTriggerEvidence = {
      key: triggerKey,
      kind: "event",
      payload: {
        id: event.id,
        type: event.type,
        source: event.source,
        occurredAt: trigger.occurredAt,
        publicationId: event.publication.id,
        revisionId: event.publication.current.id,
      },
    };
    const reserved = await this.#store.reserveRuns(evidence, requests, this.#now());
    return this.#launchReserved(reserved);
  }

  async startManual(command: ManualAutomationCommand): Promise<ControlPlaneRunRecord> {
    assertNonEmpty(command.id, "Manual command id");
    assertNonEmpty(command.automationId, "Manual automation id");
    assertNonEmpty(command.initiatedBy, "Manual initiator");
    assertInstant(command.occurredAt, "Manual command occurredAt");

    const entry = command.automationVersion === undefined
      ? await this.#store.getActiveAutomation(command.automationId)
      : await this.#store.getAutomationVersion(command.automationId, command.automationVersion);
    if (!entry || !entry.enabled) throw new Error(`Automation ${command.automationId} is not enabled at the requested version`);
    if (entry.definition.trigger.kind !== "manual") {
      throw new Error(`Automation ${command.automationId} is not manually triggered`);
    }

    const trigger: AutomationRunTrigger = {
      kind: "manual",
      initiatedBy: command.initiatedBy,
      commandId: command.id,
      occurredAt: canonicalInstant(command.occurredAt),
    };
    if (!automationMatchesPublication(entry.definition, command.publication, trigger)) {
      throw new Error(`Automation ${command.automationId} conditions do not match publication ${command.publication.id}`);
    }

    const triggerKey = deterministicId("cmd", [command.automationId, command.id]);
    const request = requestFor(entry.definition, triggerKey, trigger, command.publication, command.groups);
    const evidence: ControlPlaneTriggerEvidence = {
      key: triggerKey,
      kind: "manual",
      payload: {
        commandId: command.id,
        automationId: command.automationId,
        automationVersion: entry.definition.version,
        initiatedBy: command.initiatedBy,
        occurredAt: trigger.occurredAt ?? command.occurredAt,
        publicationId: command.publication.id,
        revisionId: command.publication.current.id,
      },
    };
    const records = await this.#store.reserveRuns(evidence, [request], this.#now());
    const launched = await this.#launchReserved(records);
    const record = launched[0];
    if (!record) throw new Error("Manual automation run was not reserved");
    return record;
  }

  async createSchedule(input: AutomationScheduleInput): Promise<AutomationSchedule> {
    const entry = await this.#store.getAutomationVersion(input.automationId, input.automationVersion);
    if (!entry || !entry.enabled) {
      throw new Error(`Automation ${input.automationId} version ${input.automationVersion} is not the enabled active version`);
    }
    if (entry.definition.trigger.kind !== "schedule") {
      throw new Error(`Automation ${input.automationId} is not schedule-triggered`);
    }
    if (
      entry.definition.trigger.scheduleId !== undefined &&
      entry.definition.trigger.scheduleId !== input.id
    ) {
      throw new Error(`Automation ${input.automationId} is bound to schedule ${entry.definition.trigger.scheduleId}`);
    }

    const schedule = createScheduleSnapshot(input, this.#now());
    if (!schedule.nextFireAt) throw new Error("Schedule must have an initial fire time");
    const trigger: AutomationRunTrigger = {
      kind: "schedule",
      scheduleId: schedule.id,
      fireId: `${schedule.id}@${schedule.nextFireAt}`,
      scheduledFor: schedule.nextFireAt,
      timezone: schedule.timezone,
      occurredAt: schedule.nextFireAt,
    };
    if (!automationMatchesPublication(entry.definition, schedule.publication, trigger)) {
      throw new Error(`Schedule ${schedule.id} publication does not match automation conditions`);
    }
    requestFor(
      entry.definition,
      deterministicId("sch", [schedule.id, schedule.nextFireAt]),
      trigger,
      schedule.publication,
      schedule.groups,
    );
    await this.#store.putSchedule(schedule);
    return schedule;
  }

  async dispatchDueSchedules(options: { readonly now?: string; readonly limit?: number } = {}): Promise<readonly ScheduleDispatchResult[]> {
    const rawNow = options.now ?? this.#clock.now();
    assertInstant(rawNow, "Scheduler now");
    const now = canonicalInstant(rawNow);
    const limit = options.limit ?? 50;
    const claimExpiresAt = addMilliseconds(now, this.#scheduleClaimLeaseMs);
    const claims = await this.#store.claimDueSchedules(now, claimExpiresAt, limit);
    const results: ScheduleDispatchResult[] = [];

    for (const claim of claims) {
      const { schedule, scheduledFor, token } = claim;
      const entry = await this.#store.getAutomationVersion(schedule.automationId, schedule.automationVersion);
      if (!entry || !entry.enabled) {
        await this.#store.completeScheduleClaim(schedule.id, token, {
          nextFireAt: schedule.nextFireAt,
          enabled: false,
          updatedAt: now,
        });
        results.push({
          scheduleId: schedule.id,
          scheduledFor,
          outcome: "disabled",
          detail: "Pinned automation version is no longer the enabled active version",
        });
        continue;
      }

      const lateness = scheduleLatenessMs(scheduledFor, now);
      if (schedule.missedRunPolicy === "skip" && lateness > schedule.misfireGraceMs) {
        const nextFireAt = nextScheduleFireAfterNow(schedule, scheduledFor, now);
        await this.#store.completeScheduleClaim(schedule.id, token, {
          nextFireAt,
          enabled: nextFireAt !== null,
          updatedAt: now,
        });
        results.push({
          scheduleId: schedule.id,
          scheduledFor,
          outcome: "skipped",
          detail: `Missed schedule by ${lateness}ms, beyond the ${schedule.misfireGraceMs}ms grace window`,
        });
        continue;
      }

      const fireId = `${schedule.id}@${scheduledFor}`;
      const trigger: AutomationRunTrigger = {
        kind: "schedule",
        scheduleId: schedule.id,
        fireId,
        scheduledFor,
        timezone: schedule.timezone,
        occurredAt: now,
      };
      const triggerKey = deterministicId("sch", [schedule.id, scheduledFor]);
      const request = requestFor(entry.definition, triggerKey, trigger, schedule.publication, schedule.groups);
      const evidence: ControlPlaneTriggerEvidence = {
        key: triggerKey,
        kind: "schedule",
        payload: {
          scheduleId: schedule.id,
          fireId,
          scheduledFor,
          timezone: schedule.timezone,
          observedAt: now,
          publicationId: schedule.publication.id,
          revisionId: schedule.publication.current.id,
        },
      };
      const reserved = await this.#store.reserveRuns(evidence, [request], now);
      const launched = await this.#launchReserved(reserved);
      const run = launched[0];
      if (!run || run.dispatchState !== "started") {
        await this.#store.releaseScheduleClaim(schedule.id, token, now);
        results.push({
          scheduleId: schedule.id,
          scheduledFor,
          outcome: "launch_failed",
          ...(run ? { run } : {}),
          detail: run?.lastError ?? "Schedule run could not be launched",
        });
        continue;
      }

      const nextFireAt = nextScheduleFireAfterNow(schedule, scheduledFor, now);
      await this.#store.completeScheduleClaim(schedule.id, token, {
        nextFireAt,
        lastFireAt: scheduledFor,
        enabled: nextFireAt !== null,
        updatedAt: now,
      });
      results.push({ scheduleId: schedule.id, scheduledFor, outcome: "started", run });
    }

    return results;
  }

  async inspectRun(runId: string): Promise<ControlPlaneRunRecord | undefined> {
    const record = await this.#store.getRun(runId);
    if (!record || !this.#launcher.status) return record;
    const status = await this.#launcher.status(runId);
    if (!status) return record;
    await this.#store.updateRunPhase(runId, status.phase, this.#now());
    return this.#store.getRun(runId);
  }

  async #launchReserved(records: readonly ControlPlaneRunRecord[]): Promise<readonly ControlPlaneRunRecord[]> {
    const output: ControlPlaneRunRecord[] = [];
    for (const record of records) {
      if (record.dispatchState === "started") {
        output.push(record);
        continue;
      }
      try {
        const receipt = await this.#launcher.start(record.request);
        await this.#store.markRunStarted(record.runId, receipt.runtimeId, this.#now());
      } catch (error) {
        await this.#store.markRunLaunchFailed(record.runId, safeErrorMessage(error), this.#now());
      }
      const updated = await this.#store.getRun(record.runId);
      if (!updated) throw new Error(`Automation run ${record.runId} disappeared after launch`);
      output.push(updated);
    }
    return output;
  }
}
