import type { AutomationRunPhase } from "@blogmaatic/automation";
import {
  encodeCursor,
  normalizePageLimit,
  type ControlPlaneRunRecord,
  type ControlPlaneStore,
  type Page,
  type RunListQuery,
} from "@blogmaatic/control-plane";

import type { OperatorAutomationRuntime } from "./types.js";

export interface OperatorRunListQuery extends RunListQuery {
  readonly runtimePhase?: AutomationRunPhase;
}

function storageQuery(query: OperatorRunListQuery, limit: number, cursor: string | undefined): RunListQuery {
  const {
    runtimePhase: _runtimePhase,
    limit: _limit,
    cursor: _cursor,
    ...filters
  } = query;
  return {
    ...filters,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function liveRun(
  store: ControlPlaneStore,
  runtime: OperatorAutomationRuntime,
  run: ControlPlaneRunRecord,
): Promise<ControlPlaneRunRecord> {
  if (run.dispatchState !== "started") return run;
  const status = await runtime.status(run.runId);
  if (!status) return run;
  if (run.runtimePhase !== status.phase) {
    await store.updateRunPhase(run.runId, status.phase, status.updatedAt);
  }
  return {
    ...run,
    runtimePhase: status.phase,
    updatedAt: status.updatedAt,
  };
}

export async function listOperatorRuns(
  store: ControlPlaneStore,
  runtime: OperatorAutomationRuntime,
  query: OperatorRunListQuery = {},
): Promise<Page<ControlPlaneRunRecord>> {
  if (query.runtimePhase === undefined) return store.listRuns(query);

  const limit = normalizePageLimit(query.limit);
  const matches: ControlPlaneRunRecord[] = [];
  let sourceCursor = query.cursor;
  let lastReturnedCursor: string | undefined;

  while (true) {
    const source = await store.listRuns(storageQuery(query, 200, sourceCursor));
    for (const stored of source.items) {
      const run = await liveRun(store, runtime, stored);
      if (run.runtimePhase !== query.runtimePhase) continue;
      if (matches.length < limit) {
        matches.push(run);
        lastReturnedCursor = encodeCursor("runs", [run.createdAt, run.runId]);
        continue;
      }
      return {
        items: matches,
        ...(lastReturnedCursor ? { nextCursor: lastReturnedCursor } : {}),
      };
    }
    if (!source.nextCursor) return { items: matches };
    sourceCursor = source.nextCursor;
  }
}
