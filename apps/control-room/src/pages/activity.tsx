import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  OperatorOperation,
  OperatorOperationsPage,
  RunPage,
} from "@blogmaatic/operator-client";

import {
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  OperationCard,
  PageHeader,
  Panel,
  StatusPill,
} from "../components";
import { useConnection } from "../connection";
import { formatInstant } from "../format";

interface ActivityData {
  readonly attention: OperatorOperationsPage;
  readonly approvals: OperatorOperationsPage;
  readonly runs: RunPage;
}

function ApprovalPreview({ operation }: { readonly operation: OperatorOperation }) {
  return (
    <article className="activity-approval">
      <div>
        <strong>{operation.detail ?? "Approval required"}</strong>
        <small>{formatInstant(operation.occurredAt)}</small>
      </div>
      <div className="activity-approval__actions">
        <StatusPill value="waiting" tone="warn" />
        <Link className="button button--quiet" to="/approvals">Review</Link>
      </div>
    </article>
  );
}

export function ActivityPage() {
  const { session } = useConnection();
  const [data, setData] = useState<ActivityData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const [attention, approvals, runs] = await Promise.all([
        session.client.listOperations({ limit: 12 }),
        session.client.listOperations({ kind: "approval_required", limit: 8 }),
        session.client.listRuns({ limit: 10 }),
      ]);
      setData({ attention, approvals, runs });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Activity could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <PageHeader
        eyebrow="Publishing activity"
        title="Activity"
        description="See what needs you, what Blogmaatic recently published, and the detailed evidence behind every action."
        actions={<button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>Refresh</button>}
      />
      <ErrorBanner error={error} />
      {loading && !data ? <LoadingBlock /> : null}

      {data ? (
        <>
          <div className="activity-summary">
            <Link className="activity-summary-card" to="/operations">
              <span>Needs attention</span>
              <strong>{data.attention.items.length}{data.attention.nextCursor ? "+" : ""}</strong>
              <small>Problems and delivery conditions</small>
            </Link>
            <Link className="activity-summary-card" to="/approvals">
              <span>Approvals waiting</span>
              <strong>{data.approvals.items.length}{data.approvals.nextCursor ? "+" : ""}</strong>
              <small>Human decisions paused in workflows</small>
            </Link>
            <Link className="activity-summary-card" to="/runs">
              <span>Recent publishing</span>
              <strong>{data.runs.items.length}{data.runs.nextCursor ? "+" : ""}</strong>
              <small>Latest durable publication runs</small>
            </Link>
            <Link className="activity-summary-card" to="/audit">
              <span>System history</span>
              <strong>Audit</strong>
              <small>Technical evidence and operator actions</small>
            </Link>
          </div>

          <div className="activity-grid">
            <Panel title="Needs your attention" meta={<Link to="/operations">View all</Link>}>
              <div className="operation-stack">
                {data.attention.items.slice(0, 5).map((operation) => (
                  <OperationCard key={operation.id} operation={operation} compact />
                ))}
                {data.attention.items.length === 0 ? (
                  <EmptyState title="Nothing needs attention">Your publishing system has no current delivery or runtime issue requiring action.</EmptyState>
                ) : null}
              </div>
            </Panel>

            <Panel title="Approvals waiting" meta={<Link to="/approvals">Review approvals</Link>}>
              <div className="activity-approval-list">
                {data.approvals.items.slice(0, 5).map((operation) => (
                  <ApprovalPreview key={operation.id} operation={operation} />
                ))}
                {data.approvals.items.length === 0 ? (
                  <EmptyState title="No approvals waiting">No publishing workflow is paused for a decision.</EmptyState>
                ) : null}
              </div>
            </Panel>

            <Panel title="Recent publishing" meta={<Link to="/runs">View all activity</Link>} className="activity-grid__wide">
              <div className="activity-run-list">
                {data.runs.items.slice(0, 8).map((run) => (
                  <Link className="activity-run-row" key={run.runId} to={`/runs/${encodeURIComponent(run.runId)}`}>
                    <span>
                      <strong>{run.request.publication.current.content.title}</strong>
                      <small>{run.request.definition.name}</small>
                    </span>
                    <span>
                      <StatusPill value={run.runtimePhase ?? run.dispatchState} />
                      <small>{formatInstant(run.updatedAt)}</small>
                    </span>
                  </Link>
                ))}
                {data.runs.items.length === 0 ? (
                  <EmptyState title="No publishing activity yet">Completed and in-progress publication runs will appear here.</EmptyState>
                ) : null}
              </div>
            </Panel>
          </div>

          <div className="activity-advanced">
            <span>Need the technical trail?</span>
            <Link to="/audit">Open audit history</Link>
            <Link to="/runs">Open all runs</Link>
          </div>
        </>
      ) : null}
    </>
  );
}
