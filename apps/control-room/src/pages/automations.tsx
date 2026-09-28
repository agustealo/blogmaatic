import { useCallback, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";

import type {
  AutomationDefinition,
  AutomationRegistryEntry,
  PublicationGroupRegistryEntry,
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
        <p>Create a real publishing automation without leaving the Control Room. The starter automation listens for a canonical <code>publication.approved</code> event and publishes through the selected group.</p>
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
          <small>Manual runs remain an advanced API capability until Blogmaatic has a first-class consumer publication-input flow. The UI does not create a button that cannot actually run.</small>
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
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listAutomations({ limit: 30, ...(cursor ? { cursor } : {}) });
  }, [session]);
  const collection = usePagedCollection(`automations:${changeNonce}`, loader);

  const openCreate = useCallback(async () => {
    if (!session) return;
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
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Automation update failed"));
    } finally {
      setBusy(null);
    }
  };

  const detailOpen = Boolean(automationId || createOpen);

  return (
    <>
      <PageHeader
        eyebrow="Automation registry"
        title="Automations"
        description="Create and manage publishing automations through the canonical immutable registry. No Operator API detour is required for normal setup."
        actions={<button className="button button--primary" type="button" onClick={() => void openCreate()} disabled={busy !== null}>New Automation</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />
      <div className={`automation-layout ${detailOpen ? "automation-layout--open" : ""}`}>
        <Panel className="table-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="automation-list">
              {collection.items.map((entry) => (
                <article className="automation-row" key={entry.definition.id}>
                  <Link className="automation-row__identity" to={`/automations/${encodeURIComponent(entry.definition.id)}`} onClick={() => setCreateOpen(false)}>
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
                  ) : <button className="button button--quiet" type="button" disabled={busy === entry.definition.id} onClick={() => setPendingToggle(entry.definition.id)}>{entry.enabled ? "Disable" : "Enable"}</button>}
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
        ) : automationId ? <VersionsPanel key={automationId} automationId={automationId} changeNonce={changeNonce} onChanged={() => setChangeNonce((value) => value + 1)} /> : null}
      </div>
    </>
  );
}
