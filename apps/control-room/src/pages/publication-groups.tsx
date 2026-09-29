import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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

type GroupRoute = PublicationGroupRegistryEntry["group"]["routes"][number];

interface EditorState {
  readonly mode: "create" | "edit";
  readonly groupId?: string;
  readonly expectedVersion?: number;
  readonly name: string;
  readonly policySetId: string;
  readonly selectedConnectionIds: ReadonlySet<string>;
  readonly enabledConnectionIds: ReadonlySet<string>;
  readonly existingRoutes: readonly GroupRoute[];
  readonly enabled: boolean;
}

function routeId(connection: OperatorConnectionView): string {
  return `route_${connection.id}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160);
}

function defaultRoute(connection: OperatorConnectionView, type: OperatorConnectionType): GroupRoute {
  const route = type.connectionContract.defaultRoute;
  return {
    id: routeId(connection),
    enabled: true,
    desiredState: "present",
    destination: {
      extensionId: connection.extensionId,
      connectionId: connection.id,
      channel: route.channel,
    },
    requiredCapabilities: route.requiredCapabilities,
    ...(route.variant ? { variant: route.variant } : {}),
  };
}

function createEditor(policySetId: string): EditorState {
  return {
    mode: "create",
    name: "",
    policySetId,
    selectedConnectionIds: new Set(),
    enabledConnectionIds: new Set(),
    existingRoutes: [],
    enabled: true,
  };
}

function editEditor(entry: PublicationGroupRegistryEntry): EditorState {
  return {
    mode: "edit",
    groupId: entry.group.id,
    expectedVersion: entry.version,
    name: entry.group.name,
    policySetId: entry.group.policySetId,
    selectedConnectionIds: new Set(entry.group.routes.map((route) => route.destination.connectionId)),
    enabledConnectionIds: new Set(
      entry.group.routes.filter((route) => route.enabled).map((route) => route.destination.connectionId),
    ),
    existingRoutes: entry.group.routes,
    enabled: entry.enabled,
  };
}

function VersionsPanel({ groupId, nonce }: { readonly groupId: string; readonly nonce: number }) {
  const { session } = useConnection();
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listPublicationGroupVersions(groupId, {
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });
  }, [groupId, session]);
  const collection = usePagedCollection(`publication-group-versions:${groupId}:${nonce}`, loader);

  return (
    <Panel title="Version history" meta={<Link to="/publication-groups">Close</Link>} className="publication-group-detail">
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="version-list">
          {collection.items.map((entry) => (
            <div className="version-row" key={entry.version}>
              <div><strong>v{entry.version}</strong><small>{formatInstant(entry.registeredAt)}</small></div>
              <span>{entry.group.routes.length} destination{entry.group.routes.length === 1 ? "" : "s"}</span>
              <StatusPill value={entry.isActiveVersion ? (entry.enabled ? "enabled" : "disabled") : "inactive"} />
              <span className="publication-group-version-policy">{entry.group.policySetId}</span>
            </div>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No versions found">No immutable versions are available for this Publication Group.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

export function PublicationGroupsPage() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { session } = useConnection();
  const client = session!.client;
  const [enabledFilter, setEnabledFilter] = useState<"" | "true" | "false">("");
  const [connections, setConnections] = useState<readonly OperatorConnectionView[]>([]);
  const [types, setTypes] = useState<readonly OperatorConnectionType[]>([]);
  const [policySetIds, setPolicySetIds] = useState<readonly string[]>([]);
  const [supportLoading, setSupportLoading] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);

  const loader = useCallback((cursor?: string) => client.listPublicationGroups({
    limit: 30,
    ...(enabledFilter ? { enabled: enabledFilter === "true" } : {}),
    ...(cursor ? { cursor } : {}),
  }), [client, enabledFilter]);
  const collection = usePagedCollection(`publication-groups:${enabledFilter}:${changeNonce}`, loader);

  const loadSupport = useCallback(async () => {
    setSupportLoading(true);
    setActionError(null);
    try {
      const [connectionResponse, typeResponse, options] = await Promise.all([
        client.listConnections(),
        client.listConnectionTypes(),
        client.getPublicationGroupOptions(),
      ]);
      setConnections(connectionResponse.items);
      setTypes(typeResponse.items);
      setPolicySetIds(options.policySetIds);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Publication Group support data could not be loaded"));
    } finally {
      setSupportLoading(false);
    }
  }, [client]);

  useEffect(() => { void loadSupport(); }, [loadSupport]);

  const typeById = useMemo(() => new Map(types.map((type) => [type.manifest.id, type])), [types]);
  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const selectedEntry = groupId ? collection.items.find((entry) => entry.group.id === groupId) : undefined;

  useEffect(() => {
    if (!groupId) return;
    if (selectedEntry) return;
    void client.getPublicationGroup(groupId)
      .then((entry) => {
        setEditor(editEditor(entry));
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause : new Error("Publication Group could not be loaded"));
      });
  }, [client, groupId, selectedEntry]);

  const startCreate = useCallback(() => {
    if (policySetIds.length === 0) {
      setActionError(new Error("No publication policy set is configured"));
      return;
    }
    setPendingToggle(null);
    setActionError(null);
    setEditor(createEditor(policySetIds[0] ?? ""));
  }, [policySetIds]);

  const startEdit = useCallback((entry: PublicationGroupRegistryEntry) => {
    setPendingToggle(null);
    setActionError(null);
    setEditor(editEditor(entry));
    navigate(`/publication-groups/${encodeURIComponent(entry.group.id)}`);
  }, [navigate]);

  const toggleConnection = useCallback((connectionId: string, checked: boolean) => {
    setEditor((current) => {
      if (!current) return current;
      const selected = new Set(current.selectedConnectionIds);
      const enabledRoutes = new Set(current.enabledConnectionIds);
      if (checked) {
        selected.add(connectionId);
        enabledRoutes.add(connectionId);
      } else {
        selected.delete(connectionId);
        enabledRoutes.delete(connectionId);
      }
      return { ...current, selectedConnectionIds: selected, enabledConnectionIds: enabledRoutes };
    });
  }, []);

  const toggleRoute = useCallback((connectionId: string, checked: boolean) => {
    setEditor((current) => {
      if (!current || !current.selectedConnectionIds.has(connectionId)) return current;
      const enabledRoutes = new Set(current.enabledConnectionIds);
      if (checked) enabledRoutes.add(connectionId);
      else enabledRoutes.delete(connectionId);
      return { ...current, enabledConnectionIds: enabledRoutes };
    });
  }, []);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setBusy("save");
    setActionError(null);
    try {
      if (!editor.name.trim()) throw new Error("Publication Group name is required");
      if (!editor.policySetId) throw new Error("Choose a publication policy set");
      const chosen = connections.filter((connection) => editor.selectedConnectionIds.has(connection.id));
      if (chosen.length === 0) throw new Error("Select at least one publishing destination");

      const existingByConnection = new Map(editor.existingRoutes.map((route) => [route.destination.connectionId, route]));
      const routes = chosen.map((connection) => {
        const enabled = editor.enabledConnectionIds.has(connection.id);
        const existing = existingByConnection.get(connection.id);
        if (existing) return { ...existing, enabled };
        const type = typeById.get(connection.extensionId);
        if (!type) throw new Error(`Publisher contract is unavailable for ${connection.extensionId}`);
        return { ...defaultRoute(connection, type), enabled };
      });

      if (editor.enabled && routes.every((route) => !route.enabled)) {
        throw new Error("An enabled Publication Group needs at least one enabled destination");
      }
      const unavailableEnabledRoute = chosen.find(
        (connection) => editor.enabledConnectionIds.has(connection.id) && connection.status !== "active",
      );
      if (editor.enabled && unavailableEnabledRoute) {
        throw new Error(`Enable ${unavailableEnabledRoute.displayName} before publishing through that destination`);
      }

      let saved: PublicationGroupRegistryEntry;
      if (editor.mode === "create") {
        saved = await client.createPublicationGroup({
          name: editor.name.trim(),
          policySetId: editor.policySetId,
          routes,
          enabled: editor.enabled,
        });
      } else {
        if (!editor.groupId || editor.expectedVersion === undefined) throw new Error("Publication Group edit state is incomplete");
        saved = await client.updatePublicationGroup(editor.groupId, {
          name: editor.name.trim(),
          policySetId: editor.policySetId,
          routes,
          enabled: editor.enabled,
          expectedVersion: editor.expectedVersion,
        });
      }
      setEditor(editEditor(saved));
      setChangeNonce((value) => value + 1);
      navigate(`/publication-groups/${encodeURIComponent(saved.group.id)}`, { replace: true });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Publication Group could not be saved"));
    } finally {
      setBusy(null);
    }
  }, [client, connections, editor, navigate, typeById]);

  const toggleEnabled = useCallback(async (entry: PublicationGroupRegistryEntry) => {
    const nextEnabled = !entry.enabled;
    setBusy(`toggle:${entry.group.id}`);
    setActionError(null);
    try {
      const updated = await client.setPublicationGroupEnabled(entry.group.id, {
        expectedVersion: entry.version,
        enabled: nextEnabled,
      });
      setPendingToggle(null);
      if (editor?.groupId === updated.group.id) setEditor(editEditor(updated));
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause : new Error("Publication Group state could not be changed"));
    } finally {
      setBusy(null);
    }
  }, [client, editor?.groupId]);

  const missingRoutes = editor?.existingRoutes.filter((route) => !connectionById.has(route.destination.connectionId)) ?? [];
  const activeConnections = connections.filter((connection) => connection.status === "active" || editor?.selectedConnectionIds.has(connection.id));

  return (
    <>
      <PageHeader
        eyebrow="Publishing topology"
        title="Publication Groups"
        description="Manage the durable sets of destinations Blogmaatic publishes to together. These are the same canonical groups used by Automations, connection guards, and run snapshots."
        actions={<button className="button button--primary" type="button" onClick={startCreate} disabled={supportLoading || policySetIds.length === 0}>New Publication Group</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />
      <div className="toolbar">
        <label className="field field--inline">
          <span>State</span>
          <select value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value as typeof enabledFilter)}>
            <option value="">All groups</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()} disabled={collection.loading}>Refresh</button>
      </div>

      <div className={`publication-group-layout ${editor || groupId ? "publication-group-layout--open" : ""}`.trim()}>
        <Panel className="publication-group-list-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="publication-group-list">
              {collection.items.map((entry) => {
                const confirming = pendingToggle === entry.group.id;
                return (
                  <article className="publication-group-row" key={entry.group.id}>
                    <button className="publication-group-row__identity" type="button" onClick={() => startEdit(entry)}>
                      <strong>{entry.group.name}</strong>
                      <small>{entry.group.id}</small>
                    </button>
                    <div><small>Destinations</small><span>{entry.group.routes.length}</span></div>
                    <div><small>Policy</small><span>{entry.group.policySetId}</span></div>
                    <div><small>Version</small><span>v{entry.version}</span></div>
                    <StatusPill value={entry.enabled ? "enabled" : "disabled"} />
                    <div className="publication-group-row__actions">
                      <button className="button button--quiet" type="button" onClick={() => startEdit(entry)} disabled={busy !== null}>Manage</button>
                      {confirming ? (
                        <div className="inline-confirm-actions" role="group" aria-label={`${entry.enabled ? "Disable" : "Enable"} ${entry.group.name}`}>
                          <button className="button button--quiet" type="button" onClick={() => setPendingToggle(null)} disabled={busy !== null}>Cancel</button>
                          <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" autoFocus onClick={() => void toggleEnabled(entry)} disabled={busy !== null}>
                            {busy === `toggle:${entry.group.id}` ? "Saving…" : `Confirm ${entry.enabled ? "disable" : "enable"}`}
                          </button>
                        </div>
                      ) : (
                        <button className={entry.enabled ? "button button--danger" : "button button--primary"} type="button" onClick={() => setPendingToggle(entry.group.id)} disabled={busy !== null}>
                          {entry.enabled ? "Disable" : "Enable"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              {collection.items.length === 0 ? (
                <div className="publication-group-empty">
                  <EmptyState title="No Publication Groups yet">Create one here instead of reaching for the Operator API. A group is the reusable routing unit Automations publish through.</EmptyState>
                  <button className="button button--primary" type="button" onClick={startCreate} disabled={supportLoading || policySetIds.length === 0}>Create Publication Group</button>
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>

        {editor ? (
          <Panel title={editor.mode === "create" ? "Create Publication Group" : `Manage ${editor.name}`} meta={editor.mode === "edit" ? `v${editor.expectedVersion}` : "New group"} className="publication-group-editor">
            <form className="publication-group-editor__form" onSubmit={save}>
              <label className="field">
                <span>Group name</span>
                <input autoFocus value={editor.name} onChange={(event) => setEditor((current) => current ? { ...current, name: event.target.value } : current)} required autoComplete="off" />
              </label>
              <label className="field">
                <span>Policy set</span>
                <select value={editor.policySetId} onChange={(event) => setEditor((current) => current ? { ...current, policySetId: event.target.value } : current)} required>
                  {policySetIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <label className="field field--checkbox publication-group-enabled-field">
                <span>Group enabled</span>
                <input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor((current) => current ? { ...current, enabled: event.target.checked } : current)} />
                <small>Disabled groups remain versioned and inspectable but cannot be used for new publication runs.</small>
              </label>

              <fieldset className="publication-group-destinations">
                <legend>Publishing destinations</legend>
                {activeConnections.map((connection) => {
                  const type = typeById.get(connection.extensionId);
                  const selected = editor.selectedConnectionIds.has(connection.id);
                  const routeEnabled = editor.enabledConnectionIds.has(connection.id);
                  return (
                    <div className="publication-group-destination-row" key={connection.id}>
                      <label className="publication-group-destination-select">
                        <input type="checkbox" checked={selected} onChange={(event) => toggleConnection(connection.id, event.target.checked)} />
                        <span>
                          <strong>{connection.displayName}</strong>
                          <small>{type?.manifest.displayName ?? connection.extensionId} · {connection.status}</small>
                        </span>
                      </label>
                      {selected ? (
                        <label className="publication-group-route-toggle">
                          <input
                            type="checkbox"
                            checked={routeEnabled}
                            onChange={(event) => toggleRoute(connection.id, event.target.checked)}
                            disabled={!routeEnabled && connection.status !== "active" && editor.enabled}
                          />
                          <span>Publish through this destination</span>
                        </label>
                      ) : <span />}
                      <StatusPill value={connection.status === "active" ? "enabled" : "disabled"} tone={connection.status === "active" ? "good" : "warn"} />
                    </div>
                  );
                })}
                {activeConnections.length === 0 ? <EmptyState title="No publishing destinations">Create or enable a Connection before building a Publication Group.</EmptyState> : null}
              </fieldset>

              {missingRoutes.length ? (
                <div className="publication-group-warning" role="status">
                  <strong>{missingRoutes.length} route{missingRoutes.length === 1 ? "" : "s"} reference missing connections.</strong>
                  <p>Saving this group will remove those broken routes. Review the remaining destinations before you continue.</p>
                </div>
              ) : null}

              {editor.mode === "edit" ? (
                <div className="publication-group-route-summary">
                  <strong>Current routes</strong>
                  {editor.existingRoutes.map((route) => {
                    const connection = connectionById.get(route.destination.connectionId);
                    return (
                      <div key={route.id}>
                        <span>{connection?.displayName ?? route.destination.connectionId}</span>
                        <small>{route.destination.channel} · {route.requiredCapabilities.join(", ")}</small>
                        <StatusPill value={route.enabled ? "enabled" : "disabled"} />
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <div className="publication-group-editor__actions">
                <button className="button button--quiet" type="button" onClick={() => { setEditor(null); navigate("/publication-groups"); }} disabled={busy !== null}>Cancel</button>
                <button className="button button--primary" type="submit" disabled={busy !== null || !editor.name.trim() || editor.selectedConnectionIds.size === 0}>
                  {busy === "save" ? "Saving…" : editor.mode === "create" ? "Create group" : "Save new version"}
                </button>
              </div>
              <p className="security-note">Changes create a new immutable group version and use optimistic concurrency. Existing run snapshots remain unchanged.</p>
            </form>
          </Panel>
        ) : groupId ? <VersionsPanel groupId={groupId} nonce={changeNonce} /> : null}
      </div>

      {editor?.mode === "edit" && editor.groupId ? <VersionsPanel groupId={editor.groupId} nonce={changeNonce} /> : null}
    </>
  );
}
