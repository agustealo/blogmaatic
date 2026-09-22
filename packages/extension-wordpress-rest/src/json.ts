import type { JsonValue } from "@blogmaatic/core";

export function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function getBoolean(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getNumber(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

export function stringArray(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
