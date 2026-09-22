import type { JsonValue } from "@blogmaatic/core";

export function isRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(data: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

export function getNumber(data: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringSetting(
  settings: Readonly<Record<string, JsonValue>>,
  key: string,
): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function booleanSetting(
  settings: Readonly<Record<string, JsonValue>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

export function stringArraySetting(
  settings: Readonly<Record<string, JsonValue>>,
  key: string,
): readonly string[] {
  const value = settings[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}
