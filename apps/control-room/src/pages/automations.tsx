import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";

import type { AutomationRegistryEntry } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, triggerLabel } from "../format";
import { usePagedCollection } from "../hooks";

function VersionsPanel({ automationId, changeNonce, onChanged }: { readonly automationId: string; readonly changeNonce: number; readonly onChanged: () => void }) {
  const { session } = useConnection();
  const [actionError, setActionError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomationVersions(automationId, {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
  }, [automationId, session]);
  const collection = usePagedCollection(`automation-versions:${automationId}:${changeNonce}`, loader);

  const activate = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
    setBusy(entry.definition.version);
    setActionError(null);
    try {
      await session.client.activateAutomation(automationId, entry.definition.version, { enabled: true });
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Activation failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Version history" meta={<Link to="/automations">Close</Link>} className="automation-detail">
      <ErrorBanner error={actionError ?? collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="version-list">
          {collection.items.map((entry) => (
            <div className="version-row" key={entry.definition.version}>
              <div><strong>v{entry.definition.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.definition.steps.length} steps · {triggerLabel(entry.definition.trigger.kind)}</span>
              <StatusPill value={entry.isActiveVersion ? (entry.enabled ? "enabled" : "disabled") : "inactive"} />
              {!entry.isActiveVersion ? <button className="button button--quiet" type="button" disabled={busy === entry.definition.version} onClick={() => void activate(entry)}>{busy === entry.definition.version ? "Activating…" : "Activate"}</button> : null}
            </div>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No versions found">No immutable versions are available for this automation.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

export function AutomationsPage() {
  const { automationId } = useParams();
  const { session } = useConnection();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomations({ limit: 30, ...(cursor ? { cursor } : {}) });
  }, [session]);
  const collection = usePagedCollection(`automations:${changeNonce}`, loader);

  const toggle = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
    setBusy(entry.definition.id);
    setActionError(null);
    try {
      await session.client.activateAutomation(entry.definition.id, entry.definition.version, { enabled: !entry.enabled });
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Automation update failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Automation registry" title="Automations" description="Immutable automation versions with one explicit active head per automation identity." />
      <ErrorBanner error={actionError ?? collection.error} />
      <div className={`automation-layout ${automationId ? "automation-layout--open" : ""}`}>
        <Panel className="table-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="automation-list">
              {collection.items.map((entry) => (
                <article className="automation-row" key={entry.definition.id}>
                  <Link className="automation-row__identity" to={`/automations/${encodeURIComponent(entry.definition.id)}`}>
                    <strong>{entry.definition.name}</strong>
                    <small>{entry.definition.id}</small>
                  </Link>
                  <div><small>Trigger</small><span>{triggerLabel(entry.definition.trigger.kind)}</span></div>
                  <div><small>Version</small><span>v{entry.definition.version}</span></div>
                  <div><small>Steps</small><span>{entry.definition.steps.length}</span></div>
                  <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                  <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => void toggle(entry)}>{busy === entry.definition.id ? "Saving…" : entry.enabled ? "Disable" : "Enable"}</button>
                </article>
              ))}
              {collection.items.length === 0 ? <EmptyState title="No automations registered">Register a real automation through the operator API before it can be managed here.</EmptyState> : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>
        {automationId ? <VersionsPanel automationId={automationId} changeNonce={changeNonce} onChanged={() => setChangeNonce((value) => value + 1)} /> : null}
      </div>
    </>
  );
}
