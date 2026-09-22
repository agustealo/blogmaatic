import { validateAutomationDefinition, type AutomationDefinition } from "@blogmaatic/automation";
import type {
  AutomationScheduleInput,
  PublicationAutomationEvent,
} from "@blogmaatic/control-plane";
import type { Publication, PublicationGroup } from "@blogmaatic/core";

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

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OperatorRequestError(`${key} must be a positive integer`);
  }
  return value as number;
}

function publicationField(record: Record<string, unknown>): Publication {
  const publication = asRecord(record.publication, "publication");
  stringField(publication, "id", "publication.id");
  const current = asRecord(publication.current, "publication.current");
  stringField(current, "id", "publication.current.id");
  return record.publication as Publication;
}

function groupsField(record: Record<string, unknown>): readonly PublicationGroup[] {
  const groups = record.groups;
  if (!Array.isArray(groups)) throw new OperatorRequestError("groups must be an array");
  for (const [index, group] of groups.entries()) {
    const value = asRecord(group, `groups[${index}]`);
    stringField(value, "id", `groups[${index}].id`);
  }
  return groups as unknown as readonly PublicationGroup[];
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
