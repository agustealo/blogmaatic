# Blogmaatic Control Room

The Control Room is Blogmaatic's consumer and operator surface. It remains a client of the canonical runtime authorities rather than becoming a second implementation of connection, automation, Publication Group, run, or audit state.

## Product view

![Blogmaatic Control Room overview](../screenshots/04-control-room-overview.png)

The canonical screenshot gallery is generated from the real runtime and is documented in [`docs/screenshots/README.md`](../screenshots/README.md). The capture harness does not render mock API responses or browser-owned demo state.

## Boundary

```text
Browser Control Room
        |
        | HttpOnly runtime cookie
        | + origin-bound session proof
        v
same-origin /api proxy
        |
        | server injects Operator bearer
        v
Operator API
        |
   +----+----------------+
   |                     |
SQLite facts       Restate runtime truth
```

The Control Room does not open SQLite, execute workflows, publish directly, reconstruct durable runtime state, own connection truth, or own audit history.

## Browser-safe operator client

`@blogmaatic/operator-client` is the canonical browser-safe HTTP adapter for the Operator API. It owns:

- base URL normalization;
- same-origin session-proof request construction;
- query encoding;
- bounded API error parsing;
- connection management and health calls;
- Publication Group lifecycle and policy-option calls;
- automation, run, approval, schedule, operations and audit calls.

The package uses browser/ECMAScript type libraries rather than Node globals and remains portable to a future desktop shell.

## Credential posture

The normal bundled browser flow never receives the Operator API bearer credential.

`blogmaatic start` emits a one-time Control Room launch capability. Opening it causes the local runtime to issue:

1. a host-scoped runtime session cookie with `HttpOnly` and `SameSite=Strict`;
2. an independent origin-bound session proof delivered in the launch redirect fragment;
3. a same-origin Control Room session in which browser requests target `/api`.

The Control Room stores only the origin-bound proof in `sessionStorage` for the lifetime of that browser tab/session. The bearer remains server-side and is injected by the local `/api` proxy only after both the cookie and proof validate.

The browser therefore does **not** write the bearer to `localStorage`, `sessionStorage`, IndexedDB, a URL, JavaScript configuration, or application state. Browser-supplied `Authorization` is ignored/replaced by the trusted local proxy boundary.

Public `/api/healthz` remains public and does not require operator authority. Authenticated Control Room resources fail closed without the complete local browser session.

Theme preference may be persisted because it is not credential material.

## First-run authority

![Blogmaatic first-run setup](../screenshots/01-first-run-setup.png)

First-run completion is derived from actual runtime state rather than a browser flag.

The guided path is:

```text
Welcome / readiness
      ↓
Destination connection
      ↓
validation + live health
      ↓
Publication Group
      ↓
Automation
      ↓
Ready / normal Control Room
```

A live successful destination probe is required before the first enabled Publication Group is created. Once the durable connection → group → automation chain exists, normal Control Room navigation uses structural readiness and does not depend on third-party health. A temporary WordPress, LinkedIn, Facebook, or other remote outage therefore cannot lock an already-configured operator back into onboarding.

## Connections

![Blogmaatic Connections](../screenshots/03-connections.png)

Connections are managed through the runtime `ConnectionManager`, not browser-local state.

The UI is driven by extension-owned connection contracts, including settings fields, secret fields, validation rules, and default publication routes. Secret values are write-only from the browser. The runtime stores managed credentials in the operating system vault and returns only the names of configured secret fields.

Connection disable and removal fail closed when the destination is still referenced by an enabled Publication Group route.

## App runtime

The web application uses React 19 and Vite. React Router provides client-side navigation. The production bundle is served by the local runtime and uses the same-origin `/api` proxy.

Development defaults to:

```text
Control Room  http://127.0.0.1:5173
/api/*        -> http://127.0.0.1:4317/*
```

The Vite development proxy reads the local operator credential server-side from the runtime data directory and injects it into proxied requests. Development fails closed if the credential is unavailable.

A production static server must provide SPA fallback to `index.html` for routes such as `/runs/:runId` and `/automations/:automationId`.

## Surfaces

The Control Room exposes real operator surfaces only:

- **Overview**: live attention, recent runs, enabled schedules and automation heads.
- **Connections**: extension-driven destination creation, edit, disable, removal, validation and health.
- **Operations**: live attention projection with server-side kind filtering and operation-level pagination.
- **Approvals**: current `approval_required` operations with server-validated approve/reject actions and optional notes.
- **Runs**: live phase filtering, dispatch filtering and terminal result inspection.
- **Run detail**: durable execution phase, step outcomes, receipts, delivery and verification evidence.
- **Automations**: active heads, enable/disable controls and immutable version history with explicit activation.
- **Schedules**: durable timezone-aware schedule inspection.
- **Audit**: cursor-paginated intent/outcome evidence with operator filters.
- **Setup**: derived first-run state that writes through the same connection, Publication Group and automation authorities used by normal operation.

![Blogmaatic automation management](../screenshots/05-automations.png)

![Blogmaatic durable run detail](../screenshots/07-run-detail.png)

Collection refresh and load-more requests are serialized through one request-generation authority so stale pagination responses cannot overwrite a newer filter or refresh.

There are no generated charts, fake KPIs, sample runs, dummy schedules, fabricated health signals, or browser-owned status tables in the product path.

## Mutation interaction contract

Read and navigation surfaces remain immediate. High-impact operator mutations are intentionally explicit interactions:

1. the operator selects approve/reject, enable/disable, version activation, or another controlled mutation;
2. the UI exposes the exact pending decision when confirmation is required;
3. only the confirmed action reaches the Operator API;
4. the server revalidates permissions, expected version/revision, references and durable state;
5. the audit authority records intent and outcome without leaking secret values or vault locators.

Browser confirmation is an ergonomics/safety guard, not authorization and not a replacement for server validation or the audit ledger.

## Product-media contract

Canonical screenshots are produced by `scripts/capture-product-screenshots.mjs` through `npm run product:screenshots`.

The capture process boots real app data, uses the actual local session bootstrap, performs a real durable Jekyll publication, and captures a fixed 1600×1000 CSS-pixel desktop viewport at 1.5 device scale. `docs/screenshots/capture-manifest.json` records the capture provenance.

Generated concept art may illustrate future ideas, but it must never replace a real product screenshot in README, feature documentation, release evidence, or consumer-facing claims about implemented UI.
