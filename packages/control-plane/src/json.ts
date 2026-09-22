import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (input[key] !== undefined) output[key] = normalize(input[key]);
  }
  return output;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function deterministicRunId(parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(stableJson(parts)).digest("hex");
  return `run_${digest.slice(0, 40)}`;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Unknown automation launch error";
}
