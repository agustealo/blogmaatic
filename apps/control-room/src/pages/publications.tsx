import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  OperatorClientError,
  OperatorDistributionHistoryPage,
  PublicationDestinationMatrix,
  PublicationDestinationMatrixItem,
  PublicationGroupRegistryEntry,
  PublicationProjectionPreview,
  PublicationWorkspaceBlock,
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchResult,
  PublicationWorkspaceEntry,
  PublicationWorkspaceUpdateBody,
  SourceAssetRecord,
  SourceAuthorRecord,
  SourceContentRecord,
  SourceContentRevision,
  SourceContentTypeRecord,
  SourceMetaFieldDefinition,
  SourceMetaValuesBody,
  SourceTaxonomyDefinitionRecord,
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
import { PublicationBlockEditor } from "../publication-block-editor";
import { WordPressImportWorkspace } from "../wordpress-content-library";

type EditorMode = "create" | "edit";

interface PublicationEditor {
  readonly mode: EditorMode;
  readonly publicationId?: string;
  readonly expectedVersion?: number;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly PublicationWorkspaceBlock[];
  readonly tags: string;
  readonly categories: string;
  readonly featuredAssetId: string;
  readonly publishingTargetGroupIds: readonly string[];
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

const knownBlockKinds = new Set([
  "heading",
  "paragraph",
  "image",
  "gallery",
  "quote",
  "code",
  "embed",
  "table",
  "callout",
]);

function hasUnknownBlocks(entry: PublicationWorkspaceEntry): boolean {
  return entry.publication.current.content.blocks.some((block) => !knownBlockKinds.has(block.kind as string));
}

function editorForCreate(): PublicationEditor {
  return {
    mode: "create",
    title: "",
    summary: "",
    blocks: [{ id: "paragraph-1", kind: "paragraph", data: { text: "" } }],
    tags: "",
    categories: "",
    featuredAssetId: "",
    publishingTargetGroupIds: [],
    imageAssets: [],
    language: "en",
    slug: "",
    canonicalUrl: "",
    status: "draft",
    hasUnsupportedBlocks: false,
  };
}

function canonicalPublishingTargetGroupIds(entry: PublicationWorkspaceEntry): readonly string[] {
  const value = entry.publication.current.content.attributes.publishingTargets;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const groupIds = (value as Readonly<Record<string, unknown>>).groupIds;
  if (!Array.isArray(groupIds)) return [];
  return [...new Set(groupIds.filter((groupId): groupId is string => typeof groupId === "string" && Boolean(groupId.trim())).map((groupId) => groupId.trim()))].sort();
}

function editorForEntry(entry: PublicationWorkspaceEntry): PublicationEditor {
  return {
    mode: "edit",
    publicationId: entry.publication.id,
    expectedVersion: entry.version,
    title: entry.publication.current.content.title,
    summary: entry.publication.current.content.summary ?? "",
    blocks: entry.publication.current.content.blocks,
    tags: entry.publication.current.content.tags.join(", "),
    categories: Array.isArray(entry.publication.current.content.attributes.categories)
      ? entry.publication.current.content.attributes.categories
          .filter((value): value is string => typeof value === "string")
          .join(", ")
      : "",
    featuredAssetId: entry.publication.current.content.assets.find(
      (asset) => asset.kind === "image" && asset.attributes?.featured === true,
    )?.id ?? "",
    publishingTargetGroupIds: canonicalPublishingTargetGroupIds(entry),
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
    hasUnsupportedBlocks: hasUnknownBlocks(entry),
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

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function routeDestinationOverride(
  entry: PublicationWorkspaceEntry,
  groupId: string | undefined,
  routeId: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!groupId || !routeId) return undefined;
  const root = objectRecord(entry.publication.current.content.attributes.destinationOverrides);
  const groups = objectRecord(root?.groups);
  const group = objectRecord(groups?.[groupId]);
  const routes = objectRecord(group?.routes);
  return objectRecord(routes?.[routeId]);
}

function legacySourceRouteMatchesUi(
  entry: PublicationWorkspaceEntry,
  connectionId: string,
  groupId?: string,
  routeId?: string,
): boolean {
  if (
    entry.publication.provenance.extensionId !== "blogmaatic.wordpress-rest" ||
    entry.publication.provenance.connectionId !== connectionId
  ) {
    return false;
  }
  if (!groupId || !routeId) return true;
  const wordpress = objectRecord(entry.publication.current.content.attributes.wordpress);
  const importedGroupId = typeof wordpress?.groupId === "string" ? wordpress.groupId : undefined;
  const importedRouteId = typeof wordpress?.routeId === "string" ? wordpress.routeId : undefined;
  if (importedGroupId || importedRouteId) {
    return importedGroupId === groupId && importedRouteId === routeId;
  }
  const targets = canonicalPublishingTargetGroupIds(entry);
  return targets.length === 1 && targets[0] === groupId;
}

function canonicalSourceAuthor(
  entry: PublicationWorkspaceEntry,
  groupId?: string,
  routeId?: string,
): {
  readonly remoteId?: string;
  readonly displayName?: string;
} {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.author);
  const value = scoped ?? objectRecord(entry.publication.current.content.attributes.sourceAuthor);
  if (!value) return {};
  return {
    ...(typeof value.remoteId === "string" ? { remoteId: value.remoteId } : {}),
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
  };
}

function SourceAuthorPanel({
  entry,
  connectionId,
  groupId,
  routeId,
  onAssigned,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onAssigned: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<readonly SourceAuthorRecord[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const currentAuthor = canonicalSourceAuthor(entry, groupId, routeId);

  const load = useCallback(async (nextPage = 1, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listSourceAuthors(connectionId, {
        page: nextPage,
        limit: 30,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress authors could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, connectionId, search]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listSourceAuthors(connectionId, { page: 1, limit: 30 })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setPage(result.page);
        setHasMore(result.hasMore);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress authors could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId]);

  const assign = useCallback(async (author: SourceAuthorRecord) => {
    setBusy(author.remoteId);
    setError(null);
    try {
      const result = await client.assignSourceAuthor(connectionId, author.remoteId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
      });
      onAssigned(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress author could not be assigned"));
    } finally {
      setBusy(null);
    }
  }, [client, connectionId, entry.publication.id, entry.version, groupId, onAssigned, routeId]);

  return (
    <Panel title="WordPress author" meta="Canonical post ownership" className="source-author-panel">
      <ErrorBanner error={error} />
      <div className="source-author-current">
        <small>Current author</small>
        <strong>{currentAuthor.displayName ?? (currentAuthor.remoteId ? `WordPress user #${currentAuthor.remoteId}` : "Not explicitly assigned")}</strong>
      </div>
      <div className="source-author-toolbar">
        <label className="field">
          <span>Search authors</span>
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
            placeholder="Search WordPress authors"
          />
        </label>
        <button className="button button--quiet" type="button" onClick={() => void load(1, false)} disabled={loading}>Search</button>
      </div>
      {loading && items.length === 0 ? <LoadingBlock /> : (
        <div className="source-author-list">
          {items.map((author) => {
            const current = author.remoteId === currentAuthor.remoteId;
            return (
              <div className="source-author-row" key={author.remoteId}>
                <span className="source-author-row__identity">
                  {author.avatarUrl ? <img src={author.avatarUrl} alt="" loading="lazy" /> : <span className="source-author-row__avatar">{author.displayName.slice(0, 1).toUpperCase()}</span>}
                  <span><strong>{author.displayName}</strong><small>@{author.slug}</small></span>
                </span>
                <span className="source-author-row__actions">
                  {current ? <StatusPill value="current" tone="good" /> : null}
                  <button className="button button--quiet" type="button" onClick={() => void assign(author)} disabled={busy !== null || current}>
                    {busy === author.remoteId ? "Assigning…" : current ? "Assigned" : "Use author"}
                  </button>
                </span>
              </div>
            );
          })}
          {items.length === 0 ? <EmptyState title="No authors found">No WordPress authors match this search.</EmptyState> : null}
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

function wordpressContentType(entry: PublicationWorkspaceEntry): string | undefined {
  const value = entry.publication.current.content.attributes.wordpress;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const contentType = (value as Readonly<Record<string, unknown>>).contentType;
    return typeof contentType === "string" && contentType.trim() ? contentType : undefined;
  }
  return undefined;
}

function canonicalSourceEditorial(
  entry: PublicationWorkspaceEntry,
  connectionId: string,
  groupId?: string,
  routeId?: string,
): {
  readonly password: string;
  readonly commentStatus?: "open" | "closed";
  readonly pingStatus?: "open" | "closed";
  readonly sticky?: boolean;
  readonly format?: string;
} {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.editorial);
  const value = scoped ?? (legacySourceRouteMatchesUi(entry, connectionId, groupId, routeId)
    ? objectRecord(entry.publication.current.content.attributes.sourceEditorial)
    : undefined);
  if (value) {
    return {
      password: typeof value.password === "string" ? value.password : "",
      ...(value.commentStatus === "open" || value.commentStatus === "closed" ? { commentStatus: value.commentStatus } : {}),
      ...(value.pingStatus === "open" || value.pingStatus === "closed" ? { pingStatus: value.pingStatus } : {}),
      ...(typeof value.sticky === "boolean" ? { sticky: value.sticky } : {}),
      ...(typeof value.format === "string" ? { format: value.format } : {}),
    };
  }
  return { password: "" };
}

function sourceTypeSupports(type: SourceContentTypeRecord | null): readonly string[] {
  const value = type?.metadata.supports;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function SourceEditorialOptionsPanel({
  entry,
  connectionId,
  contentType: explicitContentType,
  groupId,
  routeId,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly contentType?: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const contentType = explicitContentType ?? wordpressContentType(entry);
  const canonical = canonicalSourceEditorial(entry, connectionId, groupId, routeId);
  const [type, setType] = useState<SourceContentTypeRecord | null>(null);
  const [password, setPassword] = useState(canonical.password);
  const [commentStatus, setCommentStatus] = useState<"open" | "closed">(canonical.commentStatus ?? "open");
  const [pingStatus, setPingStatus] = useState<"open" | "closed">(canonical.pingStatus ?? "open");
  const [sticky, setSticky] = useState(canonical.sticky ?? false);
  const [format, setFormat] = useState(canonical.format ?? "standard");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const next = canonicalSourceEditorial(entry, connectionId, groupId, routeId);
    setPassword(next.password);
    setCommentStatus(next.commentStatus ?? "open");
    setPingStatus(next.pingStatus ?? "open");
    setSticky(next.sticky ?? false);
    setFormat(next.format ?? "standard");
  }, [connectionId, entry.publication.current.id, groupId, routeId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listSourceContentTypes(connectionId)
      .then((items) => {
        if (!active) return;
        setType(contentType ? items.find((item) => item.key === contentType) ?? null : null);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress content type could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId, contentType]);

  if (!loading && (!type || !contentType)) return null;

  const supports = sourceTypeSupports(type);
  const supportsDiscussion = supports.includes("comments");
  const supportsFormats = supports.includes("post-formats");
  const wordpressTypeSlug = type?.metadata.wordpressTypeSlug;
  const supportsSticky = wordpressTypeSlug === "post";

  const save = async () => {
    if (!contentType) return;
    if (sticky && password.length > 0) {
      setError(new Error("WordPress does not allow a sticky post to be password protected."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.setSourceEditorialOptions(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        contentType,
        password,
        ...(supportsDiscussion ? { commentStatus, pingStatus } : {}),
        ...(supportsSticky ? { sticky } : {}),
        ...(supportsFormats ? { format } : {}),
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
      });
      onUpdated(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress editorial options could not be saved"));
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    password !== canonical.password ||
    (supportsDiscussion && (commentStatus !== (canonical.commentStatus ?? "open") || pingStatus !== (canonical.pingStatus ?? "open"))) ||
    (supportsSticky && sticky !== (canonical.sticky ?? false)) ||
    (supportsFormats && format !== (canonical.format ?? "standard"));

  return (
    <Panel title="WordPress editorial options" meta="Native access, discussion, and post presentation" className="source-editorial-panel">
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : (
        <div className="source-editorial-controls">
          <label className="field">
            <span>Post password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="No password"
              disabled={busy}
            />
            <small>Leave empty for public access. The password is not written to audit logs.</small>
          </label>
          {supportsDiscussion ? (
            <>
              <label className="field">
                <span>Comments</span>
                <select value={commentStatus} onChange={(event) => setCommentStatus(event.target.value as "open" | "closed")} disabled={busy}>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label className="field">
                <span>Pingbacks & trackbacks</span>
                <select value={pingStatus} onChange={(event) => setPingStatus(event.target.value as "open" | "closed")} disabled={busy}>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
            </>
          ) : null}
          {supportsFormats ? (
            <label className="field">
              <span>Post format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value)} disabled={busy}>
                {["standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio"].map((value) => (
                  <option value={value} key={value}>{value[0]?.toUpperCase()}{value.slice(1)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {supportsSticky ? (
            <label className="source-editorial-toggle">
              <input type="checkbox" checked={sticky} onChange={(event) => setSticky(event.target.checked)} disabled={busy} />
              <span><strong>Sticky post</strong><small>Keep this post pinned on the WordPress front page where the theme supports it.</small></span>
            </label>
          ) : null}
          <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save editorial options"}
          </button>
        </div>
      )}
    </Panel>
  );
}

function canonicalSourcePage(
  entry: PublicationWorkspaceEntry,
  connectionId: string,
  groupId?: string,
  routeId?: string,
): {
  readonly parentRemoteId: string | null;
  readonly template: string | null;
  readonly menuOrder: number;
} {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.pageStructure);
  const value = scoped ?? (legacySourceRouteMatchesUi(entry, connectionId, groupId, routeId)
    ? objectRecord(entry.publication.current.content.attributes.sourcePage)
    : undefined);
  if (value) {
    return {
      parentRemoteId: typeof value.parentRemoteId === "string" ? value.parentRemoteId : null,
      template: typeof value.template === "string" ? value.template : null,
      menuOrder: typeof value.menuOrder === "number" && Number.isSafeInteger(value.menuOrder) && value.menuOrder >= 0
        ? value.menuOrder
        : 0,
    };
  }
  return { parentRemoteId: null, template: null, menuOrder: 0 };
}

function SourcePageStructurePanel({
  entry,
  connectionId,
  contentType: explicitContentType,
  groupId,
  routeId,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly contentType?: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const contentType = explicitContentType ?? wordpressContentType(entry);
  const canonical = canonicalSourcePage(entry, connectionId, groupId, routeId);
  const [type, setType] = useState<SourceContentTypeRecord | null>(null);
  const [parents, setParents] = useState<readonly SourceContentRecord[]>([]);
  const [parentSearch, setParentSearch] = useState("");
  const [parentRemoteId, setParentRemoteId] = useState<string>(canonical.parentRemoteId ?? "");
  const [template, setTemplate] = useState(canonical.template ?? "");
  const [menuOrder, setMenuOrder] = useState(String(canonical.menuOrder));
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const next = canonicalSourcePage(entry, connectionId, groupId, routeId);
    setParentRemoteId(next.parentRemoteId ?? "");
    setTemplate(next.template ?? "");
    setMenuOrder(String(next.menuOrder));
  }, [connectionId, entry.publication.current.id, groupId, routeId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listSourceContentTypes(connectionId)
      .then((items) => {
        if (!active) return;
        setType(contentType ? items.find((item) => item.key === contentType) ?? null : null);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress content type could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId, contentType]);

  const searchParents = useCallback(async () => {
    if (!contentType) return;
    setSearching(true);
    setError(null);
    try {
      const page = await client.listSourceContent(connectionId, {
        contentType,
        limit: 50,
        ...(parentSearch.trim() ? { search: parentSearch.trim() } : {}),
      });
      const selfId = entry.publication.provenance.remoteId;
      setParents(page.items.filter((item) => item.remoteId !== selfId));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress parent pages could not be loaded"));
    } finally {
      setSearching(false);
    }
  }, [client, connectionId, contentType, entry.publication.provenance.remoteId, parentSearch]);

  useEffect(() => {
    if (type?.hierarchical) void searchParents();
  }, [type?.hierarchical, contentType]);

  if (!loading && (!type || !type.hierarchical || !contentType)) return null;

  const save = async () => {
    if (!contentType) return;
    const parsedOrder = Number(menuOrder);
    if (!Number.isSafeInteger(parsedOrder) || parsedOrder < 0) {
      setError(new Error("Menu order must be a non-negative integer."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.setSourcePageStructure(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        contentType,
        parentRemoteId: parentRemoteId || null,
        template: template.trim() || null,
        menuOrder: parsedOrder,
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
      });
      onUpdated(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress Page settings could not be saved"));
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    parentRemoteId !== (canonical.parentRemoteId ?? "") ||
    template !== (canonical.template ?? "") ||
    menuOrder !== String(canonical.menuOrder);

  return (
    <Panel title="WordPress Page settings" meta="Hierarchy and native page structure" className="source-page-panel">
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : (
        <div className="source-page-controls">
          <div className="source-page-parent">
            <label className="field">
              <span>Find parent page</span>
              <input
                type="search"
                value={parentSearch}
                onChange={(event) => setParentSearch(event.target.value)}
                placeholder="Search this WordPress content type"
                disabled={busy || searching}
              />
            </label>
            <button className="button button--quiet" type="button" onClick={() => void searchParents()} disabled={busy || searching}>
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
          <label className="field">
            <span>Parent</span>
            <select value={parentRemoteId} onChange={(event) => setParentRemoteId(event.target.value)} disabled={busy}>
              <option value="">No parent</option>
              {parentRemoteId && !parents.some((item) => item.remoteId === parentRemoteId)
                ? <option value={parentRemoteId}>Current parent #{parentRemoteId}</option>
                : null}
              {parents.map((item) => <option key={item.remoteId} value={item.remoteId}>{item.title || item.slug} · #{item.remoteId}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Template</span>
            <input
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              placeholder="Default template"
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Menu order</span>
            <input
              type="number"
              min="0"
              step="1"
              value={menuOrder}
              onChange={(event) => setMenuOrder(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save Page settings"}
          </button>
        </div>
      )}
    </Panel>
  );
}

type WordPressNativeStatus = "draft" | "pending" | "private" | "publish" | "future";

function canonicalSourcePublishing(
  entry: PublicationWorkspaceEntry,
  groupId?: string,
  routeId?: string,
): {
  readonly status: WordPressNativeStatus;
  readonly scheduledAt?: string;
} {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.publishing);
  const value = scoped ?? objectRecord(entry.publication.current.content.attributes.sourcePublishing);
  if (value) {
    const status = value.status;
    if (status === "draft" || status === "pending" || status === "private" || status === "publish" || status === "future") {
      return {
        status,
        ...(typeof value.scheduledAt === "string" ? { scheduledAt: value.scheduledAt } : {}),
      };
    }
  }
  return { status: "publish" };
}

function localDateTimeValue(instant: string | undefined): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function SourcePublishingStatePanel({
  entry,
  connectionId,
  groupId,
  routeId,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const canonical = canonicalSourcePublishing(entry, groupId, routeId);
  const [status, setStatus] = useState<WordPressNativeStatus>(canonical.status);
  const [scheduledLocal, setScheduledLocal] = useState(localDateTimeValue(canonical.scheduledAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const next = canonicalSourcePublishing(entry, groupId, routeId);
    setStatus(next.status);
    setScheduledLocal(localDateTimeValue(next.scheduledAt));
  }, [entry.publication.current.id, groupId, routeId]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let scheduledAt: string | undefined;
      if (status === "future") {
        if (!scheduledLocal) throw new Error("Choose a WordPress publish date and time.");
        const parsed = new Date(scheduledLocal);
        if (Number.isNaN(parsed.getTime())) throw new Error("Choose a valid WordPress publish date and time.");
        scheduledAt = parsed.toISOString();
      }
      const result = await client.setSourcePublishingState(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
        status,
        ...(scheduledAt ? { scheduledAt } : {}),
      });
      onUpdated(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress publishing state could not be saved"));
    } finally {
      setBusy(false);
    }
  }, [client, connectionId, entry.publication.id, entry.version, groupId, onUpdated, routeId, scheduledLocal, status]);

  const dirty = status !== canonical.status ||
    (status === "future" && scheduledLocal !== localDateTimeValue(canonical.scheduledAt));

  return (
    <Panel title="WordPress publishing state" meta="Separate from Blogmaatic workflow status" className="source-publishing-panel">
      <ErrorBanner error={error} />
      <div className="source-publishing-note">
        <strong>Destination-native state.</strong>
        <span>This controls the matching WordPress post only. It does not replace Blogmaatic approval or Automation schedules.</span>
      </div>
      <div className="source-publishing-controls">
        <label className="field">
          <span>WordPress post status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as WordPressNativeStatus)} disabled={busy}>
            <option value="draft">Draft</option>
            <option value="pending">Pending review</option>
            <option value="private">Private</option>
            <option value="publish">Published</option>
            <option value="future">Scheduled</option>
          </select>
        </label>
        {status === "future" ? (
          <label className="field">
            <span>Publish date & time</span>
            <input
              type="datetime-local"
              value={scheduledLocal}
              onChange={(event) => setScheduledLocal(event.target.value)}
              disabled={busy}
            />
            <small>Uses your browser's local time and stores an exact instant.</small>
          </label>
        ) : null}
        <button className="button button--primary" type="button" onClick={() => void save()} disabled={busy || !dirty || (status === "future" && !scheduledLocal)}>
          {busy ? "Saving…" : "Save WordPress state"}
        </button>
      </div>
    </Panel>
  );
}

interface WordPressTargetRoute {
  readonly groupId: string;
  readonly groupName: string;
  readonly routeId: string;
  readonly connectionId: string;
  readonly channel: string;
}

function WordPressDestinationSettings({
  entry,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [routes, setRoutes] = useState<readonly WordPressTargetRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const targetGroupIds = canonicalPublishingTargetGroupIds(entry);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all(targetGroupIds.map((groupId) => client.getPublicationGroup(groupId)))
      .then((groups) => {
        if (!active) return;
        const next: WordPressTargetRoute[] = [];
        for (const group of groups) {
          if (!group.enabled) continue;
          for (const route of group.group.routes) {
            if (!route.enabled || route.destination.extensionId !== "blogmaatic.wordpress-rest") continue;
            next.push({
              groupId: group.group.id,
              groupName: group.group.name,
              routeId: route.id,
              connectionId: route.destination.connectionId,
              channel: route.destination.channel,
            });
          }
        }
        next.sort((left, right) =>
          left.groupName.localeCompare(right.groupName) ||
          left.connectionId.localeCompare(right.connectionId) ||
          left.routeId.localeCompare(right.routeId),
        );
        setRoutes(next);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress destination settings could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, targetGroupIds.join("\u0000")]);

  if (!loading && routes.length === 0 && !error) return null;

  return (
    <div className="wordpress-destination-settings">
      <div className="wordpress-destination-settings__heading">
        <span>
          <strong>WordPress destination settings</strong>
          <small>Each selected WordPress route owns its author, publishing, taxonomy, REST meta, editorial, and page settings independently.</small>
        </span>
        <StatusPill value={loading ? "loading" : `${routes.length} route${routes.length === 1 ? "" : "s"}`} tone={routes.length ? "good" : "warn"} />
      </div>
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : null}
      {routes.map((route) => (
        <section className="wordpress-destination-route" key={`${route.groupId}:${route.routeId}`}>
          <div className="wordpress-destination-route__heading">
            <span>
              <strong>{route.groupName}</strong>
              <small>{route.connectionId} · {route.channel} · route {route.routeId}</small>
            </span>
          </div>
          <SourcePublishingStatePanel
            entry={entry}
            connectionId={route.connectionId}
            groupId={route.groupId}
            routeId={route.routeId}
            onUpdated={onUpdated}
          />
          <SourceAuthorPanel
            entry={entry}
            connectionId={route.connectionId}
            groupId={route.groupId}
            routeId={route.routeId}
            onAssigned={onUpdated}
          />
          <SourceEditorialOptionsPanel
            entry={entry}
            connectionId={route.connectionId}
            contentType={route.channel}
            groupId={route.groupId}
            routeId={route.routeId}
            onUpdated={onUpdated}
          />
          <SourcePageStructurePanel
            entry={entry}
            connectionId={route.connectionId}
            contentType={route.channel}
            groupId={route.groupId}
            routeId={route.routeId}
            onUpdated={onUpdated}
          />
          <SourceCustomTaxonomyPanel
            entry={entry}
            connectionId={route.connectionId}
            contentType={route.channel}
            groupId={route.groupId}
            routeId={route.routeId}
            onUpdated={onUpdated}
          />
          <SourceRestMetaPanel
            entry={entry}
            connectionId={route.connectionId}
            contentType={route.channel}
            groupId={route.groupId}
            routeId={route.routeId}
            onUpdated={onUpdated}
          />
        </section>
      ))}
    </div>
  );
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
  const [creating, setCreating] = useState(false);
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

  const normalizedSearch = search.trim();
  const exactMatch = normalizedSearch
    ? items.some((item) => item.name.localeCompare(normalizedSearch, undefined, { sensitivity: "accent" }) === 0)
    : true;

  const create = useCallback(async () => {
    const name = search.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const created = await client.createSourceTaxonomy(connectionId, { kind, name });
      setItems((current) => [
        created,
        ...current.filter((item) => !(item.kind === created.kind && item.remoteId === created.remoteId)),
      ]);
      onSelect(created.kind, created.name);
      setSearch(created.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress taxonomy could not be created"));
    } finally {
      setCreating(false);
    }
  }, [client, connectionId, kind, onSelect, search]);

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
          {normalizedSearch && !exactMatch ? (
            <button
              className="source-taxonomy-create"
              type="button"
              onClick={() => void create()}
              disabled={creating || loading}
            >
              <span>
                <strong>{creating ? "Creating…" : `Create & add “${normalizedSearch}”`}</strong>
                <small>Creates this {kind} in WordPress, then adds it to the current draft.</small>
              </span>
              <span>+</span>
            </button>
          ) : null}
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

function canonicalCustomTaxonomySelections(
  entry: PublicationWorkspaceEntry,
  connectionId: string,
  groupId?: string,
  routeId?: string,
): Readonly<Record<string, readonly string[]>> {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.taxonomies);
  const source = scoped ?? (legacySourceRouteMatchesUi(entry, connectionId, groupId, routeId)
    ? objectRecord(entry.publication.current.content.attributes.sourceTaxonomies)
    : undefined);
  const taxonomies = objectRecord(source?.taxonomies);
  if (!taxonomies) return {};
  const result: Record<string, readonly string[]> = {};
  for (const [taxonomyKey, value] of Object.entries(taxonomies)) {
    const record = objectRecord(value);
    const names = record?.names;
    if (!Array.isArray(names)) continue;
    result[taxonomyKey] = names.filter((name): name is string => typeof name === "string");
  }
  return result;
}

function normalizeTaxonomySelections(
  input: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, names]) => [
        key,
        [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
      ] as const)
      .filter(([, names]) => names.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function SourceCustomTaxonomyPanel({
  entry,
  connectionId,
  contentType: explicitContentType,
  groupId,
  routeId,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly contentType?: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const contentType = explicitContentType ?? wordpressContentType(entry);
  const canonical = useMemo(
    () => normalizeTaxonomySelections(canonicalCustomTaxonomySelections(entry, connectionId, groupId, routeId)),
    [connectionId, entry.publication.current.id, groupId, routeId],
  );
  const [definitions, setDefinitions] = useState<readonly SourceTaxonomyDefinitionRecord[]>([]);
  const [taxonomyKey, setTaxonomyKey] = useState("");
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>(canonical);
  const [search, setSearch] = useState("");
  const [terms, setTerms] = useState<readonly SourceTaxonomyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setSelections(canonical);
  }, [canonical]);

  useEffect(() => {
    let active = true;
    if (!contentType) {
      setDefinitions([]);
      setTaxonomyKey("");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError(null);
    void client.listSourceTaxonomyDefinitions(connectionId, contentType)
      .then((items) => {
        if (!active) return;
        const custom = items.filter((item) => item.kind === "custom");
        setDefinitions(custom);
        setTaxonomyKey((current) =>
          current && custom.some((item) => item.taxonomyKey === current)
            ? current
            : custom[0]?.taxonomyKey ?? "");
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress custom taxonomies could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId, contentType]);

  const loadTerms = useCallback(async () => {
    if (!contentType || !taxonomyKey) {
      setTerms([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const page = await client.listSourceTaxonomy(connectionId, {
        kind: "custom",
        taxonomyKey,
        contentType,
        limit: 50,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setTerms(page.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress custom taxonomy terms could not be loaded"));
    } finally {
      setSearching(false);
    }
  }, [client, connectionId, contentType, search, taxonomyKey]);

  useEffect(() => {
    void loadTerms();
  }, [taxonomyKey, contentType]);

  const add = useCallback((name: string) => {
    if (!taxonomyKey) return;
    setSelections((current) => ({
      ...current,
      [taxonomyKey]: [...new Set([...(current[taxonomyKey] ?? []), name.trim()].filter(Boolean))],
    }));
  }, [taxonomyKey]);

  const remove = useCallback((key: string, name: string) => {
    setSelections((current) => {
      const next = (current[key] ?? []).filter((candidate) => candidate !== name);
      const copy = { ...current };
      if (next.length > 0) copy[key] = next;
      else delete copy[key];
      return copy;
    });
  }, []);

  const create = useCallback(async () => {
    const name = search.trim();
    if (!name || !taxonomyKey || !contentType) return;
    setCreating(true);
    setError(null);
    try {
      const created = await client.createSourceTaxonomy(connectionId, {
        kind: "custom",
        taxonomyKey,
        contentType,
        name,
      });
      setTerms((current) => [
        created,
        ...current.filter((item) => item.remoteId !== created.remoteId),
      ]);
      add(created.name);
      setSearch(created.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress custom taxonomy term could not be created"));
    } finally {
      setCreating(false);
    }
  }, [add, client, connectionId, contentType, search, taxonomyKey]);

  const save = useCallback(async () => {
    if (!contentType) return;
    setSaving(true);
    setError(null);
    try {
      const result = await client.setSourceTaxonomySelections(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        contentType,
        selections: normalizeTaxonomySelections(selections),
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
      });
      onUpdated(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress custom taxonomy selections could not be saved"));
    } finally {
      setSaving(false);
    }
  }, [client, connectionId, contentType, entry.publication.id, entry.version, onUpdated, selections]);

  if (!loading && definitions.length === 0) return null;

  const selected = taxonomyKey ? selections[taxonomyKey] ?? [] : [];
  const normalizedSearch = search.trim();
  const exactMatch = normalizedSearch
    ? terms.some((item) => item.name.localeCompare(normalizedSearch, undefined, { sensitivity: "accent" }) === 0)
    : true;
  const dirty = JSON.stringify(normalizeTaxonomySelections(selections)) !== JSON.stringify(canonical);

  return (
    <Panel title="WordPress custom taxonomies" meta="Source-bound terms for this content type" className="source-custom-taxonomy-panel">
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : (
        <>
          <div className="source-custom-taxonomy-toolbar">
            <label className="field">
              <span>Taxonomy</span>
              <select value={taxonomyKey} onChange={(event) => setTaxonomyKey(event.target.value)} disabled={saving}>
                {definitions.map((definition) => (
                  <option key={definition.taxonomyKey} value={definition.taxonomyKey}>
                    {definition.label}{definition.hierarchical ? " · hierarchical" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Search terms</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void loadTerms();
                  }
                }}
                disabled={saving}
              />
            </label>
            <button className="button button--quiet" type="button" onClick={() => void loadTerms()} disabled={searching || saving}>
              {searching ? "Searching…" : "Search"}
            </button>
          </div>

          {selected.length > 0 ? (
            <div className="source-custom-taxonomy-selected">
              {selected.map((name) => (
                <button type="button" key={name} onClick={() => remove(taxonomyKey, name)} disabled={saving}>
                  <span>{name}</span><span>×</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="source-taxonomy-list">
            {terms.map((item) => {
              const added = selected.includes(item.name);
              return (
                <button
                  className="source-taxonomy-item"
                  type="button"
                  key={item.remoteId}
                  onClick={() => add(item.name)}
                  disabled={saving || added}
                >
                  <span><strong>{item.name}</strong><small>/{item.slug}</small></span>
                  <span>{added ? "Added" : "Add"}</span>
                </button>
              );
            })}
            {normalizedSearch && !exactMatch ? (
              <button className="source-taxonomy-create" type="button" onClick={() => void create()} disabled={creating || saving}>
                <span>
                  <strong>{creating ? "Creating…" : `Create & add “${normalizedSearch}”`}</strong>
                  <small>Creates this term in the selected WordPress taxonomy.</small>
                </span>
                <span>+</span>
              </button>
            ) : null}
          </div>

          <div className="collection-footer">
            <button className="button button--primary" type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save custom taxonomies"}
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

type SourceMetaValue = SourceMetaValuesBody["values"][string];

function canonicalSourceMetaValues(
  entry: PublicationWorkspaceEntry,
  connectionId: string,
  groupId?: string,
  routeId?: string,
): Readonly<Record<string, SourceMetaValue>> {
  const scoped = objectRecord(routeDestinationOverride(entry, groupId, routeId)?.meta);
  const source = scoped ?? (legacySourceRouteMatchesUi(entry, connectionId, groupId, routeId)
    ? objectRecord(entry.publication.current.content.attributes.sourceMeta)
    : undefined);
  const values = objectRecord(source?.values);
  return values ? values as Readonly<Record<string, SourceMetaValue>> : {};
}

function SourceRestMetaPanel({
  entry,
  connectionId,
  contentType: explicitContentType,
  groupId,
  routeId,
  onUpdated,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly contentType?: string;
  readonly groupId?: string;
  readonly routeId?: string;
  readonly onUpdated: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const contentType = explicitContentType ?? wordpressContentType(entry);
  const canonical = useMemo(
    () => canonicalSourceMetaValues(entry, connectionId, groupId, routeId),
    [connectionId, entry.publication.current.id, groupId, routeId],
  );
  const [fields, setFields] = useState<readonly SourceMetaFieldDefinition[]>([]);
  const [values, setValues] = useState<Readonly<Record<string, SourceMetaValue>>>(canonical);
  const [complexDrafts, setComplexDrafts] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setValues(canonical);
    setComplexDrafts(Object.fromEntries(
      Object.entries(canonical)
        .filter(([, value]) => Array.isArray(value) || (value !== null && typeof value === "object"))
        .map(([key, value]) => [key, JSON.stringify(value, null, 2)]),
    ));
  }, [canonical]);

  useEffect(() => {
    let active = true;
    if (!contentType) {
      setFields([]);
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError(null);
    void client.listSourceMetaFields(connectionId, contentType)
      .then((items) => {
        if (active) setFields(items);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error("WordPress REST fields could not be loaded"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, connectionId, contentType]);

  const setValue = useCallback((key: string, value: SourceMetaValue | undefined) => {
    setValues((current) => {
      const copy = { ...current };
      if (value === undefined) delete copy[key];
      else copy[key] = value;
      return copy;
    });
  }, []);

  const save = useCallback(async () => {
    if (!contentType) return;
    setSaving(true);
    setError(null);
    try {
      const next: Record<string, SourceMetaValue> = { ...values };
      for (const field of fields) {
        if (field.type !== "array" && field.type !== "object") continue;
        const raw = complexDrafts[field.key]?.trim() ?? "";
        if (!raw) {
          delete next[field.key];
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Field ${field.title ?? field.key} must contain valid JSON.`);
        }
        if (field.type === "array" && !Array.isArray(parsed)) {
          throw new Error(`Field ${field.title ?? field.key} must be a JSON array.`);
        }
        if (field.type === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
          throw new Error(`Field ${field.title ?? field.key} must be a JSON object.`);
        }
        next[field.key] = parsed as SourceMetaValue;
      }
      const result = await client.setSourceMetaValues(connectionId, {
        publicationId: entry.publication.id,
        expectedVersion: entry.version,
        contentType,
        values: next,
        ...(groupId ? { groupId } : {}),
        ...(routeId ? { routeId } : {}),
      });
      onUpdated(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress REST fields could not be saved"));
    } finally {
      setSaving(false);
    }
  }, [client, complexDrafts, connectionId, contentType, entry.publication.id, entry.version, fields, onUpdated, values]);

  if (!loading && fields.length === 0) return null;

  return (
    <Panel title="WordPress REST fields" meta="Schema-driven custom post meta" className="source-meta-panel">
      <ErrorBanner error={error} />
      <div className="source-meta-note">
        <strong>Only REST-registered fields are shown.</strong>
        <span>These values are source-bound to this WordPress content type and become part of canonical drift verification.</span>
      </div>
      {loading ? <LoadingBlock /> : (
        <div className="source-meta-grid">
          {fields.map((field) => {
            const label = field.title ?? field.key;
            const current = values[field.key];
            if (field.enum && field.enum.length > 0) {
              return (
                <label className="field" key={field.key}>
                  <span>{label}</span>
                  <select
                    value={current === undefined ? "" : JSON.stringify(current)}
                    onChange={(event) => setValue(
                      field.key,
                      event.target.value ? JSON.parse(event.target.value) as SourceMetaValue : undefined,
                    )}
                    disabled={saving}
                  >
                    <option value="">Not set</option>
                    {field.enum.map((value, index) => (
                      <option value={JSON.stringify(value)} key={`${field.key}:${index}`}>
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </option>
                    ))}
                  </select>
                  {field.description ? <small>{field.description}</small> : null}
                </label>
              );
            }
            if (field.type === "boolean") {
              return (
                <label className="source-editorial-toggle" key={field.key}>
                  <input
                    type="checkbox"
                    checked={current === true}
                    onChange={(event) => setValue(field.key, event.target.checked)}
                    disabled={saving}
                  />
                  <span><strong>{label}</strong>{field.description ? <small>{field.description}</small> : null}</span>
                </label>
              );
            }
            if (field.type === "array" || field.type === "object") {
              return (
                <label className="field source-meta-json" key={field.key}>
                  <span>{label}</span>
                  <textarea
                    value={complexDrafts[field.key] ?? ""}
                    onChange={(event) => setComplexDrafts((currentDrafts) => ({
                      ...currentDrafts,
                      [field.key]: event.target.value,
                    }))}
                    placeholder={field.type === "array" ? "[]" : "{}"}
                    disabled={saving}
                  />
                  <small>{field.description ?? `Validated JSON ${field.type}`}</small>
                </label>
              );
            }
            const numeric = field.type === "integer" || field.type === "number";
            return (
              <label className="field" key={field.key}>
                <span>{label}</span>
                <input
                  type={numeric ? "number" : "text"}
                  step={field.type === "integer" ? "1" : numeric ? "any" : undefined}
                  value={numeric
                    ? (typeof current === "number" ? String(current) : "")
                    : (typeof current === "string" ? current : "")}
                  onChange={(event) => {
                    if (!event.target.value) {
                      setValue(field.key, undefined);
                      return;
                    }
                    setValue(field.key, numeric ? Number(event.target.value) : event.target.value);
                  }}
                  disabled={saving}
                />
                {field.description ? <small>{field.description}</small> : null}
              </label>
            );
          })}
          <button className="button button--primary" type="button" onClick={() => void save()} disabled={saving || fields.length === 0}>
            {saving ? "Saving…" : "Save REST fields"}
          </button>
        </div>
      )}
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

function SourceRevisionRecoveryPanel({
  entry,
  connectionId,
  remoteId,
  onRestored,
}: {
  readonly entry: PublicationWorkspaceEntry;
  readonly connectionId: string;
  readonly remoteId: string;
  readonly onRestored: (entry: PublicationWorkspaceEntry) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [items, setItems] = useState<readonly SourceContentRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await client.listSourceContentRevisions(connectionId, remoteId));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress revisions could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, connectionId, remoteId]);

  useEffect(() => {
    void load();
  }, [load, entry.publication.current.id]);

  const restore = useCallback(async (revision: SourceContentRevision) => {
    setBusy(revision.remoteRevisionId);
    setError(null);
    try {
      const result = await client.restoreSourceContentRevision(
        connectionId,
        remoteId,
        revision.remoteRevisionId,
        {
          publicationId: entry.publication.id,
          expectedVersion: entry.version,
        },
      );
      onRestored(result.publication);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("WordPress revision could not be restored"));
    } finally {
      setBusy(null);
    }
  }, [client, connectionId, entry.publication.id, entry.version, onRestored, remoteId]);

  return (
    <Panel title="WordPress revisions" meta="Recover remote history into canonical content" className="source-revision-panel">
      <ErrorBanner error={error} />
      <div className="source-revision-note">
        <strong>Recovery creates a new Blogmaatic revision.</strong>
        <span>WordPress is not rewritten until you explicitly publish the recovered canonical content.</span>
      </div>
      {loading ? <LoadingBlock /> : (
        <div className="source-revision-list">
          {items.map((revision) => {
            const authorId = revision.metadata.authorId;
            return (
              <article className="source-revision-row" key={revision.remoteRevisionId}>
                <div className="source-revision-row__content">
                  <strong>{revision.title || `WordPress revision #${revision.remoteRevisionId}`}</strong>
                  <small>
                    {revision.modifiedAt || revision.createdAt
                      ? formatInstant(revision.modifiedAt ?? revision.createdAt ?? "")
                      : "Timestamp unavailable"}
                    {typeof authorId === "number" ? ` · author #${authorId}` : ""}
                  </small>
                  {revision.excerpt ? <p>{revision.excerpt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}</p> : null}
                </div>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => void restore(revision)}
                  disabled={busy !== null}
                >
                  {busy === revision.remoteRevisionId ? "Restoring…" : "Restore into Blogmaatic"}
                </button>
              </article>
            );
          })}
          {items.length === 0 ? <EmptyState title="No WordPress revisions">This remote post has no native revisions available.</EmptyState> : null}
        </div>
      )}
      <div className="collection-footer">
        <button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>Refresh revisions</button>
      </div>
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

function destinationMatrixTone(state: PublicationDestinationMatrixItem["state"]): "good" | "warn" | "bad" {
  if (state === "current") return "good";
  if (state === "not_sent" || state === "update_available") return "warn";
  return "bad";
}

function destinationMatrixLabel(state: PublicationDestinationMatrixItem["state"]): string {
  switch (state) {
    case "not_sent": return "Not sent";
    case "current": return "Current";
    case "update_available": return "Update available";
    case "drifted": return "Drifted";
    case "failed": return "Needs attention";
  }
}

function PublishingTargetsField({
  selected,
  onChange,
}: {
  readonly selected: readonly string[];
  readonly onChange: (groupIds: readonly string[]) => void;
}) {
  const { session } = useConnection();
  const client = session!.client;
  const [groups, setGroups] = useState<readonly PublicationGroupRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const items: PublicationGroupRegistryEntry[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listPublicationGroups({
            enabled: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          items.push(...page.items.filter((entry) => entry.group.routes.some((route) => route.enabled)));
          cursor = page.nextCursor;
        } while (cursor);
        if (active) setGroups(items);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error("Publishing targets could not be loaded"));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [client]);

  const availableIds = useMemo(() => new Set(groups.map((entry) => entry.group.id)), [groups]);
  const unavailable = selected.filter((groupId) => !availableIds.has(groupId));

  return (
    <div className="publication-targets-field">
      <div className="publication-targets-field__heading">
        <span>
          <strong>Publishing targets</strong>
          <small>Choose exactly which Publication Groups may receive this publication. No target means publishing is blocked.</small>
        </span>
        <StatusPill value={selected.length ? `${selected.length} selected` : "none selected"} tone={selected.length ? "good" : "warn"} />
      </div>
      <ErrorBanner error={error} />
      {loading ? <LoadingBlock /> : null}
      {!loading && groups.length === 0 ? (
        <EmptyState title="No enabled Publication Groups">Create or enable a Publishing route before this publication can be dispatched.</EmptyState>
      ) : null}
      {!loading && groups.length ? (
        <div className="publication-targets-list">
          {groups.map((entry) => {
            const checked = selected.includes(entry.group.id);
            const enabledRoutes = entry.group.routes.filter((route) => route.enabled);
            return (
              <label className="publication-target-option" key={entry.group.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selected, entry.group.id]
                      : selected.filter((groupId) => groupId !== entry.group.id);
                    onChange([...new Set(next)].sort());
                  }}
                />
                <span>
                  <strong>{entry.group.name}</strong>
                  <small>{enabledRoutes.length} enabled route{enabledRoutes.length === 1 ? "" : "s"} · {enabledRoutes.map((route) => `${destinationLabel(route.destination.extensionId)} / ${route.destination.connectionId} / ${route.destination.channel}`).join(" · ")}</small>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      {unavailable.length ? (
        <div className="warning-banner" role="alert">
          <strong>{unavailable.length} saved target{unavailable.length === 1 ? " is" : "s are"} unavailable.</strong>
          <span>{unavailable.join(", ")}. Remove or re-enable these targets before publishing.</span>
        </div>
      ) : null}
    </div>
  );
}

function PublishingSummaryPanel({ entry, nonce }: { readonly entry: PublicationWorkspaceEntry; readonly nonce: number }) {
  const { session } = useConnection();
  const client = session!.client;
  const [matrix, setMatrix] = useState<PublicationDestinationMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMatrix(await client.getPublicationDestinations(entry.publication.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Destination state could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [client, entry.publication.id]);

  useEffect(() => {
    void load();
  }, [load, entry.publication.current.id, nonce]);

  const counts = useMemo(() => {
    const summary = { current: 0, update: 0, unsent: 0, attention: 0 };
    for (const item of matrix?.items ?? []) {
      if (item.state === "current") summary.current += 1;
      else if (item.state === "update_available") summary.update += 1;
      else if (item.state === "not_sent") summary.unsent += 1;
      else summary.attention += 1;
    }
    return summary;
  }, [matrix]);

  return (
    <Panel title="Publishing" meta="Destination matrix for the current canonical revision" className="publication-publishing-panel">
      <ErrorBanner error={error} />
      <div className="publication-publishing-summary">
        <div>
          <small>Workflow</small>
          <StatusPill value={entry.publication.status} tone={statusTone(entry.publication.status)} />
        </div>
        <div>
          <small>Current revision</small>
          <strong>r{entry.publication.current.ordinal}</strong>
        </div>
        <div>
          <small>Destinations</small>
          <strong>{loading ? "…" : matrix?.items.length ?? 0}</strong>
        </div>
        <div>
          <small>Current</small>
          <strong>{loading ? "…" : counts.current}</strong>
        </div>
      </div>

      {loading ? <LoadingBlock /> : null}
      {!loading && matrix && matrix.items.length ? (
        <>
          {(counts.update || counts.unsent || counts.attention) ? (
            <div className="publication-destination-alerts">
              {counts.update ? <span><strong>{counts.update}</strong> update available</span> : null}
              {counts.unsent ? <span><strong>{counts.unsent}</strong> not sent</span> : null}
              {counts.attention ? <span className="publication-destination-alerts__bad"><strong>{counts.attention}</strong> need attention</span> : null}
            </div>
          ) : null}
          <div className="publication-destination-matrix">
            {matrix.items.map((item) => (
              <article className="publication-destination-matrix__row" key={item.key}>
                <div className="publication-destination-matrix__identity">
                  <strong>{item.destination.extensionName}</strong>
                  <small>{item.destination.connectionName} · {item.destination.channel}</small>
                  <small>{item.groupName} · route {item.routeId}</small>
                </div>
                <div className="publication-destination-matrix__state">
                  <StatusPill value={destinationMatrixLabel(item.state)} tone={destinationMatrixTone(item.state)} />
                  <small>
                    {item.latestRevisionId
                      ? item.latestRevisionId === matrix.currentRevisionId
                        ? `r${matrix.currentRevisionOrdinal} delivered`
                        : "Earlier revision delivered"
                      : "No delivery yet"}
                  </small>
                </div>
                <div className="publication-destination-matrix__compile">
                  <small>Current payload</small>
                  <StatusPill
                    value={item.preview.status === "ready" ? "Compiles" : "Cannot compile"}
                    tone={item.preview.status === "ready" ? "good" : "bad"}
                  />
                  {item.preview.status === "error" ? <small title={item.preview.error}>{item.preview.error}</small> : null}
                </div>
                <div className="publication-destination-matrix__remote">
                  <small>Remote</small>
                  {item.remote?.url ? (
                    <a href={item.remote.url} target="_blank" rel="noreferrer">Open published item</a>
                  ) : item.remote?.id ? <strong>{item.remote.id}</strong> : <span>Not created</span>}
                  <small>{item.deliveryCount} deliver{item.deliveryCount === 1 ? "y" : "ies"}</small>
                </div>
                <div className="publication-destination-matrix__when">
                  <small>Latest evidence</small>
                  <strong>{item.latestRecordedAt ? formatInstant(item.latestRecordedAt) : "—"}</strong>
                  {item.latestReceiptStatus ? <small>{item.latestReceiptStatus}</small> : null}
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}
      {!loading && matrix && matrix.items.length === 0 ? (
        <div className="publication-publishing-empty">
          <span>No enabled publishing routes are configured. Add or enable a Publication Group destination to distribute this content.</span>
        </div>
      ) : null}

      <div className="publication-publishing-actions">
        <button className="button button--quiet" type="button" onClick={() => void load()} disabled={loading}>Refresh destinations</button>
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
          {matrix ? <div><dt>Matrix generated</dt><dd>{formatInstant(matrix.generatedAt)}</dd></div> : null}
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
        throw new Error("This publication contains future block types this Studio version cannot safely rewrite.");
      }
      const common = {
        title: editor.title.trim(),
        blocks: editor.blocks,
        summary: editor.summary,
        language: editor.language.trim() || "en",
        tags: listFromInput(editor.tags),
        categories: listFromInput(editor.categories),
        publishingTargetGroupIds: editor.publishingTargetGroupIds,
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

  const savedTargetIds = activeEntry ? canonicalPublishingTargetGroupIds(activeEntry) : [];
  const targetSelectionSaved = editor?.mode === "edit" &&
    JSON.stringify([...editor.publishingTargetGroupIds].sort()) === JSON.stringify([...savedTargetIds].sort());
  const canPublish = editor?.mode === "edit" &&
    editor.status !== "archived" &&
    !editor.hasUnsupportedBlocks &&
    editor.publishingTargetGroupIds.length > 0 &&
    targetSelectionSaved;

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
                  <strong>This publication contains a future block type this Studio version does not understand.</strong>
                  <span>The canonical revision remains readable and preserved. Saving body changes is blocked until this Studio understands every block kind.</span>
                </div>
              ) : null}
              <label className="field"><span>Title *</span><input value={editor.title} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, title: event.target.value } : current); }} required autoComplete="off" /></label>
              <label className="field"><span>Summary</span><textarea rows={3} value={editor.summary} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, summary: event.target.value } : current); }} /></label>
              <PublicationBlockEditor
                blocks={editor.blocks}
                imageAssets={editor.imageAssets}
                disabled={busy !== null || editor.hasUnsupportedBlocks}
                onChange={(blocks) => {
                  setPendingPublish(false);
                  setEditor((current) => current ? { ...current, blocks } : current);
                }}
              />
              <PublishingTargetsField
                selected={editor.publishingTargetGroupIds}
                onChange={(groupIds) => {
                  setPendingPublish(false);
                  setEditor((current) => current ? { ...current, publishingTargetGroupIds: groupIds } : current);
                }}
              />
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
                {editor.mode === "edit" && editor.publishingTargetGroupIds.length === 0 ? <small className="publication-publish-lock">Select and save at least one publishing target.</small> : null}
                {editor.mode === "edit" && editor.publishingTargetGroupIds.length > 0 && !targetSelectionSaved ? <small className="publication-publish-lock">Save target changes before publishing.</small> : null}
              </div>
              {canPublish && pendingPublish ? (
                <div className="confirmation-strip confirmation-strip--primary" role="group" aria-label="Confirm publication approval and dispatch">
                  <strong>Approve and publish “{editor.title}”?</strong>
                  <span>This dispatches only the {editor.publishingTargetGroupIds.length} saved Publication Group target{editor.publishingTargetGroupIds.length === 1 ? "" : "s"}. Matching <code>publication.approved</code> Automations receive only those selected groups.</span>
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
          <WordPressDestinationSettings
            entry={activeEntry}
            onUpdated={(next) => {
              setActiveEntry(next);
              setEditor(editorForEntry(next));
              setPendingPublish(false);
              setChangeNonce((value) => value + 1);
            }}
          />
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
              
              
              {typeof activeEntry.publication.provenance.remoteId === "string" ? (
                <SourceRevisionRecoveryPanel
                  entry={activeEntry}
                  connectionId={activeEntry.publication.provenance.connectionId}
                  remoteId={activeEntry.publication.provenance.remoteId}
                  onRestored={(next) => {
                    setActiveEntry(next);
                    setEditor(editorForEntry(next));
                    setPendingPublish(false);
                    setChangeNonce((value) => value + 1);
                  }}
                />
              ) : null}
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
