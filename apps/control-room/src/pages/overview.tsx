import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  AutomationPage,
  OperatorOperationsPage,
  RunPage,
  SchedulePage,
} from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { EmptyState, ErrorBanner, LoadingBlock, Metric, OperationCard, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, pageCount } from "../format";

interface DashboardData {
  readonly operations: OperatorOperationsPage;
  readonly runs: RunPage;
  readonly schedules: SchedulePage;
  readonly automations: AutomationPage;
}

export function OverviewPage() {
  const { session } = useConnection();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const [operations, runs, schedules, automations] = await Promise.all([
        session.client.listOperations({ limit: 12 }),
        session.client.listRuns({ limit: 12 }),
        session.client.listSchedules({ enabled: true, limit: 12 }),
        session.client.listAutomations({ limit: 12 }),
      ]);
      setData({ operations, runs, schedules, automations });
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Overview request failed"));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="Control Room"
        title="Overview"
        description="A live operational view over the canonical control plane and durable runtime."
        actions={<button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>Refresh</button>}
      />
      <ErrorBanner error={error} />
      {loading && !data ? <LoadingBlock /> : null}
      {data ? (
        <>
          <div className="metric-grid">
            <Metric label="Needs attention" value={pageCount(data.operations)} note="open operations" />
            <Metric label="Recent runs" value={pageCount(data.runs)} note="latest execution records" />
            <Metric label="Enabled schedules" value={pageCount(data.schedules)} note="visible schedules" />
            <Metric label="Automations" value={pageCount(data.automations)} note="active heads" />
          </div>
          <div className="overview-grid">
            <Panel title="Needs attention" meta={<Link to="/operations">View all</Link>}>
              <div className="operation-stack">
                {data.operations.items.slice(0, 5).map((operation) => <OperationCard key={operation.id} operation={operation} compact />)}
                {data.operations.items.length === 0 ? <EmptyState title="Clear queue">No current operation requires attention.</EmptyState> : null}
              </div>
            </Panel>
            <Panel title="Recent runs" meta={<Link to="/runs">View all</Link>}>
              <div className="compact-list">
                {data.runs.items.slice(0, 6).map((run) => (
                  <Link className="compact-row" key={run.runId} to={`/runs/${encodeURIComponent(run.runId)}`}>
                    <span><strong>{run.request.definition.name}</strong><small>{run.request.publication.current.content.title}</small></span>
                    <span className="compact-row__end"><StatusPill value={run.runtimePhase ?? run.dispatchState} /><small>{formatInstant(run.updatedAt)}</small></span>
                  </Link>
                ))}
                {data.runs.items.length === 0 ? <EmptyState title="No runs yet">Execution history will appear here after a real trigger is accepted.</EmptyState> : null}
              </div>
            </Panel>
            <Panel title="Enabled schedules" meta={<Link to="/schedules">View all</Link>}>
              <div className="compact-list">
                {data.schedules.items.slice(0, 5).map((schedule) => (
                  <div className="compact-row" key={schedule.id}>
                    <span><strong>{schedule.id}</strong><small>{schedule.automationId} v{schedule.automationVersion}</small></span>
                    <span className="compact-row__end"><small>Next</small><strong>{formatInstant(schedule.nextFireAt)}</strong></span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Automation heads" meta={<Link to="/automations">Manage</Link>}>
              <div className="compact-list">
                {data.automations.items.slice(0, 5).map((entry) => (
                  <Link className="compact-row" key={entry.definition.id} to={`/automations/${encodeURIComponent(entry.definition.id)}`}>
                    <span><strong>{entry.definition.name}</strong><small>{entry.definition.id} · v{entry.definition.version}</small></span>
                    <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                  </Link>
                ))}
              </div>
            </Panel>
          </div>
          <p className="refresh-stamp">{refreshedAt ? `Last refreshed ${formatInstant(refreshedAt)}` : ""} · A “+” count means more records exist beyond the first page.</p>
        </>
      ) : null}
    </>
  );
}
