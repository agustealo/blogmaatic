import type { PropsWithChildren, ReactNode } from "react";
import { Link } from "react-router";

import type { OperatorOperation } from "@blogmaatic/operator-client";

import { formatInstant, humanize, operationTitle } from "./format";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({ title, meta, children, className = "" }: PropsWithChildren<{
  readonly title?: string;
  readonly meta?: ReactNode;
  readonly className?: string;
}>) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title || meta ? (
        <header className="panel__header">
          {title ? <h2>{title}</h2> : <span />}
          {meta ? <div className="panel__meta">{meta}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function StatusPill({ value, tone }: { readonly value: string; readonly tone?: "good" | "warn" | "bad" | "neutral" }) {
  const inferred = tone ?? (
    value.includes("failed") || value.includes("unreachable") || value === "stopped" ? "bad" :
      value.includes("waiting") || value.includes("drift") || value === "rejected" ? "warn" :
        value === "completed" || value === "verified" || value === "started" || value === "enabled" ? "good" : "neutral"
  );
  return <span className={`status-pill status-pill--${inferred}`}>{humanize(value)}</span>;
}

export function ErrorBanner({ error }: { readonly error: Error | null }) {
  if (!error) return null;
  return <div className="error-banner" role="alert">{error.message}</div>;
}

export function EmptyState({ title, children }: PropsWithChildren<{ readonly title: string }>) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function LoadingBlock() {
  return <div className="loading-block" aria-label="Loading"><span /><span /><span /></div>;
}

export function CollectionFooter({
  hasMore,
  busy,
  onLoadMore,
}: {
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="collection-footer">
      <button className="button button--quiet" type="button" onClick={onLoadMore} disabled={busy}>
        {busy ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

export function Metric({ label, value, note }: { readonly label: string; readonly value: string; readonly note: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

export function OperationCard({ operation, compact = false }: { readonly operation: OperatorOperation; readonly compact?: boolean }) {
  return (
    <article className={`operation-card operation-card--${operation.severity} ${compact ? "operation-card--compact" : ""}`.trim()}>
      <div className="operation-card__signal" aria-hidden="true" />
      <div className="operation-card__body">
        <div className="operation-card__topline">
          <strong>{operationTitle(operation)}</strong>
          <time dateTime={operation.occurredAt}>{formatInstant(operation.occurredAt)}</time>
        </div>
        <p>{operation.detail ?? `${operation.automationId} · ${operation.publicationId}`}</p>
        <div className="operation-card__meta">
          <span>{operation.automationId} v{operation.automationVersion}</span>
          {operation.routeId ? <span>Route {operation.routeId}</span> : null}
          <Link to={`/runs/${encodeURIComponent(operation.runId)}`}>Open run</Link>
        </div>
      </div>
    </article>
  );
}
