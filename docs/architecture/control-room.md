# Blogmaatic Control Room

Slice 10 introduces the first operator UI without moving any domain authority into the browser.

## Boundary

```text
Control Room (React)
        |
        v
@blogmaatic/operator-client
        |
        v
Operator API
        |
   +----+----------------+
   |                     |
SQLite facts       Restate runtime truth
```

The Control Room is a client. It does not open SQLite, execute workflows, publish directly, reconstruct runtime state, or own audit history.

## Browser-safe operator client

`@blogmaatic/operator-client` is the canonical browser-safe HTTP adapter for the public Operator API. It owns:

- base URL normalization;
- authenticated request construction;
- query encoding;
- bounded API error parsing;
- automation, run, approval, schedule, operations and audit calls.

The package uses no Node-only runtime APIs and can be reused by a future Tauri shell.

## Credential posture

The browser Control Room never writes the bearer token to `localStorage`, `sessionStorage`, IndexedDB, a URL, or application configuration. The token lives only in the in-memory `OperatorClient` instance and disappears on reload or disconnect.

Theme preference may be persisted because it is not a credential.

The initial connection performs both the public health check and an authenticated automation query before the workspace is opened.

## App runtime

The web application uses React 19 and Vite. React Router provides client-side navigation. The production bundle is static and expects a same-origin Operator API boundary.

Development defaults to:

```text
Control Room  http://127.0.0.1:5173
/api/*        -> http://127.0.0.1:4317/*
```

Override the development API target without changing application code:

```bash
BLOGMAATIC_DEV_API_TARGET=http://127.0.0.1:4317 npm run dev:control-room
```

The browser-visible API prefix defaults to `/api` and may be set at build time with `VITE_BLOGMAATIC_API_BASE`.

## Surfaces

The first Control Room ships real operator surfaces only:

- Overview: first-page live attention, recent runs, enabled schedules and automation heads. A `+` count explicitly means more records exist than the visible page.
- Operations: live attention projection with server-side kind filtering and operation-level pagination.
- Approvals: current `approval_required` operations with server-validated approve/reject actions and optional notes.
- Runs: live phase filtering, dispatch filtering and terminal result inspection.
- Automations: active heads, enable/disable controls and immutable version history with explicit activation.
- Schedules: durable timezone-aware schedule inspection.
- Audit: cursor-paginated intent/outcome evidence with operator filters.

There are no generated charts, fake KPIs, sample runs, dummy schedules, fabricated health signals, or browser-owned status tables.

## Tauri boundary

Tauri is deliberately not part of this slice. The React application and `@blogmaatic/operator-client` are portable UI/client layers. A later desktop shell may provide native windowing and secure credential storage without moving publication, workflow, or control-plane business logic into Rust.
