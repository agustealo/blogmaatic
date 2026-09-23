import { useCallback, useState } from "react";

import type { OperatorOperationKind } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, OperationCard, PageHeader } from "../components";
import { usePagedCollection } from "../hooks";

const kinds: readonly [OperatorOperationKind, string][] = [
  ["approval_required", "Approval required"],
  ["launch_failed", "Launch failed"],
  ["run_stopped", "Run stopped"],
  ["run_rejected", "Run rejected"],
  ["delivery_blocked", "Delivery blocked"],
  ["delivery_awaiting_approval", "Delivery awaiting approval"],
  ["delivery_drifted", "Remote drift"],
  ["delivery_unreachable", "Destination unreachable"],
];

export function OperationsPage() {
  const { session } = useConnection();
  const [kind, setKind] = useState<OperatorOperationKind | "">("");
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listOperations({ limit: 25, ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
  }, [kind, session]);
  const collection = usePagedCollection(`operations:${kind}`, loader);

  return (
    <>
      <PageHeader eyebrow="Live attention" title="Operations" description="Approval, launch, delivery, drift, and destination conditions that currently require operator awareness." />
      <div className="toolbar">
        <label className="field field--inline"><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as OperatorOperationKind | "")}><option value="">All attention</option>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()}>Refresh</button>
      </div>
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="operation-stack operation-stack--roomy">
          {collection.items.map((operation) => <OperationCard key={operation.id} operation={operation} />)}
          {collection.items.length === 0 ? <EmptyState title="No matching operations">The live projection currently has nothing in this category.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}
