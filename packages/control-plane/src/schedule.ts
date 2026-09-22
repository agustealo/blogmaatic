import { Temporal } from "@js-temporal/polyfill";

import type { AutomationSchedule, AutomationScheduleInput, ScheduleRecurrence } from "./types.js";

const MAX_MISFIRE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MISFIRE_GRACE_MS = 5 * 60 * 1000;

function parseLocalTime(value: string): Temporal.PlainTime {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error("Schedule localTime must use HH:mm");
  return Temporal.PlainTime.from(`${value}:00`);
}

function parseLocalDate(value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Schedule localDate must use YYYY-MM-DD");
  return Temporal.PlainDate.from(value);
}

function assertRecurrence(recurrence: ScheduleRecurrence): void {
  if (recurrence.kind !== "weekly") return;
  if (recurrence.weekdays.length === 0) throw new Error("Weekly schedule requires at least one weekday");
  const seen = new Set<number>();
  for (const day of recurrence.weekdays) {
    if (!Number.isSafeInteger(day) || day < 1 || day > 7) {
      throw new Error("Weekly schedule weekdays must be ISO weekday numbers 1 through 7");
    }
    if (seen.has(day)) throw new Error(`Weekly schedule weekday is duplicated: ${day}`);
    seen.add(day);
  }
}

function localDateTimeToInstant(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timezone: string,
): string {
  const local = date.toPlainDateTime(time);
  // "compatible" mirrors common calendar behavior: use the earlier instant on
  // overlaps and move forward across spring-forward gaps.
  return local.toZonedDateTime(timezone, { disambiguation: "compatible" }).toInstant().toString();
}

export function canonicalInstant(value: string): string {
  return Temporal.Instant.from(value).toString();
}

export function validateScheduleInput(input: AutomationScheduleInput): void {
  if (!input.id.trim()) throw new Error("Schedule id is required");
  if (!input.automationId.trim()) throw new Error("Schedule automation id is required");
  if (!Number.isSafeInteger(input.automationVersion) || input.automationVersion < 1) {
    throw new Error("Schedule automation version must be a positive integer");
  }
  if (!input.timezone.trim()) throw new Error("Schedule timezone is required");
  const date = parseLocalDate(input.localDate);
  const time = parseLocalTime(input.localTime);
  localDateTimeToInstant(date, time, input.timezone);
  assertRecurrence(input.recurrence);
  const grace = input.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > MAX_MISFIRE_GRACE_MS) {
    throw new Error(`Schedule misfireGraceMs must be an integer between 0 and ${MAX_MISFIRE_GRACE_MS}`);
  }
}

export function createScheduleSnapshot(input: AutomationScheduleInput, now: string): AutomationSchedule {
  validateScheduleInput(input);
  const canonicalNow = canonicalInstant(now);
  const firstFireAt = localDateTimeToInstant(
    parseLocalDate(input.localDate),
    parseLocalTime(input.localTime),
    input.timezone,
  );
  return {
    ...input,
    enabled: input.enabled ?? true,
    misfireGraceMs: input.misfireGraceMs ?? DEFAULT_MISFIRE_GRACE_MS,
    nextFireAt: firstFireAt,
    createdAt: canonicalNow,
    updatedAt: canonicalNow,
  };
}

function nextWeeklyDate(date: Temporal.PlainDate, weekdays: readonly number[]): Temporal.PlainDate {
  const targets = new Set(weekdays);
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = date.add({ days: offset });
    if (targets.has(candidate.dayOfWeek)) return candidate;
  }
  throw new Error("Weekly recurrence has no valid next weekday");
}

export function nextScheduleFireAfter(schedule: AutomationSchedule, previousFireAt: string): string | null {
  if (schedule.recurrence.kind === "once") return null;
  const previous = Temporal.Instant.from(previousFireAt).toZonedDateTimeISO(schedule.timezone);
  const time = parseLocalTime(schedule.localTime);
  const nextDate = schedule.recurrence.kind === "daily"
    ? previous.toPlainDate().add({ days: 1 })
    : nextWeeklyDate(previous.toPlainDate(), schedule.recurrence.weekdays);
  return localDateTimeToInstant(nextDate, time, schedule.timezone);
}

export function nextScheduleFireAfterNow(
  schedule: AutomationSchedule,
  previousFireAt: string,
  now: string,
): string | null {
  const nowInstant = Temporal.Instant.from(now);
  let next = nextScheduleFireAfter(schedule, previousFireAt);
  while (next !== null && Temporal.Instant.compare(Temporal.Instant.from(next), nowInstant) <= 0) {
    next = nextScheduleFireAfter(schedule, next);
  }
  return next;
}

export function scheduleLatenessMs(scheduledFor: string, now: string): number {
  const scheduled = Temporal.Instant.from(scheduledFor).epochMilliseconds;
  const current = Temporal.Instant.from(now).epochMilliseconds;
  return Math.max(0, current - scheduled);
}

export function addMilliseconds(instant: string, milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Milliseconds must be a non-negative safe integer");
  }
  return Temporal.Instant.from(instant).add({ milliseconds }).toString();
}
