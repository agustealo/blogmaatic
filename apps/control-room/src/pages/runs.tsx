import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import type {
  AutomationRunResult,
  ControlPlaneRunRecord,
  RunListQuery,
} from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, humanize, triggerLabel } from "../format";
import { usePagedCollection } from "../hooks";

const phases = ["running", "waiting_approval", "delaying", "completed", "stopped", "rejected"] as const;
const dispatchStates = ["prepared", "started", "launch_failed"] as const;

export function RunsPage() {
  const { session } = useConnection();
  const [phase, setPhase] = useState<RunListQuery["runtimePhase"] | "">("");
  const [dispatch, setDispatch] = useState<RunListQuery["dispatchState"] | "">("");
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listRuns({
      limit: 30,
      ...(phase ? { runtimePhase: phase } : {}),
      ...(dispatch ? { dispatchState: dispatch } : {}),
      ...(cursor ? { cursor } : {}),
    });
  }, [dispatch, phase, session]);
  const collection = usePagedCollection(`runs:${phase}:${dispatch}`, loader);

  return (
    <>
      <PageHeader eyebrow="Execution" title="Runs" description="Durable run identities, immutable publication snapshots, dispatch state, and current runtime phase." />
      <div className="toolbar">
        <label className="field field--inline"><span>Runtime phase</span><select value={phase} onChange={(event) => setPhase(event.target.value as typeof phase)}><option value="">All phases</option>{phases.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
        <label className="field field--inline"><span>Dispatch</span><select value={dispatch} onChange={(event) => setDispatch(event.target.value as typeof dispatch)}><option value="">All dispatch states</option>{dispatchStates.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()}>Refresh</button>
      </div>
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <Panel className="table-panel">
          <div className="data-table data-table--runs">
            <div className="data-table__head"><span>Automation</span><span>Publication</span><span>Trigger</span><span>Status</span><span>Updated</span></div>
            {collection.items.map((run) => (
              <Link className="data-table__row" key={run.runId} to={`/runs/${encodeURIComponent(run.runId)}`}>
                <span><strong>{run.request.definition.name}</strong><small>{run.request.definition.id} v{run.request.definition.version}</small></span>
                <span><strong>{run.request.publication.current.content.title}</strong><small>{run.request.publication.id}</small></span>
                <span>{triggerLabel(run.request.trigger.kind)}</span>
                <span><StatusPill value={run.runtimePhase ?? run.dispatchState} /></span>
                <span>{formatInstant(run.updatedAt)}</span>
              </Link>
            ))}
          </div>
          {collection.items.length === 0 ? <EmptyState title="No matching runs">No durable run record matches these filters.</EmptyState> : null}
        </Panel>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}

function StepResults({ result }: { readonly result: AutomationRunResult }) {
  return (
    <div className="step-results">
      {result.stepResults.map((step) => (
        <article className="step-result" key={step.stepId}>
          <div><strong>{step.stepId}</strong><StatusPill value={step.outcome} /></div>
          <small>{humanize(step.kind)}</small>
          {step.kind === "publish_group" ? (
            <div className="receipt-list">
              {step.receipts.map((receipt) => (
                <div key={`${receipt.routeId}:${receipt.projectionId}`}><span>{receipt.routeId}</span><StatusPill value={receipt.status} /></div>
              ))}
            </div>
          ) : null}
          {step.kind === "approval" ? <p>Decision by {step.approval.approvedBy} · {formatInstant(step.approval.decidedAt)}</p> : null}
          {step.kind === "delay" ? <p>{step.durationMs.toLocaleString()} ms</p> : null}
        </article>
      ))}
    </div>
  );
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const { session } = useConnection();
  const [run, setRun] = useState<ControlPlaneRunRecord | null>(null);
  const [result, setResult] = useState<AutomationRunResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session || !runId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void session.client.getRun(runId).then(async (record) => {
      if (!active) return;
      setRun(record);
      if (record.runtimePhase && ["completed", "stopped", "rejected"].includes(record.runtimePhase)) {
        const terminal = await session.client.getRunResult(runId);
        if (active) setResult(terminal);
      } else {
        setResult(null);
      }
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause : new Error("Run request failed"));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runId, session]);

  return (
    <>
      <PageHeader eyebrow="Run detail" title={run?.request.definition.name ?? "Run"} description={run ? `${run.runId} · ${run.request.publication.current.content.title}` : runId} actions={<Link className="button button--quiet" to="/runs">Back to runs</Link>} />
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : null}
      {run ? (
        <div className="detail-grid">
          <Panel title="Execution">
            <dl className="key-values key-values--wide">
              <div><dt>Runtime phase</dt><dd><StatusPill value={run.runtimePhase ?? "not observed"} /></dd></div>
              <div><dt>Dispatch</dt><dd><StatusPill value={run.dispatchState} /></dd></div>
              <div><dt>Trigger</dt><dd>{triggerLabel(run.request.trigger.kind)}</dd></div>
              <div><dt>Updated</dt><dd>{formatInstant(run.updatedAt)}</dd></div>
              <div><dt>Publication</dt><dd>{run.request.publication.id}</dd></div>
              <div><dt>Revision</dt><dd>{run.request.publication.current.id}</dd></div>
            </dl>
          </Panel>
          <Panel title="Automation snapshot">
            <div className="definition-steps">
              {run.request.definition.steps.map((step, index) => (
                <div className="definition-step" key={step.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step.id}</strong><small>{humanize(step.kind)}</small></div></div>
              ))}
            </div>
          </Panel>
          <Panel title="Terminal result" className="detail-grid__wide">
            {result ? <><div className="result-summary"><StatusPill value={result.outcome} /><span>Completed {formatInstant(result.completedAt)}</span></div><StepResults result={result} /></> : <EmptyState title="Run is not terminal">Terminal step results become available from the durable runtime after completion, stop, or rejection.</EmptyState>}
          </Panel>
        </div>
      ) : null}
    </>
  );
}
