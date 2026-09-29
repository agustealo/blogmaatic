import type { ScheduleActivationBody } from "./types.js";
import { OperatorRequestError } from "./validation.js";

export function parseScheduleActivationBody(body: unknown): ScheduleActivationBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OperatorRequestError("request body must be an object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.expectedUpdatedAt !== "string" || !record.expectedUpdatedAt.trim()) {
    throw new OperatorRequestError("expectedUpdatedAt is required");
  }
  if (!Number.isFinite(Date.parse(record.expectedUpdatedAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(record.expectedUpdatedAt)) {
    throw new OperatorRequestError("expectedUpdatedAt must be an ISO date-time with an offset or Z suffix");
  }
  if (typeof record.enabled !== "boolean") {
    throw new OperatorRequestError("enabled must be a boolean");
  }
  return {
    expectedUpdatedAt: record.expectedUpdatedAt,
    enabled: record.enabled,
  };
}
