import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import type {
  OperatorConnectionView,
  PublicationGroupRegistryEntry,
  SourceContentRecord,
  SourceContentRevision,
} from "@blogmaatic/operator-client";

import { EmptyState, ErrorBanner, LoadingBlock, Panel, StatusPill } from "./components";
import { useConnection } from "./connection";

const WORDPRESS_EXTENSION_ID = "blogmaatic.wordpress-rest";

export function WordPressContentLibrary({
  connection,
  references,
  title = "WordPress content",
  meta = "Live source library",
  onImported,
}: {
  readonly connection: OperatorConnectionView;
  readonly references: readonly PublicationGroupRegistryEntry[];
  readonly title?: string;
  readonly meta?: string;
  readonly onImported?: () => void;
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
    if (routes.some((route) => route.key === importRoute)) return;
    setImportRoute(routes.length === 1 ? routes[0]!.key : "");
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

  useEffect(() => {
    setItems([]);
    setPage(1);
    setHasMore(false);
    setRevisions({});
    setPendingDelete(null);
    void load();
  }, [connection.id, load]);

  const replaceItem = useCallback((next: SourceContentRecord) => {
    setItems((current) => current.map((item) => item.remoteId === next.remoteId ? next : item));
  }, []);

  const importItem = useCallback(async (item: SourceContentRecord) => {
    const selected = routes.find((route) => route.key === importRoute);
    if (!selected) {
      setError(new Error("Choose where this WordPress post should publish before importing it."));
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
      onImported?.();
      navigate(`/publications/${encodeURIComponent(result.publication.publication.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress post could not be imported"));
    } finally {
      setBusy(null);
    }
  }, [client, connection.id, importRoute, navigate, onImported, replaceItem, routes]);

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
    <Panel title={title} meta={meta} className="wordpress-content-panel">
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
          <span>Publish through</span>
          <select value={importRoute} onChange={(event) => setImportRoute(event.target.value)}>
            <option value="">Choose publishing route</option>
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
          <strong>This WordPress destination is not in an enabled publishing route.</strong>
          <span>Add it to a Publishing route before importing existing WordPress content into canonical Blogmaatic ownership.</span>
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
                    <small>/{item.slug || "(no slug)"} · {item.status}</small>
                  </span>
                  <div>
                    <StatusPill value={item.managed ? "In Blogmaatic" : "WordPress only"} tone={item.managed ? "good" : "neutral"} />
                    {item.modifiedAt ? <small>{item.modifiedAt}</small> : null}
                  </div>
                </div>
                {item.excerpt ? <p>{item.excerpt}</p> : null}
                <div className="wordpress-content-row__actions">
                  <a className="button button--quiet" href={item.remoteUrl} target="_blank" rel="noreferrer">View WordPress</a>
                  <button className="button button--quiet" type="button" onClick={() => void loadRevisions(item)} disabled={busy !== null}>
                    {busy === `revisions:${item.remoteId}` ? "Loading…" : itemRevisions ? "Refresh revisions" : "WordPress revisions"}
                  </button>
                  {item.managed && item.publicationId ? (
                    <Link className="button button--primary" to={`/publications/${encodeURIComponent(item.publicationId)}`}>Open in Content</Link>
                  ) : (
                    <button className="button button--primary" type="button" onClick={() => void importItem(item)} disabled={busy !== null || !importRoute}>
                      {busy === `import:${item.remoteId}` ? "Importing…" : "Import to Blogmaatic"}
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
          {items.length === 0 ? <EmptyState title="No WordPress posts found">This WordPress destination returned no posts for the current search.</EmptyState> : null}
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

export function WordPressImportWorkspace({ onClose }: { readonly onClose: () => void }) {
  const { session } = useConnection();
  const client = session!.client;
  const [connections, setConnections] = useState<readonly OperatorConnectionView[]>([]);
  const [references, setReferences] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const groupItems: PublicationGroupRegistryEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listPublicationGroups({
            enabled: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          groupItems.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);

        const connectionResponse = await client.listConnections();
        const wordpress = connectionResponse.items.filter((connection) =>
          connection.extensionId === WORDPRESS_EXTENSION_ID && connection.status === "active",
        );
        if (!active) return;
        setConnections(wordpress);
        setReferences(groupItems);
        setConnectionId((current) =>
          current && wordpress.some((connection) => connection.id === current)
            ? current
            : wordpress[0]?.id ?? "",
        );
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress sources could not be loaded"));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client]);

  if (loading) return <LoadingBlock />;

  const selected = connections.find((connection) => connection.id === connectionId);

  return (
    <section className="content-source-workspace" aria-label="Import from WordPress">
      <div className="content-source-workspace__header">
        <div>
          <span className="eyebrow">Existing content</span>
          <h2>Import from WordPress</h2>
          <p>Search your connected WordPress site, inspect native revisions, and bring an existing post into canonical Blogmaatic ownership.</p>
        </div>
        <button className="button button--quiet" type="button" onClick={onClose}>Close import</button>
      </div>
      <ErrorBanner error={error} />
      {connections.length === 0 ? (
        <Panel>
          <EmptyState title="No active WordPress destination">
            Connect and enable WordPress first, then come back here to import existing posts.
          </EmptyState>
          <div className="content-source-workspace__empty-action">
            <Link className="button button--primary" to="/connections">Open Destinations</Link>
          </div>
        </Panel>
      ) : (
        <>
          {connections.length > 1 ? (
            <div className="content-source-picker">
              <label className="field">
                <span>WordPress site</span>
                <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connection.displayName}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="content-source-current">
              <span>WordPress site</span>
              <strong>{selected?.displayName}</strong>
            </div>
          )}
          {selected ? (
            <WordPressContentLibrary
              connection={selected}
              references={references}
              title="WordPress posts"
              meta={selected.displayName}
              onImported={onClose}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
