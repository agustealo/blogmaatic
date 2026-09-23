import {
  validateAutomationDefinition,
  type AutomationDefinition,
  type AutomationRunPhase,
} from "@blogmaatic/automation";
import {
  canonicalInstant,
  decodeCursor,
  type AuditLedgerPhase,
  type AuditListQuery,
  type AutomationListQuery,
  type AutomationScheduleInput,
  type AutomationVersionListQuery,
  type ControlPlaneRunDispatchState,
  type PublicationAutomationEvent,
  type ScheduleListQuery,
} from "@blogmaatic/control-plane";
import {
  validatePublication,
  validatePublicationGroups,
  type JsonValue,
  type Publication,
  type PublicationGroup,
} from "@blogmaatic/core";

import type { OperatorOperationKind, OperatorOperationsQuery } from "./operations.js";
import type { OperatorRunListQuery } from "./runs.js";
import type {
  ActivationBody,
  ApprovalBody,
  ConnectionCreateBody,
  ConnectionUpdateBody,
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

function pagination(
  record: Record<string, unknown>,
  kind: string,
  valueCount: number,
): { readonly limit?: number; readonly cursor?: string } {
  const limit = optionalQueryLimit(record);
  const cursor = optionalQueryString(record, "cursor");
  if (cursor !== undefined) {
    try {
      decodeCursor(kind, cursor, valueCount);
    } catch {
      throw new OperatorRequestError("cursor is invalid for this resource");
    }
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OperatorRequestError(`${label} must contain finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  const input = asRecord(value, label);
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(input)) output[key] = jsonValue(item, `${label}.${key}`);
  return output;
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValue(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OperatorRequestError(`${label} must be a JSON object`);
  }
  return parsed;
}

function secretRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  const input = asRecord(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string" || item.length === 0) {
      throw new OperatorRequestError(`${label}.${key} must be a non-empty string`);
    }
    output[key] = item;
  }
  return output;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !permitted.has(key));
  if (unknown.length > 0) throw new OperatorRequestError(`${label} contains unknown field: ${unknown[0]}`);
}

function connectionStatus(value: unknown): "active" | "disabled" | undefined {
  if (value === undefined) return undefined;
  if (value !== "active" && value !== "disabled") {
    throw new OperatorRequestError("status must be active or disabled");
  }
  return value;
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

export function parseConnectionCreateBody(body: unknown): ConnectionCreateBody {
  const record = asRecord(body, "request body");
  rejectUnknownFields(record, ["extensionId", "displayName", "status", "settings", "secrets"], "request body");
  const status = connectionStatus(record.status);
  const secrets = record.secrets === undefined ? undefined : secretRecord(record.secrets, "secrets");
  return {
    extensionId: stringField(record, "extensionId"),
    displayName: stringField(record, "displayName"),
    ...(status === undefined ? {} : { status }),
    settings: jsonObject(record.settings, "settings"),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

export function parseConnectionUpdateBody(body: unknown): ConnectionUpdateBody {
  const record = asRecord(body, "request body");
  rejectUnknownFields(record, ["displayName", "status", "settings", "secrets"], "request body");
  if (Object.keys(record).length === 0) throw new OperatorRequestError("request body must change at least one connection field");
  const displayName = optionalStringField(record, "displayName");
  if (displayName !== undefined && !displayName.trim()) throw new OperatorRequestError("displayName must be non-empty");
  const status = connectionStatus(record.status);
  const settings = record.settings === undefined ? undefined : jsonObject(record.settings, "settings");
  const secrets = record.secrets === undefined ? undefined : secretRecord(record.secrets, "secrets");
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(status === undefined ? {} : { status }),
    ...(settings === undefined ? {} : { settings }),
    ...(secrets === undefined ? {} : { secrets }),
  };
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
  return { ...pagination(record, "automations", 1), ...(enabled === undefined ? {} : { enabled }) };
}

export function parseAutomationVersionListQuery(value: unknown): AutomationVersionListQuery {
  const record = queryRecord(value);
  const page = pagination(record, "automation-versions", 1);
  if (page.cursor) {
    const values = decodeCursor("automation-versions", page.cursor, 1)!;
    const version = Number(values[0]);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new OperatorRequestError("cursor is invalid for automation versions");
    }
  }
  return page;
}

const dispatchStates = new Set<ControlPlaneRunDispatchState>(["prepared", "started", "launch_failed"]);
const runPhases = new Set<AutomationRunPhase>(["running", "waiting_approval", "delaying", "completed", "stopped", "rejected"]);

function parseRunFilters(record: Record<string, unknown>): Omit<OperatorRunListQuery, "limit" | "cursor"> {
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
    ...(automationId ? { automationId } : {}),
    ...(publicationId ? { publicationId } : {}),
    ...(dispatchState ? { dispatchState: dispatchState as ControlPlaneRunDispatchState } : {}),
    ...(runtimePhase ? { runtimePhase: runtimePhase as AutomationRunPhase } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
  };
}

export function parseRunListQuery(value: unknown): OperatorRunListQuery {
  const record = queryRecord(value);
  return {
    ...pagination(record, "runs", 2),
    ...parseRunFilters(record),
  };
}

export function parseScheduleListQuery(value: unknown): ScheduleListQuery {
  const record = queryRecord(value);
  const automationId = optionalQueryString(record, "automationId");
  const enabled = optionalQueryBoolean(record, "enabled");
  const nextFireFrom = optionalQueryInstant(record, "nextFireFrom");
  const nextFireTo = optionalQueryInstant(record, "nextFireTo");
  return {
    ...pagination(record, "schedules", 2),
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
    ...pagination(record, "audit", 2),
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
    ...pagination(record, "operations", 3),
    ...parseRunFilters(record),
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
