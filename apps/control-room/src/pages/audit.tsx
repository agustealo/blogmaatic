import { type FormEvent, useCallback, useState } from "react";

import type { AuditListQuery } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, safeJson } from "../format";
import { usePagedCollection } from "../hooks";

interface Filters {
  readonly action: string;
  readonly actorId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly phase: "" | "intent" | "succeeded" | "failed";
}

const emptyFilters: Filters = { action: "", actorId: "", resourceType: "", resourceId: "", phase: "" };

export function AuditPage() {
  const { session } = useConnection();
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    const query: AuditListQuery = {
      limit: 40,
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.phase ? { phase: filters.phase } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return session.client.listAudit(query);
  }, [filters, session]);
  const collection = usePagedCollection(`audit:${JSON.stringify(filters)}`, loader);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters(draft);
  };

  return (
    <>
      <PageHeader eyebrow="Evidence" title="Audit" description="Append-only operator intent and outcome evidence. Intent-only correlations mean the outcome evidence is incomplete, not that the business action failed." />
      <Panel className="filter-panel">
        <form className="audit-filters" onSubmit={submit}>
          <label className="field"><span>Action</span><input value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} placeholder="run.start.manual" /></label>
          <label className="field"><span>Actor</span><input value={draft.actorId} onChange={(event) => setDraft({ ...draft, actorId: event.target.value })} placeholder="operator id" /></label>
          <label className="field"><span>Resource type</span><input value={draft.resourceType} onChange={(event) => setDraft({ ...draft, resourceType: event.target.value })} placeholder="run" /></label>
          <label className="field"><span>Resource id</span><input value={draft.resourceId} onChange={(event) => setDraft({ ...draft, resourceId: event.target.value })} /></label>
          <label className="field"><span>Phase</span><select value={draft.phase} onChange={(event) => setDraft({ ...draft, phase: event.target.value as Filters["phase"] })}><option value="">All</option><option value="intent">Intent</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
          <div className="filter-actions"><button className="button button--quiet" type="button" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); }}>Clear</button><button className="button button--primary" type="submit">Apply filters</button></div>
        </form>
      </Panel>
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="audit-timeline">
          {collection.items.map((entry) => (
            <article className="audit-entry" key={entry.id}>
              <div className="audit-entry__rail"><span /></div>
              <div className="audit-entry__body">
                <div className="audit-entry__headline"><strong>{entry.action}</strong><StatusPill value={entry.phase} tone={entry.phase === "succeeded" ? "good" : entry.phase === "failed" ? "bad" : "neutral"} /><time dateTime={entry.occurredAt}>{formatInstant(entry.occurredAt)}</time></div>
                <p><strong>{entry.actor.id}</strong> · {entry.actor.kind} · {entry.resource.type}/{entry.resource.id}</p>
                <div className="audit-entry__ids"><span>Correlation {entry.correlationId}</span>{entry.runId ? <span>Run {entry.runId}</span> : null}{entry.requestId ? <span>Request {entry.requestId}</span> : null}</div>
                <details><summary>Evidence</summary><pre>{safeJson(entry.evidence)}</pre></details>
              </div>
            </article>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No audit entries">No ledger evidence matches the selected filters.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}
