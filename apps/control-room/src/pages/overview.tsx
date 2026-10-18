import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  ConnectionsResponse,
  OperatorOperationsPage,
  PublicationWorkspacePage,
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
  readonly publications: PublicationWorkspacePage;
  readonly connections: ConnectionsResponse;
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
      const [operations, runs, schedules, publications, connections] = await Promise.all([
        session.client.listOperations({ limit: 12 }),
        session.client.listRuns({ limit: 12 }),
        session.client.listSchedules({ enabled: true, limit: 12 }),
        session.client.listPublications({ limit: 12 }),
        session.client.listConnections(),
      ]);
      setData({ operations, runs, schedules, publications, connections });
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
        eyebrow="Publishing home"
        title="Home"
        description="See what you're working on, what publishes next, where your content is connected, and anything that needs your attention."
        actions={<button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>Refresh</button>}
      />
      <ErrorBanner error={error} />
      {loading && !data ? <LoadingBlock /> : null}
      {data ? (
        <>
          <div className="metric-grid">
            <Metric label="Content" value={pageCount(data.publications)} note="recent workspace items" />
            <Metric label="Destinations" value={String(data.connections.items.filter((item) => item.status === "active").length)} note="connected and enabled" />
            <Metric label="Scheduled" value={pageCount(data.schedules)} note="upcoming publication plans" />
            <Metric label="Needs attention" value={pageCount(data.operations)} note="issues or decisions to review" />
          </div>
          <div className="home-actions">
            <Link className="home-action-card home-action-card--primary" to="/publications">
              <span>Content</span>
              <strong>Create or continue a publication</strong>
              <small>Write, import, revise, approve and publish from one workspace.</small>
            </Link>
            <Link className="home-action-card" to="/schedules">
              <span>Calendar</span>
              <strong>Plan what publishes next</strong>
              <small>Review upcoming publication schedules and timing.</small>
            </Link>
            <Link className="home-action-card" to="/connections">
              <span>Destinations</span>
              <strong>Manage where content goes</strong>
              <small>WordPress, Jekyll and your other connected publishing channels.</small>
            </Link>
          </div>

          <div className="overview-grid">
            <Panel title="Recent content" meta={<Link to="/publications">Open Content</Link>}>
              <div className="compact-list">
                {data.publications.items.slice(0, 6).map((entry) => (
                  <Link className="compact-row" key={entry.publication.id} to={`/publications/${encodeURIComponent(entry.publication.id)}`}>
                    <span>
                      <strong>{entry.publication.current.content.title}</strong>
                      <small>Revision {entry.publication.current.ordinal} · updated {formatInstant(entry.updatedAt)}</small>
                    </span>
                    <StatusPill value={entry.publication.status} />
                  </Link>
                ))}
                {data.publications.items.length === 0 ? (
                  <EmptyState title="Create your first publication">Your content library starts here. Create a draft or import an existing WordPress post.</EmptyState>
                ) : null}
              </div>
            </Panel>

            <Panel title="Needs attention" meta={<Link to="/activity">Open Activity</Link>}>
              <div className="operation-stack">
                {data.operations.items.slice(0, 5).map((operation) => <OperationCard key={operation.id} operation={operation} compact />)}
                {data.operations.items.length === 0 ? <EmptyState title="You're clear">Nothing currently needs your attention.</EmptyState> : null}
              </div>
            </Panel>

            <Panel title="Publishing next" meta={<Link to="/schedules">Open Calendar</Link>}>
              <div className="compact-list">
                {data.schedules.items.slice(0, 5).map((schedule) => (
                  <div className="compact-row" key={schedule.id}>
                    <span><strong>{schedule.localDate} · {schedule.localTime}</strong><small>{schedule.timezone} · {schedule.automationId}</small></span>
                    <span className="compact-row__end"><small>Next</small><strong>{formatInstant(schedule.nextFireAt)}</strong></span>
                  </div>
                ))}
                {data.schedules.items.length === 0 ? <EmptyState title="Nothing scheduled">Schedule an approved publication when you're ready to plan ahead.</EmptyState> : null}
              </div>
            </Panel>

            <Panel title="Recent publishing" meta={<Link to="/activity">View Activity</Link>}>
              <div className="compact-list">
                {data.runs.items.slice(0, 6).map((run) => (
                  <Link className="compact-row" key={run.runId} to={`/runs/${encodeURIComponent(run.runId)}`}>
                    <span><strong>{run.request.publication.current.content.title}</strong><small>{run.request.definition.name}</small></span>
                    <span className="compact-row__end"><StatusPill value={run.runtimePhase ?? run.dispatchState} /><small>{formatInstant(run.updatedAt)}</small></span>
                  </Link>
                ))}
                {data.runs.items.length === 0 ? <EmptyState title="No publishing activity yet">Your publication history will appear here after the first delivery.</EmptyState> : null}
              </div>
            </Panel>
          </div>
          <p className="refresh-stamp">{refreshedAt ? `Last refreshed ${formatInstant(refreshedAt)}` : ""} · Open Activity for detailed publishing evidence and system history.</p>
        </>
      ) : null}
    </>
  );
}
