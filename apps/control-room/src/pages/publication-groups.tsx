import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  OperatorConnectionType,
  OperatorConnectionView,
  PublicationGroupRegistryEntry,
} from "@blogmaatic/operator-client";

import {
  CollectionFooter,
  EmptyState,
  ErrorBanner,
  LoadingBlock,
  PageHeader,
  Panel,
  StatusPill,
} from "../components";
import { useConnection } from "../connection";
import { formatInstant } from "../format";
import { usePagedCollection } from "../hooks";
import {
  connectionTypeMap,
  policySetLabel,
  routeForConnection,
  type PublicationRouteInput,
} from "../publishing";

interface GroupMetadata {
  readonly connections: readonly OperatorConnectionView[];
  readonly connectionTypes: readonly OperatorConnectionType[];
  readonly policySetIds: readonly string[];
}

interface RouteChoice {
  readonly included: boolean;
  readonly enabled: boolean;
}

function initialRouteChoices(
  metadata: GroupMetadata,
  entry?: PublicationGroupRegistryEntry,
): ReadonlyMap<string, RouteChoice> {
  const existing = new Map(
    (entry?.group.routes ?? []).map((route) => [route.destination.connectionId, route]),
  );
  return new Map(metadata.connections.map((connection) => {
    const route = existing.get(connection.id);
    return [connection.id, {
      included: Boolean(route) || (!entry && connection.status === "active"),
      enabled: route?.enabled ?? connection.status === "active",
    }];
  }));
}

function routesFor(
  metadata: GroupMetadata,
  choices: ReadonlyMap<string, RouteChoice>,
  entry?: PublicationGroupRegistryEntry,
): readonly PublicationRouteInput[] {
  const types = connectionTypeMap(metadata.connectionTypes);
  const existing = new Map(
    (entry?.group.routes ?? []).map((route) => [route.destination.connectionId, route]),
  );
  return metadata.connections.flatMap((connection) => {
    const choice = choices.get(connection.id);
    if (!choice?.included) return [];
    const type = types.get(connection.extensionId);
    if (!type) throw new Error(`Publisher contract is unavailable for ${connection.extensionId}`);
    const route = routeForConnection(connection, type, existing.get(connection.id));
    return [{ ...route, enabled: choice.enabled }];
  });
}

function GroupEditor({
  metadata,
  entry,
  onSaved,
  onCancel,
}: {
  readonly metadata: GroupMetadata;
  readonly entry?: PublicationGroupRegistryEntry;
  readonly onSaved: (entry: PublicationGroupRegistryEntry) => Promise<void> | void;
  readonly onCancel: () => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [name, setName] = useState(entry?.group.name ?? "Primary publishing");
  const [policySetId, setPolicySetId] = useState(entry?.group.policySetId ?? metadata.policySetIds[0] ?? "");
  const [choices, setChoices] = useState<ReadonlyMap<string, RouteChoice>>(
    () => initialRouteChoices(metadata, entry),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const types = useMemo(() => connectionTypeMap(metadata.connectionTypes), [metadata.connectionTypes]);
  const existingRouteIds = useMemo(
    () => new Set((entry?.group.routes ?? []).map((route) => route.destination.connectionId)),
    [entry],
  );

  const updateChoice = useCallback((connectionId: string, patch: Partial<RouteChoice>) => {
    setChoices((current) => {
      const next = new Map(current);
      const previous = next.get(connectionId) ?? { included: false, enabled: false };
      next.set(connectionId, { ...previous, ...patch });
      return next;
    });
  }, []);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!name.trim()) throw new Error("Publishing group name is required");
      if (!policySetId) throw new Error("A publishing policy is required");
      const routes = routesFor(metadata, choices, entry);
      if (routes.length === 0) throw new Error("Choose at least one publishing destination");
      if (entry?.enabled && routes.every((route) => !route.enabled)) {
        throw new Error("An enabled publishing group needs at least one enabled destination");
      }
      const saved = entry
        ? await client.updatePublicationGroup(entry.group.id, {
          expectedVersion: entry.version,
          name: name.trim(),
          policySetId,
          routes,
          enabled: entry.enabled,
        })
        : await client.createPublicationGroup({
          name: name.trim(),
          policySetId,
          routes,
          enabled: true,
        });
      await onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Publishing group could not be saved"));
    } finally {
      setBusy(false);
    }
  }, [choices, client, entry, metadata, name, onSaved, policySetId]);

  return (
    <form className="group-editor" onSubmit={save}>
      <ErrorBanner error={error} />
      <div className="group-editor__grid">
        <label className="field">
          <span>Group name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" />
          <small>Use a name that describes the audience or publishing destination set.</small>
        </label>
        <label className="field">
          <span>Publishing policy</span>
          <select value={policySetId} onChange={(event) => setPolicySetId(event.target.value)} required>
            {metadata.policySetIds.map((id) => <option key={id} value={id}>{policySetLabel(id)}</option>)}
          </select>
          <small>{policySetId === "default" ? "Allows publishing unless a configured rule says otherwise." : `Policy authority: ${policySetId}`}</small>
        </label>
      </div>
      <fieldset className="group-destination-picker">
        <legend>Publishing destinations</legend>
        <p>Choose where this group publishes. A destination can stay in the group but be temporarily paused.</p>
        <div className="group-destination-picker__list">
          {metadata.connections.map((connection) => {
            const type = types.get(connection.extensionId);
            const choice = choices.get(connection.id) ?? { included: false, enabled: false };
            const unavailable = connection.status !== "active" && !existingRouteIds.has(connection.id);
            return (
              <div className="group-destination-choice" key={connection.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={choice.included}
                    disabled={unavailable}
                    onChange={(event) => updateChoice(connection.id, {
                      included: event.target.checked,
                      enabled: event.target.checked ? choice.enabled || connection.status === "active" : false,
                    })}
                  />
                  <span>
                    <strong>{connection.displayName}</strong>
                    <small>{type?.manifest.displayName ?? connection.extensionId}</small>
                  </span>
                </label>
                <StatusPill value={connection.status} tone={connection.status === "active" ? "good" : "neutral"} />
                {choice.included ? (
                  <label className="group-destination-choice__route-toggle">
                    <input
                      type="checkbox"
                      checked={choice.enabled}
                      disabled={connection.status !== "active"}
                      onChange={(event) => updateChoice(connection.id, { enabled: event.target.checked })}
                    />
                    Route enabled
                  </label>
                ) : null}
              </div>
            );
          })}
          {metadata.connections.length === 0 ? (
            <EmptyState title="No destinations connected">Add a publishing destination before creating a publishing group.</EmptyState>
          ) : null}
        </div>
      </fieldset>
      <div className="group-editor__actions">
        <button className="button button--quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="button button--primary" type="submit" disabled={busy || metadata.connections.length === 0 || metadata.policySetIds.length === 0}>
          {busy ? "Saving…" : entry ? "Save new version" : "Create publishing group"}
        </button>
      </div>
    </form>
  );
}

function VersionHistory({
  groupId,
  current,
  changeNonce,
  onRestored,
}: {
  readonly groupId: string;
  readonly current: PublicationGroupRegistryEntry;
  readonly changeNonce: number;
  readonly onRestored: (entry: PublicationGroupRegistryEntry) => Promise<void> | void;
}) {
  const { session } = useConnection();
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loader = useCallback((cursor?: string) => session!.client.listPublicationGroupVersions(groupId, {
    limit: 30,
    ...(cursor ? { cursor } : {}),
  }), [groupId, session]);
  const collection = usePagedCollection(`group-versions:${groupId}:${changeNonce}`, loader);

  const restore = useCallback(async (historical: PublicationGroupRegistryEntry) => {
    setBusy(historical.version);
    setError(null);
    try {
      const restored = await session!.client.updatePublicationGroup(groupId, {
        expectedVersion: current.version,
        name: historical.group.name,
        policySetId: historical.group.policySetId,
        routes: historical.group.routes,
        enabled: current.enabled,
      });
      setPendingVersion(null);
      await onRestored(restored);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Publishing group version could not be restored"));
    } finally {
      setBusy(null);
    }
  }, [current.enabled, current.version, groupId, onRestored, session]);

  return (
    <Panel title="Version history" className="group-version-panel">
      <ErrorBanner error={error ?? collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="group-version-list">
          {collection.items.map((entry) => (
            <div className="group-version-row" key={entry.version}>
              <div><strong>v{entry.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.group.routes.length} destination{entry.group.routes.length === 1 ? "" : "s"}</span>
              <StatusPill value={entry.isActiveVersion ? "current" : "historical"} tone={entry.isActiveVersion ? "good" : "neutral"} />
              {!entry.isActiveVersion ? (
                pendingVersion === entry.version ? (
                  <div className="inline-confirm-actions">
                    <button className="button button--quiet" type="button" disabled={busy === entry.version} onClick={() => setPendingVersion(null)}>Cancel</button>
                    <button className="button button--primary" type="button" disabled={busy === entry.version} onClick={() => void restore(entry)}>{busy === entry.version ? "Restoring…" : "Restore as new version"}</button>
                  </div>
                ) : <button className="button button--quiet" type="button" onClick={() => setPendingVersion(entry.version)}>Restore</button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

function GroupDetail({
  groupId,
  metadata,
  changeNonce,
  onChanged,
}: {
  readonly groupId: string;
  readonly metadata: GroupMetadata;
  readonly changeNonce: number;
  readonly onChanged: () => void;
}) {
  const { session } = useConnection();
  const [entry, setEntry] = useState<PublicationGroupRegistryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [editing, setEditing] = useState(false);
  const [pendingToggle, setPendingToggle] = useState(false);
  const [busy, setBusy] = useState(false);
  const types = useMemo(() => connectionTypeMap(metadata.connectionTypes), [metadata.connectionTypes]);
  const connections = useMemo(() => new Map(metadata.connections.map((connection) => [connection.id, connection])), [metadata.connections]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntry(await session!.client.getPublicationGroup(groupId));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Publishing group could not be loaded"));
      setEntry(null);
    } finally {
      setLoading(false);
    }
  }, [groupId, session]);

  useEffect(() => { void load(); }, [load, changeNonce]);

  const toggle = useCallback(async () => {
    if (!entry) return;
    setBusy(true);
    setError(null);
    try {
      const changed = await session!.client.setPublicationGroupEnabled(groupId, {
        expectedVersion: entry.version,
        enabled: !entry.enabled,
      });
      setEntry(changed);
      setPendingToggle(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Publishing group state could not be changed"));
    } finally {
      setBusy(false);
    }
  }, [entry, groupId, onChanged, session]);

  if (loading && !entry) return <Panel title="Publishing group"><LoadingBlock /></Panel>;
  if (!entry) return <Panel title="Publishing group"><ErrorBanner error={error} /></Panel>;

  if (editing) {
    return (
      <Panel title={`Edit ${entry.group.name}`} meta={`Current v${entry.version}`} className="group-detail-panel">
        <GroupEditor
          metadata={metadata}
          entry={entry}
          onCancel={() => setEditing(false)}
          onSaved={async (saved) => {
            setEntry(saved);
            setEditing(false);
            onChanged();
          }}
        />
      </Panel>
    );
  }

  return (
    <div className="group-detail-stack">
      <Panel title={entry.group.name} meta={`v${entry.version}`} className="group-detail-panel">
        <ErrorBanner error={error} />
        <div className="group-detail-summary">
          <div><span>Status</span><StatusPill value={entry.enabled ? "enabled" : "disabled"} /></div>
          <div><span>Policy</span><strong>{policySetLabel(entry.group.policySetId)}</strong></div>
          <div><span>Destinations</span><strong>{entry.group.routes.length}</strong></div>
          <div><span>Updated</span><strong>{formatInstant(entry.updatedAt)}</strong></div>
        </div>
        <div className="group-route-list">
          {entry.group.routes.map((route) => {
            const connection = connections.get(route.destination.connectionId);
            const type = connection ? types.get(connection.extensionId) : undefined;
            return (
              <div className="group-route-row" key={route.id}>
                <div>
                  <strong>{connection?.displayName ?? route.destination.connectionId}</strong>
                  <small>{type?.manifest.displayName ?? route.destination.extensionId} · {route.destination.channel}</small>
                </div>
                <StatusPill value={route.enabled ? "enabled" : "paused"} tone={route.enabled ? "good" : "neutral"} />
              </div>
            );
          })}
        </div>
        <div className="group-detail-actions">
          <button className="button button--quiet" type="button" onClick={() => setEditing(true)}>Edit destinations</button>
          {pendingToggle ? (
            <div className="inline-confirm-actions">
              <button className="button button--quiet" type="button" disabled={busy} onClick={() => setPendingToggle(false)}>Cancel</button>
              <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" disabled={busy} onClick={() => void toggle()}>{busy ? "Saving…" : `Confirm ${entry.enabled ? "disable" : "enable"}`}</button>
            </div>
          ) : <button className="button button--quiet" type="button" onClick={() => setPendingToggle(true)}>{entry.enabled ? "Disable group" : "Enable group"}</button>}
        </div>
      </Panel>
      <VersionHistory groupId={groupId} current={entry} changeNonce={changeNonce} onRestored={async (restored) => { setEntry(restored); onChanged(); }} />
    </div>
  );
}

export function PublicationGroupsPage() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { session } = useConnection();
  const [metadata, setMetadata] = useState<GroupMetadata | null>(null);
  const [metadataError, setMetadataError] = useState<Error | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [changeNonce, setChangeNonce] = useState(0);
  const loader = useCallback((cursor?: string) => session!.client.listPublicationGroups({
    limit: 30,
    ...(cursor ? { cursor } : {}),
  }), [session]);
  const collection = usePagedCollection(`publication-groups:${changeNonce}`, loader);

  const loadMetadata = useCallback(async () => {
    setMetadataLoading(true);
    setMetadataError(null);
    try {
      const [connections, connectionTypes, options] = await Promise.all([
        session!.client.listConnections(),
        session!.client.listConnectionTypes(),
        session!.client.getPublicationGroupOptions(),
      ]);
      setMetadata({
        connections: connections.items,
        connectionTypes: connectionTypes.items,
        policySetIds: options.policySetIds,
      });
    } catch (cause) {
      setMetadataError(cause instanceof Error ? cause : new Error("Publishing group options could not be loaded"));
    } finally {
      setMetadataLoading(false);
    }
  }, [session]);

  useEffect(() => { void loadMetadata(); }, [loadMetadata, changeNonce]);

  const changed = useCallback(() => setChangeNonce((value) => value + 1), []);

  return (
    <>
      <PageHeader
        eyebrow="Publishing destinations"
        title="Publishing groups"
        description="Bundle destinations that should receive the same publication. Groups stay versioned so every run keeps the exact routing snapshot it used."
        actions={<button className="button button--primary" type="button" onClick={() => { setCreating(true); navigate("/groups"); }}>New group</button>}
      />
      <ErrorBanner error={metadataError ?? collection.error} />
      {metadataLoading && !metadata ? <LoadingBlock /> : null}
      {metadata ? (
        <div className={`group-layout ${(groupId || creating) ? "group-layout--open" : ""}`}>
          <Panel className="group-list-panel">
            {collection.loading ? <LoadingBlock /> : (
              <div className="group-list">
                {collection.items.map((entry) => (
                  <Link className={`group-row ${groupId === entry.group.id ? "is-selected" : ""}`} key={entry.group.id} to={`/groups/${encodeURIComponent(entry.group.id)}`} onClick={() => setCreating(false)}>
                    <span><strong>{entry.group.name}</strong><small>{entry.group.routes.length} destination{entry.group.routes.length === 1 ? "" : "s"} · {policySetLabel(entry.group.policySetId)}</small></span>
                    <span className="group-row__meta"><StatusPill value={entry.enabled ? "enabled" : "disabled"} /><small>v{entry.version} · {formatInstant(entry.updatedAt)}</small></span>
                  </Link>
                ))}
                {collection.items.length === 0 ? (
                  <div className="group-empty-action">
                    <EmptyState title="Create your first publishing group">Choose which connected destinations should publish together. You can change the group later without rewriting old run history.</EmptyState>
                    <button className="button button--primary" type="button" onClick={() => setCreating(true)}>Create publishing group</button>
                  </div>
                ) : null}
              </div>
            )}
            <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
          </Panel>
          {creating ? (
            <Panel title="New publishing group" className="group-detail-panel">
              <GroupEditor
                metadata={metadata}
                onCancel={() => setCreating(false)}
                onSaved={async (saved) => {
                  setCreating(false);
                  changed();
                  navigate(`/groups/${encodeURIComponent(saved.group.id)}`);
                }}
              />
            </Panel>
          ) : groupId ? <GroupDetail groupId={groupId} metadata={metadata} changeNonce={changeNonce} onChanged={changed} /> : null}
        </div>
      ) : null}
    </>
  );
}
