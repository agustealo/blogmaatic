import type {
  AutomationRunPhase,
  AutomationRunResult,
  AutomationRunStatus,
} from "@blogmaatic/automation";
import {
  decodeCursor,
  encodeCursor,
  normalizePageLimit,
  type ControlPlaneRunRecord,
  type ControlPlaneStore,
  type PageRequest,
  type RunListQuery,
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

export interface OperatorOperationsQuery extends PageRequest {
  readonly kind?: OperatorOperationKind;
  readonly automationId?: string;
  readonly publicationId?: string;
  readonly dispatchState?: RunListQuery["dispatchState"];
  readonly runtimePhase?: AutomationRunPhase;
  readonly createdFrom?: string;
  readonly createdTo?: string;
}

export interface OperatorOperationsPage {
  readonly items: readonly OperatorOperation[];
  readonly nextCursor?: string;
}

interface OperationCandidate {
  readonly operation: OperatorOperation;
  readonly runCreatedAt: string;
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

function storageQuery(
  query: OperatorOperationsQuery,
  cursor: string | undefined,
): RunListQuery {
  return {
    limit: 200,
    ...(cursor === undefined ? {} : { cursor }),
    ...(query.automationId ? { automationId: query.automationId } : {}),
    ...(query.publicationId ? { publicationId: query.publicationId } : {}),
    ...(query.dispatchState ? { dispatchState: query.dispatchState } : {}),
    ...(query.createdFrom ? { createdFrom: query.createdFrom } : {}),
    ...(query.createdTo ? { createdTo: query.createdTo } : {}),
  };
}

function storedRunMatches(run: ControlPlaneRunRecord, query: OperatorOperationsQuery): boolean {
  if (query.automationId && run.request.definition.id !== query.automationId) return false;
  if (query.publicationId && run.request.publication.id !== query.publicationId) return false;
  if (query.dispatchState && run.dispatchState !== query.dispatchState) return false;
  if (query.createdFrom && Date.parse(run.createdAt) < Date.parse(query.createdFrom)) return false;
  if (query.createdTo && Date.parse(run.createdAt) > Date.parse(query.createdTo)) return false;
  return true;
}

async function operationsForRun(
  store: ControlPlaneStore,
  runtime: OperatorAutomationRuntime,
  run: ControlPlaneRunRecord,
  query: OperatorOperationsQuery,
): Promise<OperatorOperation[]> {
  let operations: OperatorOperation[] = [];
  if (run.dispatchState === "launch_failed") {
    if (query.runtimePhase !== undefined) return [];
    operations = [{
      id: `${run.runId}:launch_failed`,
      kind: "launch_failed",
      severity: "error",
      ...base(run),
      occurredAt: run.updatedAt,
      ...(run.lastError ? { detail: run.lastError } : {}),
    }];
  } else if (run.dispatchState === "started") {
    const status = await runtime.status(run.runId);
    if (!status || (query.runtimePhase !== undefined && status.phase !== query.runtimePhase)) return [];
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

  if (query.kind) operations = operations.filter((operation) => operation.kind === query.kind);
  return operations.sort((left, right) => left.id.localeCompare(right.id));
}

function resultPage(candidates: readonly OperationCandidate[], limit: number): OperatorOperationsPage {
  const items = candidates.slice(0, limit);
  if (candidates.length <= limit) return { items: items.map((candidate) => candidate.operation) };
  const tail = items.at(-1)!;
  return {
    items: items.map((candidate) => candidate.operation),
    nextCursor: encodeCursor("operations", [
      tail.runCreatedAt,
      tail.operation.runId,
      tail.operation.id,
    ]),
  };
}

export async function listOperatorOperations(
  store: ControlPlaneStore,
  runtime: OperatorAutomationRuntime,
  query: OperatorOperationsQuery = {},
): Promise<OperatorOperationsPage> {
  const limit = normalizePageLimit(query.limit);
  const cursor = decodeCursor("operations", query.cursor, 3);
  const candidates: OperationCandidate[] = [];
  let sourceCursor: string | undefined;

  if (cursor) {
    const [createdAt, runId, operationId] = cursor;
    const run = await store.getRun(runId!);
    if (!run || run.createdAt !== createdAt || !storedRunMatches(run, query)) {
      throw new Error("Operations cursor no longer identifies a valid run for this query");
    }
    const sameRun = await operationsForRun(store, runtime, run, query);
    for (const operation of sameRun) {
      if (operation.id > operationId!) candidates.push({ operation, runCreatedAt: run.createdAt });
      if (candidates.length > limit) return resultPage(candidates, limit);
    }
    sourceCursor = encodeCursor("runs", [run.createdAt, run.runId]);
  }

  while (true) {
    const source = await store.listRuns(storageQuery(query, sourceCursor));
    for (const run of source.items) {
      const operations = await operationsForRun(store, runtime, run, query);
      for (const operation of operations) {
        candidates.push({ operation, runCreatedAt: run.createdAt });
        if (candidates.length > limit) return resultPage(candidates, limit);
      }
    }
    if (!source.nextCursor) return resultPage(candidates, limit);
    sourceCursor = source.nextCursor;
  }
}
