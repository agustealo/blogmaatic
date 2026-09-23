import { randomUUID } from "node:crypto";

import type { ControlPlaneStore } from "@blogmaatic/control-plane";
import type { JsonValue } from "@blogmaatic/core";

import type { OperatorPrincipal } from "./auth.js";

type AuditEvidenceValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditEvidenceValue[]
  | { readonly [key: string]: AuditEvidenceValue };

type AuditEvidence = Readonly<Record<string, AuditEvidenceValue>>;

export interface AuditedMutationOptions<T> {
  readonly store: ControlPlaneStore;
  readonly principal: OperatorPrincipal;
  readonly requestId: string;
  readonly action: string;
  readonly resource: {
    readonly type: string;
    readonly id: string;
  };
  readonly evidence?: AuditEvidence;
  readonly now: () => string;
  readonly execute: () => Promise<T>;
  readonly success?: (result: T) => {
    readonly runId?: string;
    readonly evidence?: AuditEvidence;
  };
}

function normalizeEvidenceValue(value: AuditEvidenceValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEvidenceValue(item));
  }
  const normalized: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeEvidenceValue(item);
  }
  return normalized;
}

function normalizeEvidence(evidence: AuditEvidence | undefined): Readonly<Record<string, JsonValue>> {
  if (!evidence) return {};
  const normalized: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(evidence)) {
    normalized[key] = normalizeEvidenceValue(value);
  }
  return normalized;
}

function mergeEvidence(
  base: AuditEvidence | undefined,
  extra: AuditEvidence | undefined,
): Readonly<Record<string, JsonValue>> {
  return {
    ...normalizeEvidence(base),
    ...normalizeEvidence(extra),
  };
}

export async function auditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const correlationId = randomUUID();
  const actor = { id: options.principal.id, kind: options.principal.kind } as const;
  await options.store.appendAudit({
    correlationId,
    phase: "intent",
    actor,
    action: options.action,
    resource: options.resource,
    requestId: options.requestId,
    evidence: normalizeEvidence(options.evidence),
    occurredAt: options.now(),
  });

  let result: T;
  try {
    result = await options.execute();
  } catch (error) {
    try {
      await options.store.appendAudit({
        correlationId,
        phase: "failed",
        actor,
        action: options.action,
        resource: options.resource,
        requestId: options.requestId,
        evidence: mergeEvidence(options.evidence, {
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
        occurredAt: options.now(),
      });
    } catch {
      // The original business failure remains authoritative. The existing
      // intent record deliberately represents an outcome whose audit evidence
      // could not be completed; never replace the original error with a ledger error.
    }
    throw error;
  }

  const success = options.success?.(result);
  // This write intentionally sits outside the execution catch. If execution
  // succeeded but persistence of the success evidence fails, the ledger remains
  // intent-only (unknown/incomplete evidence) rather than falsely recording a
  // business failure after the side effect already happened.
  await options.store.appendAudit({
    correlationId,
    phase: "succeeded",
    actor,
    action: options.action,
    resource: options.resource,
    requestId: options.requestId,
    ...(success?.runId ? { runId: success.runId } : {}),
    evidence: mergeEvidence(options.evidence, success?.evidence),
    occurredAt: options.now(),
  });
  return result;
}
