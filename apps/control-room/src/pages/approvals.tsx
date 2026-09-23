import { useCallback, useState } from "react";

import type { OperatorOperation } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel } from "../components";
import { formatInstant } from "../format";
import { usePagedCollection } from "../hooks";

function roleFrom(operation: OperatorOperation): string {
  const evidence = operation.evidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence) && "role" in evidence) {
    const role = evidence.role;
    if (typeof role === "string") return role;
  }
  return "Required role";
}

interface PendingDecision {
  readonly runId: string;
  readonly decision: "approve" | "reject";
}

export function ApprovalsPage() {
  const { session } = useConnection();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listOperations({ kind: "approval_required", limit: 25, ...(cursor ? { cursor } : {}) });
  }, [session]);
  const collection = usePagedCollection("approvals", loader);

  const decide = async (operation: OperatorOperation, decision: "approve" | "reject") => {
    if (!session) return;
    setBusyRun(operation.runId);
    setActionError(null);
    try {
      const note = notes[operation.runId]?.trim();
      await session.client.decideApproval(operation.runId, { decision, ...(note ? { note } : {}) });
      setNotes((current) => ({ ...current, [operation.runId]: "" }));
      setPendingDecision(null);
      await collection.reload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Approval decision failed"));
    } finally {
      setBusyRun(null);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Human gates" title="Approvals" description="Revision-bound decisions currently requested by durable workflows. The server revalidates role, step, and revision before accepting any decision." />
      <ErrorBanner error={actionError ?? collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="approval-grid">
          {collection.items.map((operation) => {
            const pending = pendingDecision?.runId === operation.runId ? pendingDecision.decision : null;
            return (
              <Panel key={operation.id} className="approval-card">
                <div className="approval-card__top">
                  <span className="approval-role">{roleFrom(operation)}</span>
                  <time dateTime={operation.occurredAt}>{formatInstant(operation.occurredAt)}</time>
                </div>
                <h2>{operation.automationId}</h2>
                <p>{operation.detail ?? `Approval is required for publication ${operation.publicationId}.`}</p>
                <dl className="key-values">
                  <div><dt>Publication</dt><dd>{operation.publicationId}</dd></div>
                  <div><dt>Revision</dt><dd>{operation.revisionId}</dd></div>
                  <div><dt>Step</dt><dd>{operation.stepId ?? "Unknown"}</dd></div>
                </dl>
                <label className="field"><span>Decision note <small>optional</small></span><textarea rows={3} value={notes[operation.runId] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [operation.runId]: event.target.value }))} /></label>
                {pending ? (
                  <div className={`confirmation-strip confirmation-strip--${pending === "reject" ? "danger" : "primary"}`} role="alert">
                    <span>Confirm {pending} for revision <strong>{operation.revisionId}</strong>.</span>
                    <div>
                      <button className="button button--quiet" type="button" disabled={busyRun === operation.runId} onClick={() => setPendingDecision(null)}>Cancel</button>
                      <button className={`button ${pending === "reject" ? "button--danger" : "button--primary"}`} type="button" disabled={busyRun === operation.runId} onClick={() => void decide(operation, pending)}>{busyRun === operation.runId ? "Submitting…" : `Confirm ${pending}`}</button>
                    </div>
                  </div>
                ) : (
                  <div className="approval-actions">
                    <button className="button button--danger" type="button" disabled={busyRun === operation.runId} onClick={() => setPendingDecision({ runId: operation.runId, decision: "reject" })}>Reject</button>
                    <button className="button button--primary" type="button" disabled={busyRun === operation.runId} onClick={() => setPendingDecision({ runId: operation.runId, decision: "approve" })}>Approve</button>
                  </div>
                )}
              </Panel>
            );
          })}
          {collection.items.length === 0 ? <EmptyState title="No approvals waiting">No durable workflow is currently paused for a human decision.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}
