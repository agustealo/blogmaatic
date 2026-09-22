import type {
  AutomationDefinition,
  AutomationRunRequest,
  AutomationRunStatus,
} from "@blogmaatic/automation";
import type { JsonValue, Publication, PublicationGroup } from "@blogmaatic/core";

export interface PublicationAutomationEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly publication: Publication;
  readonly groups: readonly PublicationGroup[];
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

export interface ManualAutomationCommand {
  readonly id: string;
  readonly automationId: string;
  readonly automationVersion?: number;
  readonly initiatedBy: string;
  readonly occurredAt: string;
  readonly publication: Publication;
  readonly groups: readonly PublicationGroup[];
}

export interface AutomationRegistryEntry {
  readonly definition: AutomationDefinition;
  readonly registeredAt: string;
  readonly activeVersion: number;
  readonly enabled: boolean;
  readonly isActiveVersion: boolean;
}

export type ControlPlaneRunDispatchState = "prepared" | "started" | "launch_failed";

export interface ControlPlaneRunRecord {
  readonly runId: string;
  readonly triggerKey: string;
  readonly request: AutomationRunRequest;
  readonly dispatchState: ControlPlaneRunDispatchState;
  readonly runtimeId?: string;
  readonly runtimePhase?: AutomationRunStatus["phase"];
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationLaunchReceipt {
  readonly runtimeId: string;
}

export interface AutomationLauncher {
  start(request: AutomationRunRequest): Promise<AutomationLaunchReceipt>;
  status?(runId: string): Promise<AutomationRunStatus | null>;
}

export type ScheduleRecurrence =
  | { readonly kind: "once" }
  | { readonly kind: "daily" }
  | { readonly kind: "weekly"; readonly weekdays: readonly number[] };

export type MissedRunPolicy = "catch_up_once" | "skip";

export interface AutomationScheduleInput {
  readonly id: string;
  readonly automationId: string;
  readonly automationVersion: number;
  readonly publication: Publication;
  readonly groups: readonly PublicationGroup[];
  readonly timezone: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly recurrence: ScheduleRecurrence;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly misfireGraceMs?: number;
  readonly enabled?: boolean;
}

export interface AutomationSchedule extends AutomationScheduleInput {
  readonly enabled: boolean;
  readonly misfireGraceMs: number;
  readonly nextFireAt: string | null;
  readonly lastFireAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleClaim {
  readonly schedule: AutomationSchedule;
  readonly token: string;
  readonly scheduledFor: string;
  readonly claimExpiresAt: string;
}

export interface ScheduleDispatchResult {
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly outcome: "started" | "skipped" | "launch_failed" | "disabled";
  readonly run?: ControlPlaneRunRecord;
  readonly detail?: string;
}

export interface ControlPlaneTriggerEvidence {
  readonly key: string;
  readonly kind: "event" | "manual" | "schedule";
  readonly payload: JsonValue;
}

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface AutomationListQuery extends PageRequest {
  readonly enabled?: boolean;
}

export interface AutomationVersionListQuery extends PageRequest {}

export interface RunListQuery extends PageRequest {
  readonly automationId?: string;
  readonly publicationId?: string;
  readonly dispatchState?: ControlPlaneRunDispatchState;
  /**
   * Cache-only storage filter. It must not be used to promise current runtime
   * truth at an operator boundary. Live operator filtering refreshes Restate
   * status before applying this criterion.
   */
  readonly runtimePhase?: AutomationRunStatus["phase"];
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

export interface ScheduleListQuery extends PageRequest {
  readonly automationId?: string;
  readonly enabled?: boolean;
  readonly nextFireFrom?: string;
  readonly nextFireTo?: string;
}

export type AuditLedgerPhase = "intent" | "succeeded" | "failed";
export type AuditActorKind = "operator" | "integration" | "system";

export interface AuditLedgerEntry {
  readonly id: string;
  readonly correlationId: string;
  readonly phase: AuditLedgerPhase;
  readonly actor: {
    readonly id: string;
    readonly kind: AuditActorKind;
  };
  readonly action: string;
  readonly resource: {
    readonly type: string;
    readonly id: string;
  };
  readonly requestId?: string;
  readonly runId?: string;
  readonly evidence: JsonValue;
  readonly occurredAt: string;
}

export interface AuditLedgerInput extends Omit<AuditLedgerEntry, "id"> {
  readonly id?: string;
}

export interface AuditListQuery extends PageRequest {
  readonly actorId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly phase?: AuditLedgerPhase;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly correlationId?: string;
}

export interface Clock {
  now(): string;
}

export interface ControlPlaneStore {
  registerAutomation(definition: AutomationDefinition, registeredAt: string): Promise<void>;
  activateAutomation(automationId: string, version: number, enabled: boolean, updatedAt: string): Promise<void>;
  getActiveAutomation(automationId: string): Promise<AutomationRegistryEntry | undefined>;
  getAutomationVersion(automationId: string, version: number): Promise<AutomationRegistryEntry | undefined>;
  listActiveEventAutomations(eventType: string): Promise<readonly AutomationRegistryEntry[]>;
  listAutomations(query?: AutomationListQuery): Promise<Page<AutomationRegistryEntry>>;
  listAutomationVersions(
    automationId: string,
    query?: AutomationVersionListQuery,
  ): Promise<Page<AutomationRegistryEntry>>;

  reserveRuns(
    trigger: ControlPlaneTriggerEvidence,
    requests: readonly AutomationRunRequest[],
    createdAt: string,
  ): Promise<readonly ControlPlaneRunRecord[]>;
  getRun(runId: string): Promise<ControlPlaneRunRecord | undefined>;
  listRuns(query?: RunListQuery): Promise<Page<ControlPlaneRunRecord>>;
  markRunStarted(runId: string, runtimeId: string, updatedAt: string): Promise<void>;
  markRunLaunchFailed(runId: string, error: string, updatedAt: string): Promise<void>;
  updateRunPhase(runId: string, phase: AutomationRunStatus["phase"], updatedAt: string): Promise<void>;

  putSchedule(schedule: AutomationSchedule): Promise<void>;
  getSchedule(scheduleId: string): Promise<AutomationSchedule | undefined>;
  listSchedules(query?: ScheduleListQuery): Promise<Page<AutomationSchedule>>;
  claimDueSchedules(
    now: string,
    claimExpiresAt: string,
    limit: number,
  ): Promise<readonly ScheduleClaim[]>;
  completeScheduleClaim(
    scheduleId: string,
    token: string,
    update: {
      readonly nextFireAt: string | null;
      readonly lastFireAt?: string;
      readonly enabled: boolean;
      readonly updatedAt: string;
    },
  ): Promise<void>;
  releaseScheduleClaim(scheduleId: string, token: string, updatedAt: string): Promise<void>;

  appendAudit(entry: AuditLedgerInput): Promise<AuditLedgerEntry>;
  listAudit(query?: AuditListQuery): Promise<Page<AuditLedgerEntry>>;
}
