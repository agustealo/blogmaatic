import type { AutomationRunResult, AutomationRunStatus } from "@blogmaatic/automation";
import type {
  ControlPlaneRunRecord,
  ControlPlaneStore,
  RunListQuery,
} from "@blogmaatic/control-plane";
import type { DeliveryReceipt, JsonValue } from "@blogmaatic/core";

import type { OperatorAutomationRuntime } from "./types.js";

export type OperatorOperationKind =
  | "approval_required"
  | "launch_failed"
  | "run_stopped"
  | "run_rejected"
  | "delivery_blocked"
  | "delivery_awaiting_approval"
  | "delivery_drifted"
  | "delivery_unreachable";

export interface OperatorOperation {
  readonly id: string;
  readonly kind: OperatorOperationKind;
  readonly severity: "attention" | "warning" | "error";
  readonly runId: string;
  readonly automationId: string;
  readonly automationVersion: number;
  readonly publicationId: string;
  readonly revisionId: string;
  readonly occurredAt: string;
  readonly detail?: string;
  readonly stepId?: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly evidence?: JsonValue;
}

export interface OperatorOperationsQuery extends RunListQuery {
  readonly kind?: OperatorOperationKind;
}

export interface OperatorOperationsPage {
  readonly items: readonly OperatorOperation[];
  readonly nextCursor?: string;
}

function base(run: ControlPlaneRunRecord) {
  return {
    runId: run.runId,
    automationId: run.request.definition.id,
    automationVersion: run.request.definition.version,
    publicationId: run.request.publication.id,
    revisionId: run.request.publication.current.id,
  };
}

function operationForReceipt(
  run: ControlPlaneRunRecord,
  stepId: string,
  receipt: DeliveryReceipt,
): OperatorOperation | undefined {
  if (receipt.status === "verified") return undefined;
  const kind: OperatorOperationKind = `delivery_${receipt.status}`;
  return {
    id: `${run.runId}:${stepId}:${receipt.routeId}:${receipt.status}`,
    kind,
    severity: receipt.status === "unreachable" ? "error" : receipt.status === "drifted" ? "warning" : "attention",
    ...base(run),
    occurredAt: receipt.completedAt,
    stepId,
    groupId: receipt.groupId,
    routeId: receipt.routeId,
    ...(receipt.observed?.detail ? { detail: receipt.observed.detail } : {}),
    ...(receipt.evidence ? { evidence: receipt.evidence } : {}),
  };
}

function operationsFromResult(run: ControlPlaneRunRecord, result: AutomationRunResult): OperatorOperation[] {
  const operations: OperatorOperation[] = [];
  for (const step of result.stepResults) {
    if (step.kind !== "publish_group") continue;
    for (const receipt of step.receipts) {
      const operation = operationForReceipt(run, step.stepId, receipt);
      if (operation) operations.push(operation);
    }
  }
  return operations;
}

function statusOperation(run: ControlPlaneRunRecord, status: AutomationRunStatus): OperatorOperation | undefined {
  if (status.phase === "waiting_approval" && status.expectedApproval) {
    return {
      id: `${run.runId}:approval:${status.expectedApproval.stepId}`,
      kind: "approval_required",
      severity: "attention",
      ...base(run),
      occurredAt: status.updatedAt,
      stepId: status.expectedApproval.stepId,
      detail: `Approval role ${status.expectedApproval.role} is required`,
      evidence: {
        role: status.expectedApproval.role,
        revisionId: status.expectedApproval.revisionId,
      },
    };
  }
  if (status.phase === "stopped" || status.phase === "rejected") {
    return {
      id: `${run.runId}:${status.phase}`,
      kind: status.phase === "stopped" ? "run_stopped" : "run_rejected",
      severity: status.phase === "stopped" ? "error" : "warning",
      ...base(run),
      occurredAt: status.updatedAt,
      ...(status.detail ? { detail: status.detail } : {}),
    };
  }
  return undefined;
}

export async function listOperatorOperations(
  store: ControlPlaneStore,
  runtime: OperatorAutomationRuntime,
  query: OperatorOperationsQuery = {},
): Promise<OperatorOperationsPage> {
  const { kind, ...runQuery } = query;
  const runs = await store.listRuns(runQuery);
  const operations: OperatorOperation[] = [];

  for (const run of runs.items) {
    if (run.dispatchState === "launch_failed") {
      operations.push({
        id: `${run.runId}:launch_failed`,
        kind: "launch_failed",
        severity: "error",
        ...base(run),
        occurredAt: run.updatedAt,
        ...(run.lastError ? { detail: run.lastError } : {}),
      });
      continue;
    }
    if (run.dispatchState !== "started") continue;

    const status = await runtime.status(run.runId);
    if (!status) continue;
    if (run.runtimePhase !== status.phase) {
      await store.updateRunPhase(run.runId, status.phase, status.updatedAt);
    }
    const current = statusOperation(run, status);
    if (current) operations.push(current);

    if (status.phase === "completed" || status.phase === "stopped" || status.phase === "rejected") {
      const result = await runtime.result(run.runId);
      operations.push(...operationsFromResult(run, result));
    }
  }

  const filtered = kind ? operations.filter((operation) => operation.kind === kind) : operations;
  return {
    items: filtered,
    ...(runs.nextCursor ? { nextCursor: runs.nextCursor } : {}),
  };
}
