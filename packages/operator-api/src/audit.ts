import { randomUUID } from "node:crypto";

import type { ControlPlaneStore } from "@blogmaatic/control-plane";
import type { JsonValue } from "@blogmaatic/core";

import type { OperatorPrincipal } from "./auth.js";

export interface AuditedMutationOptions<T> {
  readonly store: ControlPlaneStore;
  readonly principal: OperatorPrincipal;
  readonly requestId: string;
  readonly action: string;
  readonly resource: {
    readonly type: string;
    readonly id: string;
  };
  readonly evidence?: Readonly<Record<string, JsonValue>>;
  readonly now: () => string;
  readonly execute: () => Promise<T>;
  readonly success?: (result: T) => {
    readonly runId?: string;
    readonly evidence?: Readonly<Record<string, JsonValue>>;
  };
}

function mergeEvidence(
  base: Readonly<Record<string, JsonValue>> | undefined,
  extra: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  return { ...(base ?? {}), ...(extra ?? {}) };
}

export async function auditedMutation<T>(options: AuditedMutationOptions<T>): Promise<T> {
  const correlationId = randomUUID();
  const actor = { id: options.principal.id, kind: options.principal.kind } as const;
  const intentAt = options.now();
  await options.store.appendAudit({
    correlationId,
    phase: "intent",
    actor,
    action: options.action,
    resource: options.resource,
    requestId: options.requestId,
    evidence: options.evidence ?? {},
    occurredAt: intentAt,
  });

  try {
    const result = await options.execute();
    const success = options.success?.(result);
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
  } catch (error) {
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
    throw error;
  }
}
