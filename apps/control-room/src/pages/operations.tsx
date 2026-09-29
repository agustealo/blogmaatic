import { useCallback, useState } from "react";

import type { OperatorOperationKind } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, OperationCard, PageHeader, Panel, StatusPill } from "../components";
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

interface ProductUpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly updateAvailable: boolean;
  readonly packageName?: string;
  readonly installerOpened?: boolean;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { readonly error?: { readonly message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message.trim()) return new Error(body.error.message);
  } catch {
    // Fall through to the status-aware message.
  }
  return new Error(`${fallback} (HTTP ${response.status})`);
}

function ProductUpdatePanel() {
  const { session } = useConnection();
  const [status, setStatus] = useState<ProductUpdateStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const check = useCallback(async () => {
    if (!session) return;
    setBusy("check");
    setError(null);
    try {
      const response = await session.localRequest("/local/update", { method: "GET", headers: { accept: "application/json" } });
      if (!response.ok) throw await responseError(response, "Update check failed");
      setStatus(await response.json() as ProductUpdateStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Update check failed"));
    } finally {
      setBusy(null);
    }
  }, [session]);

  const install = useCallback(async () => {
    if (!session || !status?.updateAvailable) return;
    setBusy("install");
    setError(null);
    try {
      const response = await session.localRequest("/local/update/install", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw await responseError(response, "Verified installer preparation failed");
      setStatus(await response.json() as ProductUpdateStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Verified installer preparation failed"));
    } finally {
      setBusy(null);
    }
  }, [session, status]);

  const meta = status
    ? <StatusPill value={status.updateAvailable ? "update available" : "current"} tone={status.updateAvailable ? "warn" : "good"} />
    : "On demand";

  return (
    <Panel title="Product update" meta={meta}>
      <ErrorBanner error={error} />
      {!status ? (
        <div className="setup-step">
          <p>Check Blogmaatic's trusted release channel when you choose. The local runtime validates release metadata and the exact native installer. Opening this page never checks the network automatically.</p>
          <div className="setup-actions">
            <button className="button button--quiet" type="button" onClick={() => void check()} disabled={busy !== null}>
              {busy === "check" ? "Checking…" : "Check for updates"}
            </button>
          </div>
        </div>
      ) : (
        <div className="setup-step">
          <div className="setup-checks">
            <div className="setup-check">
              <div><strong>Installed</strong><small>Blogmaatic {status.currentVersion}</small></div>
              <StatusPill value="local" tone="neutral" />
            </div>
            <div className="setup-check">
              <div><strong>Trusted release</strong><small>{status.tag} · Blogmaatic {status.latestVersion}</small></div>
              <StatusPill value={status.updateAvailable ? "newer" : "current"} tone={status.updateAvailable ? "warn" : "good"} />
            </div>
          </div>
          {status.updateAvailable ? (
            <p>{status.packageName ? `${status.packageName} will be downloaded and verified locally. ` : ""}Blogmaatic never replaces the running app silently. After verification, your operating system opens the native installer and owns installation approval.</p>
          ) : <p>This installation matches the latest trusted stable Blogmaatic release.</p>}
          {status.installerOpened ? (
            <div className="success-banner" role="status">
              <strong>Verified installer opened.</strong>
              <span>Complete the operating system installer when ready. Your durable Blogmaatic data directory is kept separate from application files.</span>
            </div>
          ) : null}
          <div className="setup-actions">
            <button className="button button--quiet" type="button" onClick={() => void check()} disabled={busy !== null}>
              {busy === "check" ? "Checking…" : "Check again"}
            </button>
            {status.updateAvailable && !status.installerOpened ? (
              <button className="button button--primary" type="button" onClick={() => void install()} disabled={busy !== null}>
                {busy === "install" ? "Verifying installer…" : "Download & open verified installer"}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}

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
      <PageHeader eyebrow="Live attention" title="Operations" description="Approval, delivery, runtime, and product-lifecycle conditions that currently require your attention." />
      <ProductUpdatePanel />
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
