import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  AutomationDefinition,
  AutomationRegistryEntry,
  PublicationGroupRegistryEntry,
  PublicationWorkspaceEntry,
} from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, triggerLabel } from "../format";
import { usePagedCollection } from "../hooks";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function automationId(name: string): string {
  return `automation_${slug(name) || "publication"}_${crypto.randomUUID().slice(0, 8)}`;
}

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

  const activate = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
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
    <Panel title="Version history" meta={<Link to="/automations">Close</Link>} className="automation-detail">
      <ErrorBanner error={actionError ?? collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="version-list">
          {collection.items.map((entry) => (
            <div className="version-row" key={entry.definition.version}>
              <div><strong>v{entry.definition.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.definition.steps.length} steps · {triggerLabel(entry.definition.trigger.kind)}</span>
              <StatusPill value={entry.isActiveVersion ? (entry.enabled ? "enabled" : "disabled") : "inactive"} />
              {!entry.isActiveVersion ? (
                pendingVersion === entry.definition.version ? (
                  <div className="inline-confirm-actions" aria-label={`Confirm activation of version ${entry.definition.version}`}>
                    <button className="button button--quiet" type="button" disabled={busy === entry.definition.version} onClick={() => setPendingVersion(null)}>Cancel</button>
                    <button className="button button--primary" type="button" disabled={busy === entry.definition.version} onClick={() => void activate(entry)}>{busy === entry.definition.version ? "Activating…" : "Confirm"}</button>
                  </div>
                ) : <button className="button button--quiet" type="button" onClick={() => setPendingVersion(entry.definition.version)}>Activate</button>
              ) : null}
            </div>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No versions found">No immutable versions are available for this automation.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

function CreateAutomationPanel({
  groups,
  groupsLoading,
  busy,
  onCreate,
  onCancel,
}: {
  readonly groups: readonly PublicationGroupRegistryEntry[];
  readonly groupsLoading: boolean;
  readonly busy: boolean;
  readonly onCreate: (definition: AutomationDefinition) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("Publish approved content");
  const [groupId, setGroupId] = useState(groups[0]?.group.id ?? "");
  const [error, setError] = useState<Error | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const selectedGroupId = groupId || groups[0]?.group.id;
      if (!name.trim()) throw new Error("Automation name is required");
      if (!selectedGroupId) throw new Error("Create and enable a Publication Group first");
      await onCreate({
        id: automationId(name),
        version: 1,
        name: name.trim(),
        enabled: true,
        trigger: { kind: "event", eventType: "publication.approved" },
        steps: [{ id: "publish", kind: "publish_group", groupId: selectedGroupId }],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Automation could not be created"));
    }
  };

  return (
    <Panel title="Create Automation" meta="Consumer-safe starter" className="automation-detail">
      <form className="setup-step setup-form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <p>Create a real publishing automation without leaving the Control Room. The starter automation listens for the canonical <code>publication.approved</code> event and publishes through the selected group.</p>
        <label className="field">
          <span>Automation name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
        </label>
        <label className="field">
          <span>Publication Group</span>
          <select value={groupId || groups[0]?.group.id || ""} onChange={(event) => setGroupId(event.target.value)} disabled={groupsLoading || groups.length === 0} required>
            {groups.map((entry) => <option key={entry.group.id} value={entry.group.id}>{entry.group.name}</option>)}
          </select>
          <small>Only enabled Publication Groups are offered here.</small>
        </label>
        <label className="field">
          <span>Trigger</span>
          <input value="When a publication is approved" readOnly aria-readonly="true" />
          <small>Starter Automations use the normal Publication Workspace flow. Existing manual Automations can be launched with Run now from this screen.</small>
        </label>
        {groupsLoading ? <LoadingBlock /> : null}
        {!groupsLoading && groups.length === 0 ? (
          <div className="automation-create-empty">
            <EmptyState title="No enabled Publication Group">Create or enable a Publication Group before creating an Automation.</EmptyState>
            <Link className="button button--primary" to="/publication-groups">Manage Publication Groups</Link>
          </div>
        ) : null}
        <div className="setup-actions">
          <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={busy || groupsLoading || groups.length === 0}>{busy ? "Creating…" : "Create Automation"}</button>
        </div>
      </form>
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
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [runTarget, setRunTarget] = useState<AutomationRegistryEntry | null>(null);
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomations({ limit: 30, ...(cursor ? { cursor } : {}) });
  }, [session]);
  const collection = usePagedCollection(`automations:${changeNonce}`, loader);

  const openCreate = useCallback(async () => {
    if (!session) return;
    setRunTarget(null);
    setCreateOpen(true);
    setGroupsLoading(true);
    setActionError(null);
    try {
      const page = await session.client.listPublicationGroups({ enabled: true, limit: 100 });
      setGroups(page.items);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Publication Groups could not be loaded"));
    } finally {
      setGroupsLoading(false);
    }
  }, [session]);

  const createAutomation = useCallback(async (definition: AutomationDefinition) => {
    if (!session) return;
    setBusy("create");
    setActionError(null);
    try {
      await session.client.registerAutomation(definition);
      setCreateOpen(false);
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Automation could not be created");
      setActionError(error);
      throw error;
    } finally {
      setBusy(null);
    }
  }, [session]);

  const toggle = async (entry: AutomationRegistryEntry) => {
    if (!session) return;
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

  const detailOpen = Boolean(automationId || createOpen || runTarget);

  return (
    <>
      <PageHeader
        eyebrow="Automation registry"
        title="Automations"
        description="Create and manage publishing automations through the canonical immutable registry. Manual Automations can run against real Publication Workspace snapshots without an API detour."
        actions={<button className="button button--primary" type="button" onClick={() => void openCreate()} disabled={busy !== null}>New Automation</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />
      <div className={`automation-layout ${detailOpen ? "automation-layout--open" : ""}`}>
        <Panel className="table-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="automation-list">
              {collection.items.map((entry) => (
                <article className="automation-row" key={entry.definition.id}>
                  <Link className="automation-row__identity" to={`/automations/${encodeURIComponent(entry.definition.id)}`} onClick={() => { setCreateOpen(false); setRunTarget(null); }}>
                    <strong>{entry.definition.name}</strong>
                    <small>{entry.definition.id}</small>
                  </Link>
                  <div><small>Trigger</small><span>{triggerLabel(entry.definition.trigger.kind)}</span></div>
                  <div><small>Version</small><span>v{entry.definition.version}</span></div>
                  <div><small>Steps</small><span>{entry.definition.steps.length}</span></div>
                  <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                  {pendingToggle === entry.definition.id ? (
                    <div className="inline-confirm-actions" aria-label={`Confirm ${entry.enabled ? "disable" : "enable"} ${entry.definition.name}`}>
                      <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(null)}>Cancel</button>
                      <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" disabled={busy === entry.definition.id} onClick={() => void toggle(entry)}>{busy === entry.definition.id ? "Saving…" : `Confirm ${entry.enabled ? "disable" : "enable"}`}</button>
                    </div>
                  ) : (
                    <div className="inline-confirm-actions">
                      {entry.enabled && entry.isActiveVersion && entry.definition.trigger.kind === "manual" ? (
                        <button className="button button--primary" type="button" disabled={busy !== null} onClick={() => { setCreateOpen(false); setRunTarget(entry); }}>Run now</button>
                      ) : null}
                      <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(entry.definition.id)}>{entry.enabled ? "Disable" : "Enable"}</button>
                    </div>
                  )}
                </article>
              ))}
              {collection.items.length === 0 ? (
                <div className="automation-create-empty">
                  <EmptyState title="No automations yet">Create the first publishing automation here. Blogmaatic will wire it to an enabled Publication Group through the same registry used by the runtime.</EmptyState>
                  <button className="button button--primary" type="button" onClick={() => void openCreate()}>Create Automation</button>
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>
        {createOpen ? (
          <CreateAutomationPanel
            groups={groups}
            groupsLoading={groupsLoading}
            busy={busy === "create"}
            onCreate={createAutomation}
            onCancel={() => setCreateOpen(false)}
          />
        ) : runTarget ? <RunNowPanel entry={runTarget} onCancel={() => setRunTarget(null)} />
          : automationId ? <VersionsPanel key={automationId} automationId={automationId} changeNonce={changeNonce} onChanged={() => setChangeNonce((value) => value + 1)} /> : null}
      </div>
    </>
  );
}
