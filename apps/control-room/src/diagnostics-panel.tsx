import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  AutomationRegistryEntry,
  AutomationSchedule,
  OperatorConnectionView,
  PublicationGroupRegistryEntry,
} from "@blogmaatic/operator-client";

import { ErrorBanner, LoadingBlock, Panel, StatusPill } from "./components";
import { useConnection } from "./connection";
import { automationPublishesRunnableGroup, groupUsesOnlyActiveConnections } from "./onboarding";

interface LocalDiagnostics {
  readonly productVersion: string;
  readonly runtimeStatus: "running";
}

interface DiagnosticsSnapshot {
  readonly local: LocalDiagnostics;
  readonly operatorService: string;
  readonly connections: readonly OperatorConnectionView[];
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly automations: readonly AutomationRegistryEntry[];
  readonly schedules: readonly AutomationSchedule[];
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { readonly error?: { readonly message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message.trim()) return new Error(body.error.message);
  } catch {
    // Use the status-aware fallback.
  }
  return new Error(`${fallback} (HTTP ${response.status})`);
}

export function DiagnosticsPanel() {
  const { session } = useConnection();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const localResponse = await session.localRequest("/local/diagnostics", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!localResponse.ok) throw await responseError(localResponse, "Runtime diagnostics could not be loaded");
      const local = await localResponse.json() as LocalDiagnostics;

      const [operator, connectionResponse] = await Promise.all([
        session.client.health(),
        session.client.listConnections(),
      ]);

      const groups: PublicationGroupRegistryEntry[] = [];
      let groupCursor: string | undefined;
      do {
        const page = await session.client.listPublicationGroups({ limit: 200, ...(groupCursor ? { cursor: groupCursor } : {}) });
        groups.push(...page.items);
        groupCursor = page.nextCursor;
      } while (groupCursor);

      const automations: AutomationRegistryEntry[] = [];
      let automationCursor: string | undefined;
      do {
        const page = await session.client.listAutomations({ limit: 200, ...(automationCursor ? { cursor: automationCursor } : {}) });
        automations.push(...page.items);
        automationCursor = page.nextCursor;
      } while (automationCursor);

      const schedules: AutomationSchedule[] = [];
      let scheduleCursor: string | undefined;
      do {
        const page = await session.client.listSchedules({ limit: 200, ...(scheduleCursor ? { cursor: scheduleCursor } : {}) });
        schedules.push(...page.items);
        scheduleCursor = page.nextCursor;
      } while (scheduleCursor);

      setSnapshot({
        local,
        operatorService: operator.service,
        connections: connectionResponse.items,
        groups,
        automations,
        schedules,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Diagnostics could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const activeConnectionIds = new Set(snapshot?.connections.filter((connection) => connection.status === "active").map((connection) => connection.id) ?? []);
  const enabledGroups = snapshot?.groups.filter((entry) => entry.enabled) ?? [];
  const runnableGroups = enabledGroups.filter((entry) => groupUsesOnlyActiveConnections(entry, activeConnectionIds));
  const runnableGroupIds = new Set(runnableGroups.map((entry) => entry.group.id));
  const enabledAutomations = snapshot?.automations.filter((entry) => entry.enabled) ?? [];
  const publishingAutomations = enabledAutomations.filter((entry) => automationPublishesRunnableGroup(entry, runnableGroupIds));
  const enabledSchedules = snapshot?.schedules.filter((schedule) => schedule.enabled) ?? [];
  const structuralReady = publishingAutomations.length > 0;

  return (
    <Panel
      title="System diagnostics"
      meta={snapshot ? <StatusPill value={structuralReady ? "publishing ready" : "setup needed"} tone={structuralReady ? "good" : "warn"} /> : "Live local state"}
    >
      <ErrorBanner error={error} />
      {loading && !snapshot ? <LoadingBlock /> : null}
      {snapshot ? (
        <div className="setup-step">
          <p>
            This snapshot reads local runtime and control-plane truth only. It does not contact publishing destinations, so a temporary WordPress, LinkedIn, Facebook, or remote Git outage cannot make the local Blogmaatic runtime appear broken.
          </p>
          <div className="setup-checks">
            <div className="setup-check">
              <div><strong>Blogmaatic {snapshot.local.productVersion}</strong><small>Local runtime · {snapshot.operatorService}</small></div>
              <StatusPill value={snapshot.local.runtimeStatus} tone="good" />
            </div>
            <div className="setup-check">
              <div><strong>{activeConnectionIds.size} active destination{activeConnectionIds.size === 1 ? "" : "s"}</strong><small>{snapshot.connections.length} configured total</small></div>
              <StatusPill value={activeConnectionIds.size > 0 ? "configured" : "action needed"} tone={activeConnectionIds.size > 0 ? "good" : "warn"} />
              <p><Link to="/connections">Review Connections</Link></p>
            </div>
            <div className="setup-check">
              <div><strong>{runnableGroups.length} runnable Publication Group{runnableGroups.length === 1 ? "" : "s"}</strong><small>{enabledGroups.length} enabled · {snapshot.groups.length} total</small></div>
              <StatusPill value={runnableGroups.length > 0 ? "runnable" : "action needed"} tone={runnableGroups.length > 0 ? "good" : "warn"} />
              <p><Link to="/publication-groups">Review Publication Groups</Link></p>
            </div>
            <div className="setup-check">
              <div><strong>{publishingAutomations.length} runnable publishing Automation{publishingAutomations.length === 1 ? "" : "s"}</strong><small>{enabledAutomations.length} enabled · {snapshot.automations.length} total</small></div>
              <StatusPill value={publishingAutomations.length > 0 ? "ready" : "action needed"} tone={publishingAutomations.length > 0 ? "good" : "warn"} />
              <p><Link to="/automations">Review Automations</Link></p>
            </div>
            <div className="setup-check">
              <div><strong>{enabledSchedules.length} enabled Schedule{enabledSchedules.length === 1 ? "" : "s"}</strong><small>{snapshot.schedules.length} configured total</small></div>
              <StatusPill value={snapshot.schedules.length === 0 ? "optional" : enabledSchedules.length > 0 ? "active" : "disabled"} tone={snapshot.schedules.length === 0 ? "neutral" : enabledSchedules.length > 0 ? "good" : "warn"} />
              <p><Link to="/schedules">Review Schedules</Link></p>
            </div>
          </div>
          <div className="security-note">
            Remote destination health is intentionally not probed here. Use Connections when you want to test a publisher. Diagnostics never expose the operator bearer, credential values, vault locators, local data paths, or installer verification material.
          </div>
          <div className="setup-actions">
            <button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh diagnostics"}</button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
