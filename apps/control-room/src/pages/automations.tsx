import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  AutomationDefinition,
  AutomationRegistryEntry,
  PublicationGroupRegistryEntry,
  PublicationWorkspaceEntry,
} from "@blogmaatic/operator-client";

import { AutomationStudioPanel } from "../automation-studio";
import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, triggerLabel } from "../format";
import { usePagedCollection } from "../hooks";

function VersionsPanel({ automationId, changeNonce, onChanged }: { readonly automationId: string; readonly changeNonce: number; readonly onChanged: () => void }) {
  const { session } = useConnection();
  const [actionError, setActionError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomationVersions(automationId, {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
  }, [automationId, session]);
  const collection = usePagedCollection(`automation-versions:${automationId}:${changeNonce}`, loader);
  const scheduleOwned = collection.items.some((entry) => entry.definition.trigger.kind === "schedule");

  const activate = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
    if (entry.definition.trigger.kind === "schedule") {
      setActionError(new Error("Schedule-trigger Automation versions are activated through the Schedules workflow"));
      return;
    }
    setBusy(entry.definition.version);
    setActionError(null);
    try {
      await session.client.activateAutomation(automationId, entry.definition.version, { enabled: true });
      setPendingVersion(null);
      onChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Activation failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Version history" meta={<Link to={scheduleOwned ? "/schedules" : "/automations"}>{scheduleOwned ? "Open Schedules" : "Close"}</Link>} className="automation-detail">
      <ErrorBanner error={actionError ?? collection.error} />
      {scheduleOwned ? (
        <div className="warning-banner" role="status">
          <strong>Schedule-owned Automation.</strong>
          <span>Versions remain inspectable here, but activation stays with the Schedules workflow so pinned schedule snapshots cannot be silently invalidated.</span>
        </div>
      ) : null}
      {collection.loading ? <LoadingBlock /> : (
        <div className="version-list">
          {collection.items.map((entry) => (
            <div className="version-row" key={entry.definition.version}>
              <div><strong>v{entry.definition.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.definition.steps.length} steps · {triggerLabel(entry.definition.trigger.kind)}</span>
              <StatusPill value={entry.isActiveVersion ? (entry.enabled ? "enabled" : "disabled") : "inactive"} />
              {!entry.isActiveVersion && entry.definition.trigger.kind !== "schedule" ? (
                pendingVersion === entry.definition.version ? (
                  <div className="inline-confirm-actions" aria-label={`Confirm activation of version ${entry.definition.version}`}>
                    <button className="button button--quiet" type="button" disabled={busy === entry.definition.version} onClick={() => setPendingVersion(null)}>Cancel</button>
                    <button className="button button--primary" type="button" disabled={busy === entry.definition.version} onClick={() => void activate(entry)}>{busy === entry.definition.version ? "Activating…" : "Confirm"}</button>
                  </div>
                ) : <button className="button button--quiet" type="button" onClick={() => setPendingVersion(entry.definition.version)}>Activate</button>
              ) : entry.definition.trigger.kind === "schedule" ? <Link className="button button--quiet" to="/schedules">Managed in Schedules</Link> : null}
            </div>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No versions found">No immutable versions are available for this automation.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

function RunNowPanel({ entry, onCancel }: { readonly entry: AutomationRegistryEntry; readonly onCancel: () => void }) {
  const { session } = useConnection();
  const navigate = useNavigate();
  const [publications, setPublications] = useState<readonly PublicationWorkspaceEntry[]>([]);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [publicationId, setPublicationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const publicationItems: PublicationWorkspaceEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await session.client.listPublications({ limit: 200, ...(cursor ? { cursor } : {}) });
          publicationItems.push(...page.items.filter((item) => item.publication.status !== "archived"));
          cursor = page.nextCursor;
        } while (cursor);

        const groupIds = [...new Set(entry.definition.steps
          .filter((step): step is Extract<typeof step, { kind: "publish_group" }> => step.kind === "publish_group")
          .map((step) => step.groupId))];
        const groupItems = await Promise.all(groupIds.map((id) => session.client.getPublicationGroup(id)));
        if (cancelled) return;
        setPublications(publicationItems);
        setPublicationId((current) => current || publicationItems[0]?.publication.id || "");
        setGroups(groupItems);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause : new Error("Run Now inputs could not be loaded"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [entry, session]);

  const unavailableGroups = groups.filter((group) => !group.enabled);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setError(null);
    setBusy(true);
    try {
      if (!entry.enabled || !entry.isActiveVersion) throw new Error("Only the enabled active Automation version can run now");
      if (entry.definition.trigger.kind !== "manual") throw new Error("Run now is only available for manual Automations");
      if (unavailableGroups.length) throw new Error("Enable every Publication Group used by this Automation before running it");
      const publication = publications.find((item) => item.publication.id === publicationId);
      if (!publication) throw new Error("Choose a Publication from the Workspace");
      const result = await session.client.startManualRun({
        automationId: entry.definition.id,
        automationVersion: entry.definition.version,
        publication: publication.publication,
        groups: groups.map((group) => group.group),
      }, `control-room-${crypto.randomUUID()}`);
      navigate(`/runs/${encodeURIComponent(result.runId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Manual Automation could not be started"));
      setBusy(false);
    }
  };

  return (
    <Panel title={`Run ${entry.definition.name}`} meta="Manual trigger" className="automation-detail">
      <form className="setup-step setup-form" onSubmit={run}>
        <ErrorBanner error={error} />
        <p>Run this Automation with a durable Publication Workspace snapshot. Blogmaatic resolves its current Publication Groups before dispatch and records the run normally.</p>
        {loading ? <LoadingBlock /> : null}
        {!loading ? (
          <>
            {publications.length ? (
              <label className="field">
                <span>Publication</span>
                <select value={publicationId} onChange={(event) => setPublicationId(event.target.value)} required>
                  {publications.map((item) => (
                    <option key={item.publication.id} value={item.publication.id}>
                      {item.publication.current.content.title} · {item.publication.status}
                    </option>
                  ))}
                </select>
                <small>The immutable current Workspace snapshot is sent to the durable run.</small>
              </label>
            ) : (
              <div className="automation-create-empty">
                <EmptyState title="No runnable Publications">Create a Publication in the Workspace before using Run now.</EmptyState>
                <Link className="button button--primary" to="/publications">Open Publications</Link>
              </div>
            )}

            {groups.length ? (
              <div className="setup-checks">
                {groups.map((group) => (
                  <div className="setup-check" key={group.group.id}>
                    <div><strong>{group.group.name}</strong><small>{group.group.id} · v{group.version}</small></div>
                    <StatusPill value={group.enabled ? "enabled" : "disabled"} tone={group.enabled ? "good" : "bad"} />
                    {!group.enabled ? <p><Link to={`/publication-groups/${encodeURIComponent(group.group.id)}`}>Enable or repair this Publication Group.</Link></p> : null}
                  </div>
                ))}
              </div>
            ) : <p className="security-note">This Automation has no publish-group steps. The manual run will use an empty Publication Group snapshot set.</p>}
          </>
        ) : null}
        <div className="setup-actions">
          <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy || loading || publications.length === 0 || unavailableGroups.length > 0}>
            {busy ? "Starting…" : "Run now"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function AutomationsPage() {
  const { automationId } = useParams();
  const { session } = useConnection();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [runTarget, setRunTarget] = useState<AutomationRegistryEntry | null>(null);
  const [editTarget, setEditTarget] = useState<AutomationRegistryEntry | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomations({ limit: 30, ...(cursor ? { cursor } : {}) });
  }, [session]);
  const collection = usePagedCollection(`automations:${changeNonce}`, loader);

  const loadGroups = useCallback(async () => {
    if (!session) return;
    setGroupsLoading(true);
    setActionError(null);
    try {
      const items: PublicationGroupRegistryEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await session.client.listPublicationGroups({ limit: 200, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setGroups(items);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Publication Groups could not be loaded"));
    } finally {
      setGroupsLoading(false);
    }
  }, [session]);

  const openCreate = useCallback(async () => {
    setRunTarget(null);
    setEditTarget(null);
    setCreateOpen(true);
    await loadGroups();
  }, [loadGroups]);

  const openEdit = useCallback(async (entry: AutomationRegistryEntry) => {
    if (entry.definition.trigger.kind === "schedule") {
      navigate("/schedules");
      return;
    }
    setCreateOpen(false);
    setRunTarget(null);
    setEditTarget(entry);
    await loadGroups();
  }, [loadGroups, navigate]);

  const saveAutomation = useCallback(async (definition: AutomationDefinition) => {
    if (!session) return;
    setBusy("save");
    setActionError(null);
    try {
      await session.client.registerAutomation(definition);
      setCreateOpen(false);
      setEditTarget(null);
      setChangeNonce((value) => value + 1);
      navigate(`/automations/${encodeURIComponent(definition.id)}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Automation version could not be saved");
      setActionError(error);
      throw error;
    } finally {
      setBusy(null);
    }
  }, [navigate, session]);

  const toggle = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
    if (entry.definition.trigger.kind === "schedule") {
      setActionError(new Error("Schedule-trigger Automations are enabled and disabled through Schedules"));
      return;
    }
    setBusy(entry.definition.id);
    setActionError(null);
    try {
      await session.client.activateAutomation(entry.definition.id, entry.definition.version, { enabled: !entry.enabled });
      setPendingToggle(null);
      if (runTarget?.definition.id === entry.definition.id) setRunTarget(null);
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Automation update failed"));
    } finally {
      setBusy(null);
    }
  };

  const detailOpen = Boolean(automationId || createOpen || runTarget || editTarget);

  return (
    <>
      <PageHeader
        eyebrow="Automation registry"
        title="Automations"
        description="Compose manual and event publishing workflows through the canonical immutable Automation registry. Conditions and ordered publish, approval, and delay steps are executed by the same runtime contract shown here."
        actions={<button className="button button--primary" type="button" onClick={() => void openCreate()} disabled={busy !== null}>New Automation</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />
      <div className={`automation-layout ${detailOpen ? "automation-layout--open" : ""}`}>
        <Panel className="table-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="automation-list">
              {collection.items.map((entry) => {
                const scheduleOwned = entry.definition.trigger.kind === "schedule";
                return (
                  <article className="automation-row" key={entry.definition.id}>
                    <Link className="automation-row__identity" to={`/automations/${encodeURIComponent(entry.definition.id)}`} onClick={() => { setCreateOpen(false); setEditTarget(null); setRunTarget(null); }}>
                      <strong>{entry.definition.name}</strong>
                      <small>{entry.definition.id}</small>
                    </Link>
                    <div><small>Trigger</small><span>{triggerLabel(entry.definition.trigger.kind)}</span></div>
                    <div><small>Version</small><span>v{entry.definition.version}</span></div>
                    <div><small>Steps</small><span>{entry.definition.steps.length}</span></div>
                    <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                    {scheduleOwned ? (
                      <div className="inline-confirm-actions">
                        <Link className="button button--quiet" to="/schedules">Open Schedule</Link>
                      </div>
                    ) : pendingToggle === entry.definition.id ? (
                      <div className="inline-confirm-actions" aria-label={`Confirm ${entry.enabled ? "disable" : "enable"} ${entry.definition.name}`}>
                        <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(null)}>Cancel</button>
                        <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" disabled={busy === entry.definition.id} onClick={() => void toggle(entry)}>{busy === entry.definition.id ? "Saving…" : `Confirm ${entry.enabled ? "disable" : "enable"}`}</button>
                      </div>
                    ) : (
                      <div className="inline-confirm-actions">
                        {entry.enabled && entry.isActiveVersion && entry.definition.trigger.kind === "manual" ? (
                          <button className="button button--primary" type="button" disabled={busy !== null} onClick={() => { setCreateOpen(false); setEditTarget(null); setRunTarget(entry); }}>Run now</button>
                        ) : null}
                        <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void openEdit(entry)}>Edit</button>
                        <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(entry.definition.id)}>{entry.enabled ? "Disable" : "Enable"}</button>
                      </div>
                    )}
                  </article>
                );
              })}
              {collection.items.length === 0 ? (
                <div className="automation-create-empty">
                  <EmptyState title="No automations yet">Create the first publishing workflow here. Blogmaatic stores it in the same immutable registry used by event routing, manual runs, approvals, and durable execution.</EmptyState>
                  <button className="button button--primary" type="button" onClick={() => void openCreate()}>Create Automation</button>
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>
        {createOpen ? (
          <AutomationStudioPanel
            key="new-automation"
            groups={groups}
            groupsLoading={groupsLoading}
            busy={busy === "save"}
            onSave={saveAutomation}
            onCancel={() => setCreateOpen(false)}
          />
        ) : editTarget ? (
          <AutomationStudioPanel
            key={`${editTarget.definition.id}:${editTarget.definition.version}`}
            groups={groups}
            groupsLoading={groupsLoading}
            initialEntry={editTarget}
            busy={busy === "save"}
            onSave={saveAutomation}
            onCancel={() => setEditTarget(null)}
          />
        ) : runTarget ? <RunNowPanel entry={runTarget} onCancel={() => setRunTarget(null)} />
          : automationId ? <VersionsPanel key={automationId} automationId={automationId} changeNonce={changeNonce} onChanged={() => setChangeNonce((value) => value + 1)} /> : null}
      </div>
    </>
  );
}
