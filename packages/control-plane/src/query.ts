interface CursorEnvelope {
  readonly kind: string;
  readonly values: readonly string[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function normalizePageLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`Query limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

export function encodeCursor(kind: string, values: readonly string[]): string {
  if (!kind.trim()) throw new Error("Cursor kind is required");
  if (values.length === 0 || values.some((value) => !value.length)) {
    throw new Error("Cursor values must be non-empty strings");
  }
  const envelope: CursorEnvelope = { kind, values };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeCursor(kind: string, cursor: string | undefined, valueCount: number): readonly string[] | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.trim()) throw new Error("Query cursor cannot be empty");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const record = parsed as Record<string, unknown>;
    if (record.kind !== kind || !Array.isArray(record.values) || record.values.length !== valueCount) {
      throw new Error("invalid");
    }
    if (record.values.some((value) => typeof value !== "string" || !value.length)) {
      throw new Error("invalid");
    }
    return record.values as string[];
  } catch {
    throw new Error("Query cursor is invalid for this resource");
  }
}
