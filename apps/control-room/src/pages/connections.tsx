import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type {
  ConnectionCreateBody,
  ConnectionUpdateBody,
  OperatorConnectionSettingField,
  OperatorConnectionTestResult,
  OperatorConnectionType,
  OperatorConnectionView,
  PublicationGroupRegistryEntry,
  SourceContentRecord,
  SourceContentRevision,
} from "@blogmaatic/operator-client";

import { EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { useConnection } from "../connection";

interface EditorState {
  readonly mode: "create" | "edit";
  readonly connectionId?: string;
  readonly extensionId: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly settings: Readonly<Record<string, string | boolean>>;
  readonly secrets: Readonly<Record<string, string>>;
}

type FieldValue = string | number | boolean | string[];
type GroupReferences = Readonly<Record<string, readonly PublicationGroupRegistryEntry[]>>;

function stringifySetting(field: OperatorConnectionSettingField, value: unknown): string | boolean {
  if (field.kind === "boolean") return value === true;
  if (field.kind === "string-list") {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
  }
  if (value === undefined || value === null) {
    const fallback = field.defaultValue;
    if (Array.isArray(fallback)) return fallback.filter((item): item is string => typeof item === "string").join("\n");
    return fallback === undefined || fallback === null ? "" : String(fallback);
  }
  return String(value);
}

function initialSettings(type: OperatorConnectionType, connection?: OperatorConnectionView): Record<string, string | boolean> {
  return Object.fromEntries(type.connectionContract.settingsFields.map((field) => [
    field.key,
    stringifySetting(field, connection?.settings[field.key]),
  ]));
}

function emptySecrets(type: OperatorConnectionType): Record<string, string> {
  return Object.fromEntries(type.connectionContract.secretFields.map((field) => [field.key, ""]));
}

function editorForCreate(type: OperatorConnectionType): EditorState {
  return {
    mode: "create",
    extensionId: type.manifest.id,
    displayName: type.manifest.displayName,
    status: "active",
    settings: initialSettings(type),
    secrets: emptySecrets(type),
  };
}

function editorForConnection(type: OperatorConnectionType, connection: OperatorConnectionView): EditorState {
  return {
    mode: "edit",
    connectionId: connection.id,
    extensionId: connection.extensionId,
    displayName: connection.displayName,
    status: connection.status,
    settings: initialSettings(type, connection),
    secrets: emptySecrets(type),
  };
}

function parseSetting(field: OperatorConnectionSettingField, raw: string | boolean): FieldValue | undefined {
  if (field.kind === "boolean") return raw === true;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (field.required) throw new Error(`${field.label} is required`);
    return undefined;
  }
  if (field.kind === "integer") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error(`${field.label} must be an integer`);
    if (field.min !== undefined && number < field.min) throw new Error(`${field.label} must be at least ${field.min}`);
    if (field.max !== undefined && number > field.max) throw new Error(`${field.label} must be at most ${field.max}`);
    return number;
  }
  if (field.kind === "string-list") {
    const values = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    if (field.required && values.length === 0) throw new Error(`${field.label} requires at least one value`);
    return values;
  }
  return value;
}

function preparedSettings(type: OperatorConnectionType, editor: EditorState): Record<string, FieldValue> {
  const settings: Record<string, FieldValue> = {};
  for (const field of type.connectionContract.settingsFields) {
    const value = parseSetting(field, editor.settings[field.key] ?? (field.kind === "boolean" ? false : ""));
    if (value !== undefined) settings[field.key] = value;
  }
  return settings;
}

function preparedSecrets(
  type: OperatorConnectionType,
  editor: EditorState,
  configured: readonly string[],
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of type.connectionContract.secretFields) {
    const value = editor.secrets[field.key]?.trim() ?? "";
    if (value) {
      secrets[field.key] = value;
      continue;
    }
    if (field.required && editor.mode === "create") throw new Error(`${field.label} is required`);
    if (field.required && editor.mode === "edit" && !configured.includes(field.key)) {
      throw new Error(`${field.label} is required`);
    }
  }
  return secrets;
}

function isUsable(result: OperatorConnectionTestResult): boolean {
  return result.validation.valid && result.health !== undefined && result.health.state !== "unhealthy";
}

function healthTone(result: OperatorConnectionTestResult | undefined): "good" | "warn" | "bad" | "neutral" {
  if (!result) return "neutral";
  if (!result.validation.valid || result.health?.state === "unhealthy") return "bad";
  if (result.health?.state === "degraded") return "warn";
  return "good";
}

function healthLabel(result: OperatorConnectionTestResult | undefined): string {
  if (!result) return "Not tested";
  if (!result.validation.valid) return "Invalid";
  return result.health?.state ?? "Valid";
}

function indexGroupReferences(groups: readonly PublicationGroupRegistryEntry[]): GroupReferences {
  const references: Record<string, PublicationGroupRegistryEntry[]> = {};
  for (const group of groups) {
    const seen = new Set<string>();
    for (const route of group.group.routes) {
      const connectionId = route.destination.connectionId;
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      (references[connectionId] ??= []).push(group);
    }
  }
  return references;
}

function SettingField({
  field,
  value,
  onChange,
}: {
  readonly field: OperatorConnectionSettingField;
  readonly value: string | boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <label className="field field--checkbox">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="field">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <select value={String(value)} onChange={(event) => onChange(event.target.value)} required={field.required}>
          {!field.required ? <option value="">Default</option> : null}
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  if (field.kind === "string-list") {
    return (
      <label className="field">
        <span>{field.label}{field.required ? " *" : ""}</span>
        <textarea rows={4} value={String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} required={field.required} />
        <small>{field.description ?? "One value per line."}</small>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}{field.required ? " *" : ""}</span>
      <input
        type={field.kind === "integer" ? "number" : field.kind === "email" ? "email" : field.kind === "url" ? "url" : "text"}
        value={String(value)}
        placeholder={field.placeholder}
        min={field.min}
        max={field.max}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        autoComplete="off"
      />
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}

function WordPressContentPanel({
  connection,
  references,
}: {
  readonly connection: OperatorConnectionView;
  readonly references: readonly PublicationGroupRegistryEntry[];
}) {
  const { session } = useConnection();
  const client = session!.client;
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly SourceContentRecord[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [revisions, setRevisions] = useState<Readonly<Record<string, readonly SourceContentRevision[]>>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const routes = useMemo(() => references.flatMap((entry) =>
    entry.group.routes
      .filter((route) =>
        route.enabled &&
        route.destination.connectionId === connection.id &&
        route.destination.extensionId === connection.extensionId,
      )
      .map((route) => ({
        key: `${entry.group.id}\u0000${route.id}`,
        groupId: entry.group.id,
        groupName: entry.group.name,
        routeId: route.id,
        channel: route.destination.channel,
      })),
  ), [connection.extensionId, connection.id, references]);
  const [importRoute, setImportRoute] = useState("");

  useEffect(() => {
    if (!importRoute && routes.length === 1) setImportRoute(routes[0]!.key);
  }, [importRoute, routes]);

  const load = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listSourceContent(connection.id, {
        page: nextPage,
        limit: 30,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress content could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, connection.id, search]);

  useEffect(() => { void load(); }, [load]);

  const replaceItem = useCallback((next: SourceContentRecord) => {
    setItems((current) => current.map((item) => item.remoteId === next.remoteId ? next : item));
  }, []);

  const importItem = useCallback(async (item: SourceContentRecord) => {
    const selected = routes.find((route) => route.key === importRoute);
    if (!selected) {
      setError(new Error("Choose the WordPress Publication Group route that should own this imported post."));
      return;
    }
    setBusy(`import:${item.remoteId}`);
    setError(null);
    try {
      const result = await client.importSourceContent(connection.id, item.remoteId, {
        groupId: selected.groupId,
        routeId: selected.routeId,
      });
      replaceItem(result.remote);
      navigate(`/publications/${encodeURIComponent(result.publication.publication.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress post could not be imported"));
    } finally {
      setBusy(null);
    }
  }, [client, connection.id, importRoute, navigate, replaceItem, routes]);

  const loadRevisions = useCallback(async (item: SourceContentRecord) => {
    setBusy(`revisions:${item.remoteId}`);
    setError(null);
    try {
      const result = await client.listSourceContentRevisions(connection.id, item.remoteId);
      setRevisions((current) => ({ ...current, [item.remoteId]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress revisions could not be loaded"));
    } finally {
      setBusy(null);
    }
  }, [client, connection.id]);

  const mutate = useCallback(async (
    item: SourceContentRecord,
    action: "trash" | "restore" | "delete",
  ) => {
    setBusy(`${action}:${item.remoteId}`);
    setError(null);
    try {
      if (action === "trash") {
        replaceItem(await client.trashSourceContent(connection.id, item.remoteId));
      } else if (action === "restore") {
        replaceItem(await client.restoreSourceContent(connection.id, item.remoteId));
      } else {
        await client.deleteSourceContentPermanently(connection.id, item.remoteId);
        setItems((current) => current.filter((candidate) => candidate.remoteId !== item.remoteId));
        setPendingDelete(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress content mutation failed"));
    } finally {
      setBusy(null);
    }
  }, [client, connection.id, replaceItem]);

  return (
    <Panel title="WordPress content" meta="Live source library" className="wordpress-content-panel">
      <div className="wordpress-content-toolbar">
        <label className="field">
          <span>Search posts</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void load(1, false);
              }
            }}
            placeholder="Search title or content"
          />
        </label>
        <label className="field">
          <span>Import ownership route</span>
          <select value={importRoute} onChange={(event) => setImportRoute(event.target.value)}>
            <option value="">Choose route</option>
            {routes.map((route) => (
              <option key={route.key} value={route.key}>{route.groupName} · {route.channel}</option>
            ))}
          </select>
        </label>
        <button className="button button--quiet" type="button" onClick={() => void load(1, false)} disabled={loading}>Refresh</button>
      </div>
      <ErrorBanner error={error} />
      {routes.length === 0 ? (
        <div className="warning-banner">
          <strong>No enabled WordPress Publication Group route uses this connection.</strong>
          <span>Create or enable a route before importing existing WordPress content into canonical Blogmaatic ownership.</span>
        </div>
      ) : null}
      {loading && items.length === 0 ? <LoadingBlock /> : (
        <div className="wordpress-content-list">
          {items.map((item) => {
            const itemRevisions = revisions[item.remoteId];
            const deleting = pendingDelete === item.remoteId;
            return (
              <article className="wordpress-content-row" key={item.remoteId}>
                <div className="wordpress-content-row__headline">
                  <span>
                    <strong>{item.title || `WordPress post #${item.remoteId}`}</strong>
                    <small>#{item.remoteId} · /{item.slug || "(no slug)"} · {item.status}</small>
                  </span>
                  <div>
                    <StatusPill value={item.managed ? "Blogmaatic managed" : "External"} tone={item.managed ? "good" : "neutral"} />
                    {item.modifiedAt ? <small>{item.modifiedAt}</small> : null}
                  </div>
                </div>
                {item.excerpt ? <p>{item.excerpt}</p> : null}
                <div className="wordpress-content-row__actions">
                  <a className="button button--quiet" href={item.remoteUrl} target="_blank" rel="noreferrer">View WP</a>
                  <button className="button button--quiet" type="button" onClick={() => void loadRevisions(item)} disabled={busy !== null}>
                    {busy === `revisions:${item.remoteId}` ? "Loading…" : itemRevisions ? "Refresh revisions" : "Revisions"}
                  </button>
                  {item.managed && item.publicationId ? (
                    <Link className="button button--quiet" to={`/publications/${encodeURIComponent(item.publicationId)}`}>Open publication</Link>
                  ) : (
                    <button className="button button--primary" type="button" onClick={() => void importItem(item)} disabled={busy !== null || !importRoute}>
                      {busy === `import:${item.remoteId}` ? "Importing…" : "Import"}
                    </button>
                  )}
                  {item.managed && item.status !== "trash" ? (
                    <button className="button button--quiet" type="button" onClick={() => void mutate(item, "trash")} disabled={busy !== null}>
                      {busy === `trash:${item.remoteId}` ? "Trashing…" : "Move to Trash"}
                    </button>
                  ) : null}
                  {item.managed && item.status === "trash" ? (
                    <>
                      <button className="button button--quiet" type="button" onClick={() => void mutate(item, "restore")} disabled={busy !== null}>
                        {busy === `restore:${item.remoteId}` ? "Restoring…" : "Restore as draft"}
                      </button>
                      {deleting ? (
                        <span className="inline-confirm-actions">
                          <button className="button button--quiet" type="button" onClick={() => setPendingDelete(null)} disabled={busy !== null}>Cancel</button>
                          <button className="button button--danger" type="button" autoFocus onClick={() => void mutate(item, "delete")} disabled={busy !== null}>
                            {busy === `delete:${item.remoteId}` ? "Deleting…" : "Delete permanently"}
                          </button>
                        </span>
                      ) : (
                        <button className="button button--danger" type="button" onClick={() => setPendingDelete(item.remoteId)} disabled={busy !== null}>Delete permanently</button>
                      )}
                    </>
                  ) : null}
                </div>
                {itemRevisions ? (
                  <div className="wordpress-revision-list">
                    {itemRevisions.length === 0 ? <small>No native WordPress revisions are available.</small> : itemRevisions.map((revision) => (
                      <span key={revision.remoteRevisionId}>
                        <strong>WP rev {revision.remoteRevisionId}</strong>
                        <small>{revision.modifiedAt ?? revision.createdAt ?? "No timestamp"} · {revision.title || "Untitled"}</small>
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
          {items.length === 0 ? <EmptyState title="No WordPress posts found">The connected WordPress source returned no posts for this query.</EmptyState> : null}
        </div>
      )}
      {hasMore ? (
        <div className="collection-footer">
          <button className="button button--quiet" type="button" onClick={() => void load(page + 1, true)} disabled={loading}>Load more</button>
        </div>
      ) : null}
    </Panel>
  );
}

export function ConnectionsPage() {
  const { session } = useConnection();
  const client = session!.client;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setupMode = searchParams.get("setup") === "1";
  const [types, setTypes] = useState<readonly OperatorConnectionType[]>([]);
  const [connections, setConnections] = useState<readonly OperatorConnectionView[]>([]);
  const [groupReferences, setGroupReferences] = useState<GroupReferences>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [health, setHealth] = useState<Readonly<Record<string, OperatorConnectionTestResult>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const groupsPromise = (async () => {
        const groups: PublicationGroupRegistryEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listPublicationGroups({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
          groups.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        return groups;
      })();
      const [typeResponse, connectionResponse, enabledGroups] = await Promise.all([
        client.listConnectionTypes(),
        client.listConnections(),
        groupsPromise,
      ]);
      setTypes(typeResponse.items);
      setConnections(connectionResponse.items);
      setGroupReferences(indexGroupReferences(enabledGroups));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Could not load publisher connections"));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const typeById = useMemo(() => new Map(types.map((type) => [type.manifest.id, type])), [types]);
  const selectedType = editor ? typeById.get(editor.extensionId) : undefined;
  const selectedConnection = editor?.connectionId
    ? connections.find((connection) => connection.id === editor.connectionId)
    : undefined;
  const selectedReferences = editor?.connectionId ? groupReferences[editor.connectionId] ?? [] : [];

  const startCreate = useCallback((type?: OperatorConnectionType) => {
    const selected = type ?? types[0];
    if (!selected) return;
    setPendingRemove(null);
    setError(null);
    setEditor(editorForCreate(selected));
  }, [types]);

  const startEdit = useCallback((connection: OperatorConnectionView) => {
    const type = typeById.get(connection.extensionId);
    if (!type) {
      setError(new Error(`Publisher contract is unavailable for ${connection.extensionId}`));
      return;
    }
    setPendingRemove(null);
    setError(null);
    setEditor(editorForConnection(type, connection));
  }, [typeById]);

  const testConnection = useCallback(async (connectionId: string) => {
    setBusy(`test:${connectionId}`);
    setError(null);
    try {
      const result = await client.testConnection(connectionId);
      setHealth((current) => ({ ...current, [connectionId]: result }));
      if (setupMode && isUsable(result)) navigate("/setup", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection test failed"));
    } finally {
      setBusy(null);
    }
  }, [client, navigate, setupMode]);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !selectedType) return;
    const operation = editor.mode === "create" ? "create" : `save:${editor.connectionId}`;
    setBusy(operation);
    setError(null);
    try {
      const settings = preparedSettings(selectedType, editor);
      const secrets = preparedSecrets(selectedType, editor, selectedConnection?.configuredSecrets ?? []);
      if (editor.mode === "create") {
        const input: ConnectionCreateBody = {
          extensionId: editor.extensionId,
          displayName: editor.displayName.trim(),
          status: editor.status,
          settings,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        };
        const created = await client.createConnection(input);
        setConnections((current) => [...current, created].sort((a, b) => a.displayName.localeCompare(b.displayName)));
        setEditor(null);
        const result = await client.testConnection(created.id);
        setHealth((current) => ({ ...current, [created.id]: result }));
        if (setupMode && isUsable(result)) navigate("/setup", { replace: true });
      } else if (editor.connectionId) {
        const references = groupReferences[editor.connectionId] ?? [];
        if (editor.status === "disabled" && selectedConnection?.status === "active" && references.length > 0) {
          throw new Error(`This connection is still used by ${references.length} enabled Publication Group${references.length === 1 ? "" : "s"}. Disable or edit those groups first.`);
        }
        const input: ConnectionUpdateBody = {
          displayName: editor.displayName.trim(),
          status: editor.status,
          settings,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        };
        const updated = await client.updateConnection(editor.connectionId, input);
        setConnections((current) => current.map((connection) => connection.id === updated.id ? updated : connection));
        setEditor(editorForConnection(selectedType, updated));
        if (setupMode && updated.status === "active") {
          const result = await client.testConnection(updated.id);
          setHealth((current) => ({ ...current, [updated.id]: result }));
          if (isUsable(result)) navigate("/setup", { replace: true });
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection could not be saved"));
    } finally {
      setBusy(null);
    }
  }, [client, editor, groupReferences, navigate, selectedConnection, selectedType, setupMode]);

  const remove = useCallback(async (connection: OperatorConnectionView) => {
    const references = groupReferences[connection.id] ?? [];
    if (references.length > 0) {
      setPendingRemove(null);
      setError(new Error(`Remove is blocked because ${connection.displayName} is used by ${references.length} enabled Publication Group${references.length === 1 ? "" : "s"}. Open the referenced groups and remove or disable that route first.`));
      return;
    }
    setBusy(`remove:${connection.id}`);
    setError(null);
    try {
      await client.removeConnection(connection.id);
      setPendingRemove(null);
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setHealth((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      if (editor?.connectionId === connection.id) setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Connection could not be removed"));
    } finally {
      setBusy(null);
    }
  }, [client, editor?.connectionId, groupReferences]);

  if (loading) return <LoadingBlock />;

  return (
    <>
      <PageHeader
        eyebrow={setupMode ? "First run · Destination" : "Destinations"}
        title="Connections"
        description="Connect real publishing destinations. Blogmaatic shows which enabled Publication Groups depend on each connection before you change or remove it. Credentials remain write-only and are stored in the operating system vault."
        actions={(
          <div className="topbar__actions">
            {setupMode ? <button className="button button--quiet" type="button" onClick={() => navigate("/setup")}>Back to setup</button> : null}
            <button className="button button--primary" type="button" onClick={() => startCreate()} disabled={types.length === 0}>New connection</button>
          </div>
        )}
      />
      <ErrorBanner error={error} />

      {types.length === 0 ? (
        <Panel><EmptyState title="No publisher contracts are registered">The runtime has no connection-capable publisher extensions available.</EmptyState></Panel>
      ) : (
        <div className={`connection-manager ${editor ? "connection-manager--editing" : ""}`.trim()}>
          <Panel title="Publishing destinations" meta={`${connections.length} configured`} className="connection-list-panel">
            {connections.length === 0 ? (
              <EmptyState title="No destinations yet">Create a destination to connect Blogmaatic to Jekyll, WordPress, LinkedIn, Facebook Pages, or another installed publisher.</EmptyState>
            ) : (
              <div className="connection-list">
                {connections.map((connection) => {
                  const type = typeById.get(connection.extensionId);
                  const result = health[connection.id];
                  const references = groupReferences[connection.id] ?? [];
                  const confirmingRemove = pendingRemove === connection.id;
                  return (
                    <article className="connection-row" key={connection.id}>
                      <div className="connection-row__identity">
                        <strong>{connection.displayName}</strong>
                        <small>{type?.manifest.displayName ?? connection.extensionId}</small>
                      </div>
                      <div className="connection-row__state">
                        <StatusPill value={connection.status === "active" ? "enabled" : "disabled"} />
                        <StatusPill value={healthLabel(result)} tone={healthTone(result)} />
                      </div>
                      <div className="connection-row__actions">
                        <button className="button button--quiet" type="button" onClick={() => void testConnection(connection.id)} disabled={busy !== null}>
                          {busy === `test:${connection.id}` ? "Testing…" : "Test"}
                        </button>
                        <button className="button button--quiet" type="button" onClick={() => startEdit(connection)} disabled={busy !== null}>Edit</button>
                        {references.length > 0 ? (
                          <Link className="button button--quiet" to={`/publication-groups/${encodeURIComponent(references[0]!.group.id)}`}>Used by {references.length} group{references.length === 1 ? "" : "s"}</Link>
                        ) : confirmingRemove ? (
                          <div className="inline-confirm-actions" role="group" aria-label={`Remove ${connection.displayName}`}>
                            <button className="button button--quiet" type="button" onClick={() => setPendingRemove(null)} disabled={busy !== null}>Cancel</button>
                            <button className="button button--danger" type="button" autoFocus onClick={() => void remove(connection)} disabled={busy !== null}>
                              {busy === `remove:${connection.id}` ? "Removing…" : "Confirm remove"}
                            </button>
                          </div>
                        ) : (
                          <button className="button button--danger" type="button" onClick={() => setPendingRemove(connection.id)} disabled={busy !== null}>Remove</button>
                        )}
                      </div>
                      {confirmingRemove ? (
                        <div className="connection-row__detail" role="status">
                          <span>Removing this connection also removes its managed stored credentials. This cannot be undone from the Control Room.</span>
                        </div>
                      ) : result || references.length > 0 ? (
                        <div className="connection-row__detail">
                          {result ? (
                            <span>
                              {result.validation.valid ? "Configuration valid" : result.validation.errors.join(" · ")}
                              {result.health?.detail ? ` · ${result.health.detail}` : ""}
                            </span>
                          ) : null}
                          {references.length > 0 ? (
                            <span className="connection-row__references">
                              Used by {references.map((entry, index) => (
                                <span key={entry.group.id}>{index > 0 ? ", " : ""}<Link to={`/publication-groups/${encodeURIComponent(entry.group.id)}`}>{entry.group.name}</Link></span>
                              ))}. Disable or edit those groups before disabling/removing this connection.
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>

          {editor && selectedType ? (
            <Panel
              title={editor.mode === "create" ? `Connect ${selectedType.manifest.displayName}` : `Edit ${editor.displayName}`}
              meta={editor.mode === "edit" ? editor.connectionId : "New destination"}
              className="connection-editor"
            >
              <form className="connection-editor__form" onSubmit={save}>
                {editor.mode === "edit" && selectedReferences.length > 0 ? (
                  <div className="connection-reference-warning" role="status">
                    <strong>Used by {selectedReferences.length} enabled Publication Group{selectedReferences.length === 1 ? "" : "s"}</strong>
                    <p>You can rotate credentials or edit settings safely, but disabling this connection is blocked until the referencing groups are updated.</p>
                    <div className="connection-reference-links">
                      {selectedReferences.map((entry) => <Link key={entry.group.id} to={`/publication-groups/${encodeURIComponent(entry.group.id)}`}>{entry.group.name}</Link>)}
                    </div>
                  </div>
                ) : null}

                {editor.mode === "create" ? (
                  <label className="field">
                    <span>Publisher</span>
                    <select
                      value={editor.extensionId}
                      onChange={(event) => {
                        const next = typeById.get(event.target.value);
                        if (next) setEditor(editorForCreate(next));
                      }}
                    >
                      {types.map((type) => <option key={type.manifest.id} value={type.manifest.id}>{type.manifest.displayName}</option>)}
                    </select>
                  </label>
                ) : null}

                <label className="field">
                  <span>Connection name *</span>
                  <input
                    autoFocus
                    value={editor.displayName}
                    onChange={(event) => setEditor((current) => current ? { ...current, displayName: event.target.value } : current)}
                    required
                    autoComplete="off"
                  />
                </label>

                <label className="field">
                  <span>Status</span>
                  <select
                    value={editor.status}
                    onChange={(event) => setEditor((current) => current ? { ...current, status: event.target.value as "active" | "disabled" } : current)}
                  >
                    <option value="active">Active</option>
                    <option value="disabled" disabled={editor.mode === "edit" && selectedReferences.length > 0}>Disabled{editor.mode === "edit" && selectedReferences.length > 0 ? " · update Publication Groups first" : ""}</option>
                  </select>
                </label>

                {selectedType.connectionContract.settingsFields.length ? <div className="form-section-title">Destination settings</div> : null}
                {selectedType.connectionContract.settingsFields.map((field) => (
                  <SettingField
                    key={field.key}
                    field={field}
                    value={editor.settings[field.key] ?? (field.kind === "boolean" ? false : "")}
                    onChange={(value) => setEditor((current) => current ? {
                      ...current,
                      settings: { ...current.settings, [field.key]: value },
                    } : current)}
                  />
                ))}

                {selectedType.connectionContract.secretFields.length ? (
                  <div className="form-section-title">Credentials · OS vault</div>
                ) : null}
                {selectedType.connectionContract.secretFields.map((field) => {
                  const configured = selectedConnection?.configuredSecrets.includes(field.key) ?? false;
                  return (
                    <label className="field" key={field.key}>
                      <span>{field.label}{field.required && !configured ? " *" : ""}</span>
                      <input
                        type="password"
                        value={editor.secrets[field.key] ?? ""}
                        onChange={(event) => setEditor((current) => current ? {
                          ...current,
                          secrets: { ...current.secrets, [field.key]: event.target.value },
                        } : current)}
                        required={field.required && editor.mode === "create"}
                        autoComplete="new-password"
                        placeholder={configured ? "Stored in OS vault · leave blank to keep" : undefined}
                      />
                      <small>{configured ? "Already stored in the OS credential vault. Enter a new value only to rotate it." : field.description}</small>
                    </label>
                  );
                })}

                <div className="connection-editor__actions">
                  <button className="button button--quiet" type="button" onClick={() => setEditor(null)} disabled={busy !== null}>Cancel</button>
                  <button className="button button--primary" type="submit" disabled={busy !== null || !editor.displayName.trim()}>
                    {busy ? "Saving…" : editor.mode === "create" ? "Save connection" : "Save changes"}
                  </button>
                </div>
                <p className="security-note">Secret values are sent only in this save request, written into the OS vault by the runtime, then discarded by the browser form.</p>
              </form>
            </Panel>
          ) : null}

          {selectedConnection?.extensionId === "blogmaatic.wordpress-rest" && selectedConnection.status === "active" ? (
            <WordPressContentPanel connection={selectedConnection} references={selectedReferences} />
          ) : null}
        </div>
      )}
    </>
  );
}
