import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  OperatorClientError,
  OperatorDistributionHistoryPage,
  PublicationGroupRegistryEntry,
  PublicationProjectionPreview,
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchResult,
  PublicationWorkspaceEntry,
  PublicationWorkspaceUpdateBody,
  SourceAssetRecord,
  SourceTaxonomyKind,
  SourceTaxonomyRecord,
  WorkspacePublicationStatus,
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
import { formatInstant, safeJson } from "../format";
import { usePagedCollection } from "../hooks";
import { WordPressImportWorkspace } from "../wordpress-content-library";

type EditorMode = "create" | "edit";

interface PublicationEditor {
  readonly mode: EditorMode;
  readonly publicationId?: string;
  readonly expectedVersion?: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly bodyFormat: "plain" | "html";
  readonly tags: string;
  readonly categories: string;
  readonly featuredAssetId: string;
  readonly imageAssets: readonly { readonly id: string; readonly label: string; readonly source: string }[];
  readonly language: string;
  readonly slug: string;
  readonly canonicalUrl: string;
  readonly status: WorkspacePublicationStatus;
  readonly hasUnsupportedBlocks: boolean;
}

const statusOptions: readonly { readonly value: WorkspacePublicationStatus; readonly label: string }[] = [
  { value: "idea", label: "Idea" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "approved", label: "Approved" },
  { value: "archived", label: "Archived" },
];

function editableBody(entry: PublicationWorkspaceEntry): {
  readonly body: string;
  readonly format: "plain" | "html";
  readonly unsupported: boolean;
} {
  const blocks = entry.publication.current.content.blocks;
  if (blocks.length === 0) return { body: "", format: "plain", unsupported: false };

  if (blocks.every((block) => block.kind === "paragraph")) {
    const paragraphs = blocks.flatMap((block) => {
      const text = block.data.text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    });
    return { body: paragraphs.join("\n\n"), format: "plain", unsupported: false };
  }

  if (blocks.length === 1 && blocks[0]?.kind === "embed") {
    const html = blocks[0].data.html;
    if (typeof html === "string") {
      return { body: html, format: "html", unsupported: false };
    }
  }

  return { body: "", format: "plain", unsupported: true };
}

function editorForCreate(): PublicationEditor {
  return {
    mode: "create",
    title: "",
    summary: "",
    body: "",
    bodyFormat: "plain",
    tags: "",
    categories: "",
    featuredAssetId: "",
    imageAssets: [],
    language: "en",
    slug: "",
    canonicalUrl: "",
    status: "draft",
    hasUnsupportedBlocks: false,
  };
}

function editorForEntry(entry: PublicationWorkspaceEntry): PublicationEditor {
  const body = editableBody(entry);
  return {
    mode: "edit",
    publicationId: entry.publication.id,
    expectedVersion: entry.version,
    title: entry.publication.current.content.title,
    summary: entry.publication.current.content.summary ?? "",
    body: body.body,
    bodyFormat: body.format,
    tags: entry.publication.current.content.tags.join(", "),
    categories: Array.isArray(entry.publication.current.content.attributes.categories)
      ? entry.publication.current.content.attributes.categories
          .filter((value): value is string => typeof value === "string")
          .join(", ")
      : "",
    featuredAssetId: entry.publication.current.content.assets.find(
      (asset) => asset.kind === "image" && asset.attributes?.featured === true,
    )?.id ?? "",
    imageAssets: entry.publication.current.content.assets
      .filter((asset) => asset.kind === "image")
      .map((asset) => ({
        id: asset.id,
        label: asset.alt?.trim() || asset.id,
        source: asset.source,
      })),
    language: entry.publication.current.content.language,
    slug: entry.publication.slug ?? "",
    canonicalUrl: entry.publication.canonicalUrl ?? "",
    status: entry.publication.status as WorkspacePublicationStatus,
    hasUnsupportedBlocks: body.unsupported,
  };
}

function listFromInput(value: string): readonly string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function addListValue(value: string, next: string): string {
  const items = listFromInput(value);
  if (items.some((item) => item.localeCompare(next, undefined, { sensitivity: "accent" }) === 0)) {
    return items.join(", ");
  }
  return [...items, next].join(", ");
}

function destinationLabel(extensionId: string): string {
  const leaf = extensionId.split(".").at(-1) ?? extensionId;
  return leaf
    .replace(/-rest$/i, "")
    .replace(/-git$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function provenanceSource(entry: PublicationWorkspaceEntry): string {
  const source = entry.publication.provenance.source;
  if (typeof source !== "string" || !source.trim()) return "Blogmaatic";
  return source === "wordpress" ? "WordPress import" :
    source === "blogmaatic.publication-workspace" ? "Created in Blogmaatic" :
      destinationLabel(source);
}

function statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "approved" || status === "published") return "good";
  if (status === "ready") return "warn";
  if (status === "archived") return "neutral";
  return "neutral";
}

function SourceTaxonomyPanel({
  connectionId,
  onSelect,
}: {
  readonly connectionId: string;
  readonly onSelect: (kind: SourceTaxonomyKind, name: string) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [kind, setKind] = useState<SourceTaxonomyKind>("category");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly SourceTaxonomyRecord[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listSourceTaxonomy(connectionId, {
        kind,
        page: nextPage,
        limit: 40,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress taxonomy could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, connectionId, kind, search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setItems([]);
    void client.listSourceTaxonomy(connectionId, { kind, page: 1, limit: 40 })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setPage(result.page);
        setHasMore(result.hasMore);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress taxonomy could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId, kind]);

  return (
    <Panel title="WordPress taxonomy" meta="Add existing categories and tags" className="source-taxonomy-panel">
      <ErrorBanner error={error} />
      <div className="source-taxonomy-toolbar">
        <div className="segmented-control" role="group" aria-label="Taxonomy type">
          <button className={kind === "category" ? "is-active" : ""} type="button" onClick={() => setKind("category")}>Categories</button>
          <button className={kind === "tag" ? "is-active" : ""} type="button" onClick={() => setKind("tag")}>Tags</button>
        </div>
        <label className="field">
          <span>Search {kind === "category" ? "categories" : "tags"}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void load(1, false);
              }
            }}
            placeholder={kind === "category" ? "Search WordPress categories" : "Search WordPress tags"}
          />
        </label>
        <button className="button button--quiet" type="button" onClick={() => void load(1, false)} disabled={loading}>Search</button>
      </div>
      {loading && items.length === 0 ? <LoadingBlock /> : (
        <div className="source-taxonomy-list">
          {items.map((item) => (
            <button
              className="source-taxonomy-item"
              type="button"
              key={`${item.kind}:${item.remoteId}`}
              onClick={() => onSelect(item.kind, item.name)}
            >
              <span><strong>{item.name}</strong><small>/{item.slug}{item.count === undefined ? "" : ` · ${item.count} item${item.count === 1 ? "" : "s"}`}</small></span>
              <span>Add</span>
            </button>
          ))}
          {items.length === 0 ? <EmptyState title="No taxonomy found">No WordPress {kind === "category" ? "categories" : "tags"} match this search.</EmptyState> : null}
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

function SourceAssetLibraryPanel({
  entry,
  connectionId,
  onAttached,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly onAttached: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly SourceAssetRecord[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadAlt, setUploadAlt] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadFeatured, setUploadFeatured] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listSourceAssets(connectionId, {
        page: nextPage,
        limit: 24,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Media Library could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, connectionId, search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listSourceAssets(connectionId, { page: 1, limit: 24 })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setPage(result.page);
        setHasMore(result.hasMore);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("Media Library could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId]);

  const attach = useCallback(async (asset: SourceAssetRecord, featured: boolean) => {
    const key = `${featured ? "featured" : "attach"}:${asset.remoteId}`;
    setBusy(key);
    setError(null);
    try {
      const result = await client.attachSourceAsset(connectionId, asset.remoteId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        featured,
      });
      onAttached(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Media Library image could not be attached"));
    } finally {
      setBusy(null);
    }
  }, [client, connectionId, entry.publication.id, entry.version, onAttached]);

  const upload = useCallback(async () => {
    if (!uploadFile) return;
    setBusy("upload");
    setError(null);
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(uploadFile.type)) {
        throw new Error("Choose a JPEG, PNG, or WebP image.");
      }
      const result = await client.uploadSourceAsset(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        filename: uploadFile.name,
        mediaType: uploadFile.type,
        bytes: new Uint8Array(await uploadFile.arrayBuffer()),
        featured: uploadFeatured,
        ...(uploadAlt.trim() ? { alt: uploadAlt.trim() } : {}),
        ...(uploadTitle.trim() ? { title: uploadTitle.trim() } : {}),
      });
      setItems((current) => [
        result.asset,
        ...current.filter((item) => item.remoteId !== result.asset.remoteId),
      ]);
      setUploadFile(null);
      setUploadAlt("");
      setUploadTitle("");
      setUploadFeatured(false);
      onAttached(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Image could not be uploaded"));
    } finally {
      setBusy(null);
    }
  }, [
    client,
    connectionId,
    entry.publication.id,
    entry.version,
    onAttached,
    uploadAlt,
    uploadFeatured,
    uploadFile,
    uploadTitle,
  ]);

  const attachedIds = useMemo(() => new Set(
    entry.publication.current.content.assets.flatMap((asset) => {
      const remoteId = asset.attributes?.sourceRemoteId;
      const sourceConnectionId = asset.attributes?.sourceConnectionId;
      if (typeof remoteId === "string" && sourceConnectionId === connectionId) return [remoteId];
      const wordpressMediaId = asset.attributes?.wordpressMediaId;
      return typeof wordpressMediaId === "number" && Number.isSafeInteger(wordpressMediaId)
        ? [String(wordpressMediaId)]
        : [];
    }),
  ), [connectionId, entry.publication.current.content.assets]);

  return (
    <Panel title="Media Library" meta="Upload or attach WordPress images" className="source-asset-panel">
      <ErrorBanner error={error} />
      <div className="source-asset-upload">
        <label className="field">
          <span>Upload image</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
            disabled={busy !== null}
          />
        </label>
        <label className="field">
          <span>Image title</span>
          <input
            value={uploadTitle}
            onChange={(event) => setUploadTitle(event.target.value)}
            placeholder="Optional WordPress media title"
            disabled={busy !== null}
          />
        </label>
        <label className="field">
          <span>Alt text</span>
          <input
            value={uploadAlt}
            onChange={(event) => setUploadAlt(event.target.value)}
            placeholder="Describe the image for accessibility"
            disabled={busy !== null}
          />
        </label>
        <label className="source-asset-upload__featured">
          <input
            type="checkbox"
            checked={uploadFeatured}
            onChange={(event) => setUploadFeatured(event.target.checked)}
            disabled={busy !== null}
          />
          <span>Use as featured image</span>
        </label>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void upload()}
          disabled={busy !== null || !uploadFile}
        >
          {busy === "upload" ? "Uploading…" : "Upload & attach"}
        </button>
      </div>
      <div className="source-asset-toolbar">
        <label className="field">
          <span>Search media</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void load(1, false);
              }
            }}
            placeholder="Search WordPress images"
          />
        </label>
        <button className="button button--quiet" type="button" onClick={() => void load(1, false)} disabled={loading}>Search</button>
      </div>
      {loading && items.length === 0 ? <LoadingBlock /> : (
        <div className="source-asset-grid">
          {items.map((asset) => {
            const attached = attachedIds.has(asset.remoteId);
            return (
              <article className="source-asset-card" key={asset.remoteId}>
                <div className="source-asset-card__preview">
                  <img src={asset.sourceUrl} alt={asset.alt ?? asset.title ?? ""} loading="lazy" />
                </div>
                <div className="source-asset-card__body">
                  <strong>{asset.title || asset.alt || `WordPress media #${asset.remoteId}`}</strong>
                  <small>
                    {asset.width && asset.height ? `${asset.width}×${asset.height}` : "Image"}
                    {asset.mediaType ? ` · ${asset.mediaType}` : ""}
                  </small>
                  {attached ? <StatusPill value="attached" tone="good" /> : null}
                </div>
                <div className="source-asset-card__actions">
                  <button className="button button--quiet" type="button" onClick={() => void attach(asset, false)} disabled={busy !== null || attached}>
                    {busy === `attach:${asset.remoteId}` ? "Attaching…" : attached ? "Attached" : "Attach"}
                  </button>
                  <button className="button button--primary" type="button" onClick={() => void attach(asset, true)} disabled={busy !== null}>
                    {busy === `featured:${asset.remoteId}` ? "Setting…" : "Use as featured"}
                  </button>
                </div>
              </article>
            );
          })}
          {items.length === 0 ? <EmptyState title="No images found">This WordPress Media Library returned no images for the current search.</EmptyState> : null}
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

function VersionsPanel({ publicationId, nonce }: { readonly publicationId: string; readonly nonce: number }) {
  const { session } = useConnection();
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listPublicationVersions(publicationId, { limit: 30, ...(cursor ? { cursor } : {}) });
  }, [publicationId, session]);
  const collection = usePagedCollection(`publication-versions:${publicationId}:${nonce}`, loader);

  return (
    <Panel title="Content history" meta="Immutable revisions and workspace snapshots" className="publication-history">
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="publication-version-list">
          {collection.items.map((entry) => (
            <div className="publication-version-row" key={entry.version}>
              <div><strong>v{entry.version}</strong><small>{formatInstant(entry.recordedAt)}</small></div>
              <span>revision {entry.publication.current.ordinal}</span>
              <StatusPill value={entry.publication.status} tone={statusTone(entry.publication.status)} />
            </div>
          ))}
          {collection.items.length === 0 ? <EmptyState title="No history yet">This publication has no stored workspace versions.</EmptyState> : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

function PublishingSummaryPanel({ entry, nonce }: { readonly entry: PublicationWorkspaceEntry; readonly nonce: number }) {
  const { session } = useConnection();
  const client = session!.client;
  const [records, setRecords] = useState<OperatorDistributionHistoryPage["items"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listPublicationDistributions(entry.publication.id, { limit: 50 })
      .then((page) => {
        if (active) setRecords(page.items);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("Publishing state could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, entry.publication.id, nonce]);

  const latestByRoute = useMemo(() => {
    const map = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      if (!map.has(record.routeId)) map.set(record.routeId, record);
    }
    return [...map.values()];
  }, [records]);

  return (
    <Panel title="Publishing" meta="Current publication state" className="publication-publishing-panel">
      <ErrorBanner error={error} />
      <div className="publication-publishing-summary">
        <div>
          <small>Status</small>
          <StatusPill value={entry.publication.status} tone={statusTone(entry.publication.status)} />
        </div>
        <div>
          <small>Current revision</small>
          <strong>r{entry.publication.current.ordinal}</strong>
        </div>
        <div>
          <small>Source</small>
          <strong>{provenanceSource(entry)}</strong>
        </div>
        <div>
          <small>Published routes</small>
          <strong>{loading ? "…" : latestByRoute.length}</strong>
        </div>
      </div>

      {latestByRoute.length ? (
        <div className="publication-destination-summary">
          {latestByRoute.slice(0, 6).map((record) => {
            const current = record.revisionId === entry.publication.current.id;
            return (
              <div className="publication-destination-summary__row" key={record.routeId}>
                <span>
                  <strong>{destinationLabel(record.destination.extensionId)}</strong>
                  <small>{record.destination.connectionId}</small>
                </span>
                <span>
                  <StatusPill
                    value={current ? record.receipt.status : "update available"}
                    tone={current && record.receipt.status === "verified" ? "good" : "warn"}
                  />
                  {record.receipt.remote?.url ? <a href={record.receipt.remote.url} target="_blank" rel="noreferrer">Open remote</a> : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : !loading ? (
        <div className="publication-publishing-empty">
          <span>This publication has not been sent to a destination yet.</span>
        </div>
      ) : null}

      <div className="publication-publishing-actions">
        {entry.publication.status === "approved" ? (
          <Link className="button button--primary" to={`/schedules?create=1&publication=${encodeURIComponent(entry.publication.id)}`}>Schedule</Link>
        ) : (
          <span className="publication-schedule-lock">
            <button className="button button--quiet" type="button" disabled>Schedule</button>
            <small>Save with Approved status to schedule.</small>
          </span>
        )}
        <Link className="button button--quiet" to="/activity">Open Activity</Link>
        {entry.publication.canonicalUrl ? <a className="button button--quiet" href={entry.publication.canonicalUrl} target="_blank" rel="noreferrer">Canonical URL</a> : null}
      </div>

      <details className="publication-technical-details">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Publication ID</dt><dd>{entry.publication.id}</dd></div>
          <div><dt>Revision ID</dt><dd>{entry.publication.current.id}</dd></div>
          <div><dt>Workspace version</dt><dd>v{entry.version}</dd></div>
        </dl>
      </details>
    </Panel>
  );
}

function ProjectionPreviewPanel({ entry, nonce }: { readonly entry: PublicationWorkspaceEntry; readonly nonce: number }) {
  const { session } = useConnection();
  const client = session!.client;
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [groupId, setGroupId] = useState("");
  const [preview, setPreview] = useState<PublicationProjectionPreview | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingGroups(true);
    setError(null);
    void (async () => {
      try {
        const items: PublicationGroupRegistryEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listPublicationGroups({ enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
          items.push(...page.items.filter((candidate) => candidate.group.routes.some((route) => route.enabled)));
          cursor = page.nextCursor;
        } while (cursor);
        if (!active) return;
        setGroups(items);
        setGroupId((current) => current && items.some((item) => item.group.id === current) ? current : items[0]?.group.id ?? "");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error("Publishing routes could not be loaded"));
      } finally {
        if (active) setLoadingGroups(false);
      }
    })();
    return () => { active = false; };
  }, [client]);

  const loadPreview = useCallback(async (selectedGroupId: string) => {
    if (!selectedGroupId) {
      setPreview(null);
      return;
    }
    setLoadingPreview(true);
    setError(null);
    try {
      setPreview(await client.previewPublication(entry.publication.id, selectedGroupId));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause : new Error("Destination preview could not be compiled"));
    } finally {
      setLoadingPreview(false);
    }
  }, [client, entry.publication.id]);

  useEffect(() => {
    if (!groupId) {
      setPreview(null);
      return;
    }
    void loadPreview(groupId);
  }, [entry.publication.current.id, groupId, loadPreview, nonce]);

  return (
    <Panel title="Destination preview" meta="Compiled with the real publishing adapters" className="projection-preview-panel">
      <ErrorBanner error={error} />
      <div className="projection-preview-toolbar">
        <label className="field">
          <span>Preview publishing route</span>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)} disabled={loadingGroups || groups.length === 0}>
            {groups.length === 0 ? <option value="">No enabled routes</option> : null}
            {groups.map((group) => <option key={group.group.id} value={group.group.id}>{group.group.name}</option>)}
          </select>
        </label>
        <button className="button button--quiet" type="button" onClick={() => void loadPreview(groupId)} disabled={!groupId || loadingPreview}>
          {loadingPreview ? "Compiling…" : "Refresh preview"}
        </button>
      </div>
      <div className="projection-preview-note">
        <strong>Truthful local preview.</strong>
        <span>This is the exact payload Blogmaatic currently compiles for each destination. It does not mean the remote platform has accepted it yet.</span>
      </div>
      {loadingGroups || loadingPreview ? <LoadingBlock /> : null}
      {!loadingGroups && groups.length === 0 ? (
        <EmptyState title="No enabled publishing route">Create or enable a Publishing route to preview destination-specific output.</EmptyState>
      ) : null}
      {preview && !loadingPreview ? (
        <div className="projection-preview-grid">
          {preview.items.map((item) => (
            <article className={item.status === "ready" ? "projection-preview-card" : "projection-preview-card projection-preview-card--error"} key={item.routeId}>
              <div className="projection-preview-card__header">
                <span>
                  <strong>{item.destination.extensionName}</strong>
                  <small>{item.destination.connectionName} · {item.destination.channel}</small>
                </span>
                <StatusPill value={item.status === "ready" ? "compiled" : "cannot compile"} tone={item.status === "ready" ? "good" : "bad"} />
              </div>
              {item.status === "error" ? (
                <div className="projection-preview-error">{item.error}</div>
              ) : (
                <>
                  <div className="projection-preview-facts">
                    {item.summary.mode ? <span><small>Mode</small><strong>{item.summary.mode}</strong></span> : null}
                    {item.summary.status ? <span><small>Status</small><strong>{item.summary.status}</strong></span> : null}
                    {item.summary.path ? <span><small>Path</small><strong>{item.summary.path}</strong></span> : null}
                    {item.summary.mediaCount !== undefined ? <span><small>Media</small><strong>{item.summary.mediaCount}</strong></span> : null}
                    {item.summary.fidelity ? (
                      <span><small>Fidelity</small><strong>{item.summary.fidelity.score}%{item.summary.fidelity.exact ? " exact" : ""}</strong></span>
                    ) : null}
                  </div>
                  {item.summary.media?.length ? (
                    <div className="projection-preview-media">
                      {item.summary.media.map((media, index) => (
                        <div className="projection-preview-media__item" key={media.derivedAssetId ?? media.assetId ?? index}>
                          <span>
                            <strong>{media.assetId ?? `Image ${index + 1}`}</strong>
                            <small>
                              {media.sourceWidth && media.sourceHeight ? `${media.sourceWidth}×${media.sourceHeight}` : "Unknown source size"}
                              {" → "}
                              {media.outputWidth && media.outputHeight ? `${media.outputWidth}×${media.outputHeight}` : "Original size"}
                            </small>
                          </span>
                          <span>
                            <StatusPill value={media.renderRequired ? "transform required" : "ready as-is"} tone={media.renderRequired ? "warn" : "good"} />
                            <small>{media.outputMediaType ?? media.sourceMediaType ?? ""}{media.fit ? ` · ${media.fit}` : ""}</small>
                          </span>
                          {media.transformationFingerprint ? (
                            <details>
                              <summary>Transform identity</summary>
                              <code>{media.transformationFingerprint}</code>
                            </details>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {item.summary.title ? <h3>{item.summary.title}</h3> : null}
                  {item.summary.text ? <pre className="projection-preview-text">{item.summary.text}</pre> : null}
                  {item.summary.publicUrl ? <p className="projection-preview-link">Link: {item.summary.publicUrl}</p> : null}
                  {item.summary.scheduledAt ? <p className="projection-preview-link">Scheduled: {formatInstant(item.summary.scheduledAt)}</p> : null}
                  {item.summary.fidelity?.issues ? (
                    <details className="projection-preview-details">
                      <summary>Fidelity notes</summary>
                      <pre>{safeJson(item.summary.fidelity.issues)}</pre>
                    </details>
                  ) : null}
                  <details className="projection-preview-details">
                    <summary>Compiled payload</summary>
                    <pre>{safeJson(item.payload)}</pre>
                  </details>
                </>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function DistributionHistoryPanel({ publicationId, currentRevisionId, nonce }: { readonly publicationId: string; readonly currentRevisionId: string; readonly nonce: number }) {
  const { session } = useConnection();
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listPublicationDistributions(publicationId, {
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });
  }, [publicationId, session]);
  const collection = usePagedCollection(`publication-distributions:${publicationId}:${nonce}`, loader);

  return (
    <Panel title="Publishing history" meta="Where each revision was sent" className="publication-distribution-history">
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="distribution-history-list">
          {collection.items.map((record) => (
            <article className="distribution-history-row" key={record.id}>
              <div className="distribution-history-row__identity">
                <strong>{destinationLabel(record.destination.extensionId)}</strong>
                <small>{record.destination.connectionId} · {record.destination.channel}</small>
              </div>
              <div>
                <small>Content</small>
                <strong>{record.revisionId === currentRevisionId ? "Current revision" : "Earlier revision"}</strong>
              </div>
              <div>
                <small>Remote</small>
                {record.receipt.remote?.url ? (
                  <a href={record.receipt.remote.url} target="_blank" rel="noreferrer">
                    Open published item
                  </a>
                ) : <strong>{record.receipt.remote?.id ? "Remote recorded" : "Not created"}</strong>}
              </div>
              <div className="distribution-history-row__status">
                <StatusPill value={record.receipt.status} tone={record.receipt.status === "verified" ? "good" : record.receipt.status === "drifted" ? "warn" : "bad"} />
                <small>{formatInstant(record.recordedAt)}</small>
              </div>
              <details className="distribution-history-row__technical">
                <summary>Details</summary>
                <small>Route {record.routeId}</small>
                <small>Revision {record.revisionId}</small>
                <small>Projection {record.projectionId}</small>
              </details>
            </article>
          ))}
          {collection.items.length === 0 ? (
            <EmptyState title="No delivery history yet">Publishing this publication will record each destination result here without replacing earlier revisions.</EmptyState>
          ) : null}
        </div>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </Panel>
  );
}

export function PublicationsPage() {
  const { publicationId } = useParams();
  const navigate = useNavigate();
  const { session } = useConnection();
  const client = session!.client;
  const [statusFilter, setStatusFilter] = useState<"" | WorkspacePublicationStatus>("");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editor, setEditor] = useState<PublicationEditor | null>(null);
  const [activeEntry, setActiveEntry] = useState<PublicationWorkspaceEntry | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [pendingPublish, setPendingPublish] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [dispatchResult, setDispatchResult] = useState<PublicationWorkspaceDispatchResult | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearchQuery(searchInput.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const loader = useCallback((cursor?: string) => client.listPublications({
    limit: 30,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(searchQuery ? { search: searchQuery } : {}),
    ...(cursor ? { cursor } : {}),
  }), [client, searchQuery, statusFilter]);
  const collection = usePagedCollection(`publications:${statusFilter}:${searchQuery}:${changeNonce}`, loader);

  const selectedEntry = useMemo(
    () => publicationId ? collection.items.find((entry) => entry.publication.id === publicationId) : undefined,
    [collection.items, publicationId],
  );

  useEffect(() => {
    if (!publicationId || selectedEntry) return;
    void client.getPublication(publicationId)
      .then((entry) => {
        setActiveEntry(entry);
        setEditor(editorForEntry(entry));
        setPendingPublish(false);
        setDispatchResult(null);
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause : new Error("Publication could not be loaded"));
      });
  }, [client, publicationId, selectedEntry]);

  useEffect(() => {
    if (selectedEntry && (!editor || editor.publicationId !== selectedEntry.publication.id)) {
      setActiveEntry(selectedEntry);
      setEditor(editorForEntry(selectedEntry));
      setPendingPublish(false);
    }
  }, [editor, selectedEntry]);

  const startCreate = useCallback(() => {
    setActionError(null);
    setDispatchResult(null);
    setPendingPublish(false);
    setActiveEntry(null);
    setEditor(editorForCreate());
    navigate("/publications");
  }, [navigate]);

  const startEdit = useCallback((entry: PublicationWorkspaceEntry) => {
    setActionError(null);
    setDispatchResult(null);
    setPendingPublish(false);
    setActiveEntry(entry);
    setEditor(editorForEntry(entry));
    navigate(`/publications/${encodeURIComponent(entry.publication.id)}`);
  }, [navigate]);

  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setBusy("save");
    setActionError(null);
    setDispatchResult(null);
    setPendingPublish(false);
    try {
      if (!editor.title.trim()) throw new Error("Title is required");
      if (editor.hasUnsupportedBlocks && editor.mode === "edit") {
        throw new Error("This publication contains block types the simple editor cannot safely rewrite. Create a new publication or use a block-aware editor before changing its body.");
      }
      const common = {
        title: editor.title.trim(),
        body: editor.body,
        bodyFormat: editor.bodyFormat,
        summary: editor.summary,
        language: editor.language.trim() || "en",
        tags: listFromInput(editor.tags),
        categories: listFromInput(editor.categories),
        slug: editor.slug,
        canonicalUrl: editor.canonicalUrl,
        status: editor.status,
      } satisfies PublicationWorkspaceCreateBody;
      let saved: PublicationWorkspaceEntry;
      if (editor.mode === "create") {
        saved = await client.createPublication(common);
      } else {
        if (!editor.publicationId || editor.expectedVersion === undefined) throw new Error("Publication edit state is incomplete");
        const update: PublicationWorkspaceUpdateBody = {
          expectedVersion: editor.expectedVersion,
          ...common,
          featuredAssetId: editor.featuredAssetId || null,
        };
        saved = await client.updatePublication(editor.publicationId, update);
      }
      setActiveEntry(saved);
      setEditor(editorForEntry(saved));
      setChangeNonce((value) => value + 1);
      navigate(`/publications/${encodeURIComponent(saved.publication.id)}`, { replace: true });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Publication could not be saved");
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }, [client, editor, navigate]);

  const publish = useCallback(async () => {
    if (!editor?.publicationId || editor.expectedVersion === undefined) return;
    if (editor.hasUnsupportedBlocks) {
      setActionError(new Error("This publication contains unsupported block types. Review it with a block-aware editor before publishing."));
      return;
    }
    setPendingPublish(false);
    setBusy("publish");
    setActionError(null);
    setDispatchResult(null);
    try {
      const result = await client.publishPublication(editor.publicationId, { expectedVersion: editor.expectedVersion });
      setActiveEntry(result.publication);
      setEditor(editorForEntry(result.publication));
      setDispatchResult(result);
      setChangeNonce((value) => value + 1);
    } catch (cause) {
      const error = cause as OperatorClientError;
      setActionError(error instanceof Error ? error : new Error("Publication could not be dispatched"));
    } finally {
      setBusy(null);
    }
  }, [client, editor]);

  const canPublish = editor?.mode === "edit" && editor.status !== "archived" && !editor.hasUnsupportedBlocks;

  return (
    <>
      <PageHeader
        eyebrow="Your publishing workspace"
        title="Content"
        description="Create, import, revise, approve, and publish from one place. Blogmaatic keeps every revision and tracks where each version was sent."
        actions={(
          <div className="topbar__actions">
            <button className="button button--quiet" type="button" onClick={() => setImportOpen((current) => !current)} disabled={busy !== null}>
              {importOpen ? "Close import" : "Import from WordPress"}
            </button>
            <button className="button button--primary" type="button" onClick={startCreate} disabled={busy !== null}>New Publication</button>
          </div>
        )}
      />
      <ErrorBanner error={actionError ?? collection.error} />

      {importOpen ? <WordPressImportWorkspace onClose={() => setImportOpen(false)} /> : null}

      {dispatchResult ? (
        <div className={dispatchResult.runs.length ? "success-banner" : "warning-banner"} role="status">
          <strong>{dispatchResult.runs.length ? `Publication dispatched to ${dispatchResult.runs.length} run${dispatchResult.runs.length === 1 ? "" : "s"}.` : "Publication approved, but no enabled automation matched."}</strong>
          <span>{dispatchResult.runs.length ? <Link to="/runs">Open Runs to follow delivery.</Link> : <Link to="/automations">Review your publication.approved Automations.</Link>}</span>
        </div>
      ) : null}

      <div className="toolbar content-library-toolbar">
        <label className="field field--inline content-library-search">
          <span>Search Content</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Title, tag, slug, source, ID…"
            autoComplete="off"
          />
        </label>
        <label className="field field--inline">
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="">All publications</option>
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {searchInput || statusFilter ? (
          <button className="button button--quiet" type="button" onClick={() => { setSearchInput(""); setSearchQuery(""); setStatusFilter(""); }}>
            Clear filters
          </button>
        ) : null}
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()} disabled={collection.loading}>Refresh</button>
      </div>

      <div className={`publication-workspace ${editor ? "publication-workspace--editing" : ""}`.trim()}>
        <Panel title="Content library" meta={`${collection.items.length}${collection.nextCursor ? "+" : ""} shown`} className="publication-list-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="publication-list">
              {collection.items.map((entry) => (
                <button className="publication-row" type="button" key={entry.publication.id} onClick={() => startEdit(entry)}>
                  <span className="publication-row__identity"><strong>{entry.publication.current.content.title}</strong><small>{provenanceSource(entry)}</small></span>
                  <span><small>Status</small><StatusPill value={entry.publication.status} tone={statusTone(entry.publication.status)} /></span>
                  <span><small>Revision</small><strong>r{entry.publication.current.ordinal}</strong></span>
                  <span><small>Updated</small><strong>{formatInstant(entry.updatedAt)}</strong></span>
                </button>
              ))}
              {collection.items.length === 0 ? (
                <div className="publication-empty">
                  {searchQuery || statusFilter ? (
                    <>
                      <EmptyState title="No matching content">
                        Try a different search or status. Search checks titles, summaries, slugs, tags, source, and publication IDs across the full Content library.
                      </EmptyState>
                      <button className="button button--quiet" type="button" onClick={() => { setSearchInput(""); setSearchQuery(""); setStatusFilter(""); }}>Clear filters</button>
                    </>
                  ) : (
                    <>
                      <EmptyState title="No content yet">Create your first article here, or import an existing post from a connected WordPress destination.</EmptyState>
                      <button className="button button--primary" type="button" onClick={startCreate}>Create Publication</button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>

        {editor ? (
          <Panel title={editor.mode === "create" ? "New Publication" : editor.title || "Publication"} meta={editor.mode === "edit" ? "Publication Studio" : "Draft"} className="publication-editor">
            <form className="publication-editor__form" onSubmit={save}>
              {editor.hasUnsupportedBlocks ? (
                <div className="warning-banner" role="alert">
                  <strong>This publication contains mixed or unsupported blocks.</strong>
                  <span>The body remains read-only here so Blogmaatic does not flatten structured content. WordPress HTML imports are editable separately in HTML mode.</span>
                </div>
              ) : null}
              <label className="field"><span>Title *</span><input value={editor.title} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, title: event.target.value } : current); }} required autoComplete="off" /></label>
              <label className="field"><span>Summary</span><textarea rows={3} value={editor.summary} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, summary: event.target.value } : current); }} /></label>
              <label className="field publication-body-field">
                <span>{editor.bodyFormat === "html" ? "Body HTML" : "Body"}</span>
                <textarea
                  rows={16}
                  value={editor.body}
                  readOnly={editor.hasUnsupportedBlocks}
                  onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, body: event.target.value } : current); }}
                  placeholder={editor.bodyFormat === "html" ? "Edit the imported WordPress HTML source." : "Write the publication body. Blank lines create paragraph blocks."}
                />
                {editor.bodyFormat === "html" ? <small>This publication preserves imported WordPress HTML losslessly. Saving creates a new canonical Blogmaatic revision without flattening the markup.</small> : null}
              </label>
              <div className="publication-editor__grid">
                <label className="field"><span>Tags</span><input value={editor.tags} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, tags: event.target.value } : current); }} placeholder="news, launch, product" /></label>
                <label className="field"><span>Categories</span><input value={editor.categories} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, categories: event.target.value } : current); }} placeholder="Publishing, Tutorials" /></label>
                {editor.imageAssets.length ? (
                  <label className="field">
                    <span>Featured image</span>
                    <select value={editor.featuredAssetId} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, featuredAssetId: event.target.value } : current); }}>
                      <option value="">No featured image</option>
                      {editor.imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}
                    </select>
                    {editor.featuredAssetId ? <small>{editor.imageAssets.find((asset) => asset.id === editor.featuredAssetId)?.source}</small> : null}
                  </label>
                ) : null}
                <label className="field"><span>Language</span><input value={editor.language} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, language: event.target.value } : current); }} required /></label>
                <label className="field"><span>Slug</span><input value={editor.slug} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, slug: event.target.value } : current); }} /></label>
                <label className="field"><span>Canonical URL</span><input type="url" value={editor.canonicalUrl} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, canonicalUrl: event.target.value } : current); }} /></label>
                <label className="field"><span>Status</span><select value={editor.status} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, status: event.target.value as WorkspacePublicationStatus } : current); }}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <div className="publication-editor__actions">
                <button className="button button--quiet" type="button" onClick={() => { setActiveEntry(null); setEditor(null); setPendingPublish(false); setDispatchResult(null); navigate("/publications"); }} disabled={busy !== null}>Close</button>
                <button className="button button--primary" type="submit" disabled={busy !== null || !editor.title.trim() || editor.hasUnsupportedBlocks}>{busy === "save" ? "Saving…" : editor.mode === "create" ? "Create Draft" : "Save New Version"}</button>
                {canPublish && !pendingPublish ? <button className="button publication-publish-button" type="button" onClick={() => setPendingPublish(true)} disabled={busy !== null}>{busy === "publish" ? "Publishing…" : "Approve & Publish"}</button> : null}
              </div>
              {canPublish && pendingPublish ? (
                <div className="confirmation-strip confirmation-strip--primary" role="group" aria-label="Confirm publication approval and dispatch">
                  <strong>Approve and publish “{editor.title}”?</strong>
                  <span>This dispatches every enabled <code>publication.approved</code> Automation that matches the canonical event. The saved workspace snapshot is used for the dispatch.</span>
                  <div>
                    <button className="button button--quiet" type="button" onClick={() => setPendingPublish(false)} disabled={busy !== null}>Cancel</button>
                    <button className="button button--primary" type="button" onClick={() => void publish()} disabled={busy !== null} autoFocus>{busy === "publish" ? "Publishing…" : "Confirm publish"}</button>
                  </div>
                </div>
              ) : null}
              <p className="security-note">Saving creates an immutable workspace version. Content edits also create a new canonical Publication revision. Existing runs keep their original snapshots.</p>
            </form>
          </Panel>
        ) : null}
      </div>

      {editor?.mode === "edit" && editor.publicationId && activeEntry ? (
        <div className="publication-studio-support">
          {activeEntry.publication.provenance.extensionId === "blogmaatic.wordpress-rest" &&
          typeof activeEntry.publication.provenance.connectionId === "string" ? (
            <>
              <SourceTaxonomyPanel
                connectionId={activeEntry.publication.provenance.connectionId}
                onSelect={(kind, name) => {
                  setPendingPublish(false);
                  setEditor((current) => current ? {
                    ...current,
                    ...(kind === "category"
                      ? { categories: addListValue(current.categories, name) }
                      : { tags: addListValue(current.tags, name) }),
                  } : current);
                }}
              />
              <SourceAssetLibraryPanel
              entry={activeEntry}
              connectionId={activeEntry.publication.provenance.connectionId}
              onAttached={(next) => {
                setActiveEntry(next);
                setEditor(editorForEntry(next));
                setPendingPublish(false);
                setChangeNonce((value) => value + 1);
              }}
            />
            </>
          ) : null}
          <PublishingSummaryPanel entry={activeEntry} nonce={changeNonce} />
          <ProjectionPreviewPanel entry={activeEntry} nonce={changeNonce} />
          <VersionsPanel publicationId={editor.publicationId} nonce={changeNonce} />
          <DistributionHistoryPanel publicationId={editor.publicationId} currentRevisionId={activeEntry.publication.current.id} nonce={changeNonce} />
        </div>
      ) : null}
    </>
  );
}
