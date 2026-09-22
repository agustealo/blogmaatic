import {
  validateAutomationDefinition,
  type AutomationDefinition,
  type AutomationRunPhase,
} from "@blogmaatic/automation";
import {
  canonicalInstant,
  type AuditLedgerPhase,
  type AuditListQuery,
  type AutomationListQuery,
  type AutomationScheduleInput,
  type AutomationVersionListQuery,
  type ControlPlaneRunDispatchState,
  type PublicationAutomationEvent,
  type RunListQuery,
  type ScheduleListQuery,
} from "@blogmaatic/control-plane";
import {
  validatePublication,
  validatePublicationGroups,
  type Publication,
  type PublicationGroup,
} from "@blogmaatic/core";

import type { OperatorOperationKind, OperatorOperationsQuery } from "./operations.js";
import type {
  ActivationBody,
  ApprovalBody,
  EventIngestBody,
  ManualRunBody,
  ScheduleDispatchBody,
} from "./types.js";

export class OperatorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRequestError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorRequestError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function queryRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return asRecord(value, "query");
}

function stringField(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new OperatorRequestError(`${label} is required`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new OperatorRequestError(`${key} must be a string`);
  return value;
}

function optionalQueryString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new OperatorRequestError(`${key} must be a non-empty string`);
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OperatorRequestError(`${key} must be a positive integer`);
  }
  return value as number;
}

function optionalQueryLimit(record: Record<string, unknown>): number | undefined {
  const value = record.limit;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new OperatorRequestError("limit must be an integer between 1 and 200");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new OperatorRequestError("limit must be an integer between 1 and 200");
  }
  return parsed;
}

function optionalQueryBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new OperatorRequestError(`${key} must be true or false`);
}

function optionalQueryInstant(record: Record<string, unknown>, key: string): string | undefined {
  const value = optionalQueryString(record, key);
  if (value === undefined) return undefined;
  try {
    return canonicalInstant(value);
  } catch {
    throw new OperatorRequestError(`${key} must be an ISO date-time with an offset or Z suffix`);
  }
}

function pagination(record: Record<string, unknown>): { readonly limit?: number; readonly cursor?: string } {
  const limit = optionalQueryLimit(record);
  const cursor = optionalQueryString(record, "cursor");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function publicationField(record: Record<string, unknown>): Publication {
  const publication = record.publication as Publication;
  try {
    validatePublication(publication);
  } catch (error) {
    throw new OperatorRequestError(error instanceof Error ? error.message : "Invalid publication snapshot");
  }
  return publication;
}

function groupsField(record: Record<string, unknown>): readonly PublicationGroup[] {
  const groups = record.groups as readonly PublicationGroup[];
  try {
    validatePublicationGroups(groups);
  } catch (error) {
    throw new OperatorRequestError(error instanceof Error ? error.message : "Invalid publication groups");
  }
  return groups;
}

export function parseAutomationRegistration(body: unknown): AutomationDefinition {
  const definition = body as AutomationDefinition;
  try {
    validateAutomationDefinition(definition);
  } catch (error) {
    throw new OperatorRequestError(error instanceof Error ? error.message : "Invalid automation definition");
  }
  return definition;
}

export function parseActivationBody(body: unknown): ActivationBody {
  const record = asRecord(body, "request body");
  if (typeof record.enabled !== "boolean") throw new OperatorRequestError("enabled must be a boolean");
  return { enabled: record.enabled };
}

export function parseEventBody(body: unknown): EventIngestBody {
  const record = asRecord(body, "request body");
  const attributes = record.attributes;
  if (attributes !== undefined) asRecord(attributes, "attributes");
  return {
    id: stringField(record, "id"),
    type: stringField(record, "type"),
    occurredAt: stringField(record, "occurredAt"),
    publication: publicationField(record),
    groups: groupsField(record),
    ...(attributes === undefined
      ? {}
      : { attributes: attributes as NonNullable<PublicationAutomationEvent["attributes"]> }),
  };
}

export function parseManualRunBody(body: unknown): ManualRunBody {
  const record = asRecord(body, "request body");
  return {
    automationId: stringField(record, "automationId"),
    ...(record.automationVersion === undefined
      ? {}
      : { automationVersion: optionalPositiveInteger(record, "automationVersion")! }),
    publication: publicationField(record),
    groups: groupsField(record),
  };
}

export function parseApprovalBody(body: unknown): ApprovalBody {
  const record = asRecord(body, "request body");
  if (record.decision !== "approve" && record.decision !== "reject") {
    throw new OperatorRequestError("decision must be approve or reject");
  }
  const note = optionalStringField(record, "note");
  return {
    decision: record.decision,
    ...(note === undefined ? {} : { note }),
  };
}

export function parseScheduleBody(body: unknown): AutomationScheduleInput {
  const record = asRecord(body, "request body");
  const recurrenceRecord = asRecord(record.recurrence, "recurrence");
  const recurrenceKind = stringField(recurrenceRecord, "kind", "recurrence.kind");
  let recurrence: AutomationScheduleInput["recurrence"];
  if (recurrenceKind === "once" || recurrenceKind === "daily") {
    recurrence = { kind: recurrenceKind };
  } else if (recurrenceKind === "weekly") {
    if (!Array.isArray(recurrenceRecord.weekdays)) {
      throw new OperatorRequestError("recurrence.weekdays must be an array");
    }
    const weekdays = recurrenceRecord.weekdays.map((value, index) => {
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 7) {
        throw new OperatorRequestError(`recurrence.weekdays[${index}] must be an integer from 1 through 7`);
      }
      return value as number;
    });
    recurrence = { kind: "weekly", weekdays };
  } else {
    throw new OperatorRequestError("recurrence.kind must be once, daily, or weekly");
  }

  const missedRunPolicy = record.missedRunPolicy;
  if (missedRunPolicy !== "catch_up_once" && missedRunPolicy !== "skip") {
    throw new OperatorRequestError("missedRunPolicy must be catch_up_once or skip");
  }
  const misfireGraceMs = record.misfireGraceMs;
  if (misfireGraceMs !== undefined && (!Number.isSafeInteger(misfireGraceMs) || (misfireGraceMs as number) < 0)) {
    throw new OperatorRequestError("misfireGraceMs must be a non-negative integer");
  }
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new OperatorRequestError("enabled must be a boolean");
  }

  return {
    id: stringField(record, "id"),
    automationId: stringField(record, "automationId"),
    automationVersion: optionalPositiveInteger(record, "automationVersion") ?? (() => {
      throw new OperatorRequestError("automationVersion is required");
    })(),
    publication: publicationField(record),
    groups: groupsField(record),
    timezone: stringField(record, "timezone"),
    localDate: stringField(record, "localDate"),
    localTime: stringField(record, "localTime"),
    recurrence,
    missedRunPolicy,
    ...(misfireGraceMs === undefined ? {} : { misfireGraceMs: misfireGraceMs as number }),
    ...(record.enabled === undefined ? {} : { enabled: record.enabled as boolean }),
  };
}

export function parseScheduleDispatchBody(body: unknown): ScheduleDispatchBody {
  if (body === undefined || body === null) return {};
  const record = asRecord(body, "request body");
  const now = optionalStringField(record, "now");
  const limit = record.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000)) {
    throw new OperatorRequestError("limit must be an integer between 1 and 1000");
  }
  return {
    ...(now === undefined ? {} : { now }),
    ...(limit === undefined ? {} : { limit: limit as number }),
  };
}

export function parseAutomationListQuery(value: unknown): AutomationListQuery {
  const record = queryRecord(value);
  const enabled = optionalQueryBoolean(record, "enabled");
  return { ...pagination(record), ...(enabled === undefined ? {} : { enabled }) };
}

export function parseAutomationVersionListQuery(value: unknown): AutomationVersionListQuery {
  return pagination(queryRecord(value));
}

const dispatchStates = new Set<ControlPlaneRunDispatchState>(["prepared", "started", "launch_failed"]);
const runPhases = new Set<AutomationRunPhase>(["running", "waiting_approval", "delaying", "completed", "stopped", "rejected"]);

export function parseRunListQuery(value: unknown): RunListQuery {
  const record = queryRecord(value);
  const automationId = optionalQueryString(record, "automationId");
  const publicationId = optionalQueryString(record, "publicationId");
  const dispatchState = optionalQueryString(record, "dispatchState");
  const runtimePhase = optionalQueryString(record, "runtimePhase");
  if (dispatchState !== undefined && !dispatchStates.has(dispatchState as ControlPlaneRunDispatchState)) {
    throw new OperatorRequestError("dispatchState is invalid");
  }
  if (runtimePhase !== undefined && !runPhases.has(runtimePhase as AutomationRunPhase)) {
    throw new OperatorRequestError("runtimePhase is invalid");
  }
  const createdFrom = optionalQueryInstant(record, "createdFrom");
  const createdTo = optionalQueryInstant(record, "createdTo");
  return {
    ...pagination(record),
    ...(automationId ? { automationId } : {}),
    ...(publicationId ? { publicationId } : {}),
    ...(dispatchState ? { dispatchState: dispatchState as ControlPlaneRunDispatchState } : {}),
    ...(runtimePhase ? { runtimePhase: runtimePhase as AutomationRunPhase } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
  };
}

export function parseScheduleListQuery(value: unknown): ScheduleListQuery {
  const record = queryRecord(value);
  const automationId = optionalQueryString(record, "automationId");
  const enabled = optionalQueryBoolean(record, "enabled");
  const nextFireFrom = optionalQueryInstant(record, "nextFireFrom");
  const nextFireTo = optionalQueryInstant(record, "nextFireTo");
  return {
    ...pagination(record),
    ...(automationId ? { automationId } : {}),
    ...(enabled === undefined ? {} : { enabled }),
    ...(nextFireFrom ? { nextFireFrom } : {}),
    ...(nextFireTo ? { nextFireTo } : {}),
  };
}

const auditPhases = new Set<AuditLedgerPhase>(["intent", "succeeded", "failed"]);

export function parseAuditListQuery(value: unknown): AuditListQuery {
  const record = queryRecord(value);
  const actorId = optionalQueryString(record, "actorId");
  const action = optionalQueryString(record, "action");
  const resourceType = optionalQueryString(record, "resourceType");
  const resourceId = optionalQueryString(record, "resourceId");
  const correlationId = optionalQueryString(record, "correlationId");
  const phase = optionalQueryString(record, "phase");
  if (phase !== undefined && !auditPhases.has(phase as AuditLedgerPhase)) {
    throw new OperatorRequestError("phase is invalid");
  }
  const occurredFrom = optionalQueryInstant(record, "occurredFrom");
  const occurredTo = optionalQueryInstant(record, "occurredTo");
  return {
    ...pagination(record),
    ...(actorId ? { actorId } : {}),
    ...(action ? { action } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(phase ? { phase: phase as AuditLedgerPhase } : {}),
    ...(occurredFrom ? { occurredFrom } : {}),
    ...(occurredTo ? { occurredTo } : {}),
  };
}

const operationKinds = new Set<OperatorOperationKind>([
  "approval_required",
  "launch_failed",
  "run_stopped",
  "run_rejected",
  "delivery_blocked",
  "delivery_awaiting_approval",
  "delivery_drifted",
  "delivery_unreachable",
]);

export function parseOperationsQuery(value: unknown): OperatorOperationsQuery {
  const record = queryRecord(value);
  const kind = optionalQueryString(record, "kind");
  if (kind !== undefined && !operationKinds.has(kind as OperatorOperationKind)) {
    throw new OperatorRequestError("kind is invalid");
  }
  return {
    ...parseRunListQuery(record),
    ...(kind ? { kind: kind as OperatorOperationKind } : {}),
  };
}

export function requirePathString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new OperatorRequestError(`${label} is required`);
  return value;
}

export function requirePathVersion(value: unknown): number {
  const version = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new OperatorRequestError("version must be a positive integer");
  }
  return version;
}

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OperatorRequestError("Idempotency-Key header is required");
  }
  if (value.length > 200) throw new OperatorRequestError("Idempotency-Key header is too long");
  return value;
}
