import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import type {
  OperatorClientError,
  PublicationWorkspaceCreateBody,
  PublicationWorkspaceDispatchResult,
  PublicationWorkspaceEntry,
  PublicationWorkspaceUpdateBody,
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
import { formatInstant } from "../format";
import { usePagedCollection } from "../hooks";

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
    language: entry.publication.current.content.language,
    slug: entry.publication.slug ?? "",
    canonicalUrl: entry.publication.canonicalUrl ?? "",
    status: entry.publication.status as WorkspacePublicationStatus,
    hasUnsupportedBlocks: body.unsupported,
  };
}

function tagsFromInput(value: string): readonly string[] {
  return [...new Set(value.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

function statusTone(status: string): "good" | "warn" | "bad" | "neutral" {
  if (status === "approved" || status === "published") return "good";
  if (status === "ready") return "warn";
  if (status === "archived") return "neutral";
  return "neutral";
}

function VersionsPanel({ publicationId, nonce }: { readonly publicationId: string; readonly nonce: number }) {
  const { session } = useConnection();
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    return session.client.listPublicationVersions(publicationId, { limit: 30, ...(cursor ? { cursor } : {}) });
  }, [publicationId, session]);
  const collection = usePagedCollection(`publication-versions:${publicationId}:${nonce}`, loader);

  return (
    <Panel title="Workspace history" meta="Immutable snapshots" className="publication-history">
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

function DistributionHistoryPanel({ publicationId, nonce }: { readonly publicationId: string; readonly nonce: number }) {
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
    <Panel title="Distribution history" meta="Canonical delivery evidence" className="publication-distribution-history">
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <div className="distribution-history-list">
          {collection.items.map((record) => (
            <article className="distribution-history-row" key={record.id}>
              <div className="distribution-history-row__identity">
                <strong>{record.destination.extensionId}</strong>
                <small>{record.destination.connectionId} · {record.destination.channel}</small>
              </div>
              <div>
                <small>Revision</small>
                <strong>{record.revisionId}</strong>
              </div>
              <div>
                <small>Route</small>
                <strong>{record.routeId}</strong>
              </div>
              <div>
                <small>Remote</small>
                {record.receipt.remote?.url ? (
                  <a href={record.receipt.remote.url} target="_blank" rel="noreferrer">
                    {record.receipt.remote.id}
                  </a>
                ) : <strong>{record.receipt.remote?.id ?? "Not created"}</strong>}
              </div>
              <div>
                <StatusPill value={record.receipt.status} tone={record.receipt.status === "verified" ? "good" : record.receipt.status === "drifted" ? "warn" : "bad"} />
                <small>{formatInstant(record.recordedAt)}</small>
              </div>
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
  const [editor, setEditor] = useState<PublicationEditor | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [pendingPublish, setPendingPublish] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [dispatchResult, setDispatchResult] = useState<PublicationWorkspaceDispatchResult | null>(null);
  const [changeNonce, setChangeNonce] = useState(0);

  const loader = useCallback((cursor?: string) => client.listPublications({
    limit: 30,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(cursor ? { cursor } : {}),
  }), [client, statusFilter]);
  const collection = usePagedCollection(`publications:${statusFilter}:${changeNonce}`, loader);

  const selectedEntry = useMemo(
    () => publicationId ? collection.items.find((entry) => entry.publication.id === publicationId) : undefined,
    [collection.items, publicationId],
  );

  useEffect(() => {
    if (!publicationId || selectedEntry) return;
    void client.getPublication(publicationId)
      .then((entry) => {
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
      setEditor(editorForEntry(selectedEntry));
      setPendingPublish(false);
    }
  }, [editor, selectedEntry]);

  const startCreate = useCallback(() => {
    setActionError(null);
    setDispatchResult(null);
    setPendingPublish(false);
    setEditor(editorForCreate());
    navigate("/publications");
  }, [navigate]);

  const startEdit = useCallback((entry: PublicationWorkspaceEntry) => {
    setActionError(null);
    setDispatchResult(null);
    setPendingPublish(false);
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
        tags: tagsFromInput(editor.tags),
        slug: editor.slug,
        canonicalUrl: editor.canonicalUrl,
        status: editor.status,
      } satisfies PublicationWorkspaceCreateBody;
      let saved: PublicationWorkspaceEntry;
      if (editor.mode === "create") {
        saved = await client.createPublication(common);
      } else {
        if (!editor.publicationId || editor.expectedVersion === undefined) throw new Error("Publication edit state is incomplete");
        const update: PublicationWorkspaceUpdateBody = { expectedVersion: editor.expectedVersion, ...common };
        saved = await client.updatePublication(editor.publicationId, update);
      }
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
        eyebrow="Content workspace"
        title="Publications"
        description="Create, revise, approve, and publish real content through Blogmaatic's durable automation engine. Publication IDs and revisions are server-owned; publishing dispatches the canonical approval event into enabled Automations."
        actions={<button className="button button--primary" type="button" onClick={startCreate} disabled={busy !== null}>New Publication</button>}
      />
      <ErrorBanner error={actionError ?? collection.error} />

      {dispatchResult ? (
        <div className={dispatchResult.runs.length ? "success-banner" : "warning-banner"} role="status">
          <strong>{dispatchResult.runs.length ? `Publication dispatched to ${dispatchResult.runs.length} run${dispatchResult.runs.length === 1 ? "" : "s"}.` : "Publication approved, but no enabled automation matched."}</strong>
          <span>{dispatchResult.runs.length ? <Link to="/runs">Open Runs to follow delivery.</Link> : <Link to="/automations">Review your publication.approved Automations.</Link>}</span>
        </div>
      ) : null}

      <div className="toolbar">
        <label className="field field--inline">
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="">All publications</option>
            {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button className="button button--quiet" type="button" onClick={() => void collection.reload()} disabled={collection.loading}>Refresh</button>
      </div>

      <div className={`publication-workspace ${editor ? "publication-workspace--editing" : ""}`.trim()}>
        <Panel title="Publication library" meta={`${collection.items.length}${collection.nextCursor ? "+" : ""} shown`} className="publication-list-panel">
          {collection.loading ? <LoadingBlock /> : (
            <div className="publication-list">
              {collection.items.map((entry) => (
                <button className="publication-row" type="button" key={entry.publication.id} onClick={() => startEdit(entry)}>
                  <span className="publication-row__identity"><strong>{entry.publication.current.content.title}</strong><small>{entry.publication.id}</small></span>
                  <span><small>Status</small><StatusPill value={entry.publication.status} tone={statusTone(entry.publication.status)} /></span>
                  <span><small>Revision</small><strong>r{entry.publication.current.ordinal}</strong></span>
                  <span><small>Workspace</small><strong>v{entry.version}</strong></span>
                  <span><small>Updated</small><strong>{formatInstant(entry.updatedAt)}</strong></span>
                </button>
              ))}
              {collection.items.length === 0 ? (
                <div className="publication-empty">
                  <EmptyState title="No publications yet">Create the first article here, then approve and publish it through your configured Publication Group and Automation.</EmptyState>
                  <button className="button button--primary" type="button" onClick={startCreate}>Create Publication</button>
                </div>
              ) : null}
            </div>
          )}
          <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
        </Panel>

        {editor ? (
          <Panel title={editor.mode === "create" ? "New Publication" : editor.title || "Publication"} meta={editor.mode === "edit" ? `workspace v${editor.expectedVersion}` : "Draft"} className="publication-editor">
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
                <label className="field"><span>Language</span><input value={editor.language} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, language: event.target.value } : current); }} required /></label>
                <label className="field"><span>Slug</span><input value={editor.slug} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, slug: event.target.value } : current); }} /></label>
                <label className="field"><span>Canonical URL</span><input type="url" value={editor.canonicalUrl} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, canonicalUrl: event.target.value } : current); }} /></label>
                <label className="field"><span>Status</span><select value={editor.status} onChange={(event) => { setPendingPublish(false); setEditor((current) => current ? { ...current, status: event.target.value as WorkspacePublicationStatus } : current); }}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              </div>
              <div className="publication-editor__actions">
                <button className="button button--quiet" type="button" onClick={() => { setEditor(null); setPendingPublish(false); setDispatchResult(null); navigate("/publications"); }} disabled={busy !== null}>Close</button>
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

      {editor?.mode === "edit" && editor.publicationId ? (
        <>
          <VersionsPanel publicationId={editor.publicationId} nonce={changeNonce} />
          <DistributionHistoryPanel publicationId={editor.publicationId} nonce={changeNonce} />
        </>
      ) : null}
    </>
  );
}
