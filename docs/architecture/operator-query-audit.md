# Operator Query Surface and Audit Ledger

Slice 9 makes the Blogmaatic control plane observable without creating a second source of truth.

## Authority boundaries

The control-plane store owns durable facts:

- automation definitions and active heads
- run identities and immutable run requests
- dispatch state and cached runtime phase
- schedules and leases
- append-only audit evidence

The durable automation runtime owns current workflow execution truth. `runtimePhase` stored in SQLite is a cache only. Operator queries that promise current phase semantics refresh the durable runtime before filtering.

The Operator API owns authentication, authorization, request validation, public query semantics, and audit actor identity. A future Control Room UI must consume these APIs instead of querying SQLite directly.

## Query model

Collection routes use keyset pagination with opaque, resource-scoped cursors. Clients must treat cursor values as implementation details and only return a cursor to the same resource family from which it was issued.

Current list surfaces:

- automation heads
- automation version history
- runs
- schedules
- operations requiring operator attention
- audit evidence

Run and schedule filters are applied by their canonical authorities. `GET /v1/runs?runtimePhase=...` is special: it refreshes current runtime status before deciding whether a run matches rather than trusting the cached SQLite phase.

## Operations projection

`GET /v1/operations` is a live projection, not another durable status table.

It combines:

1. stored run identity and immutable request snapshots;
2. current durable runtime status;
3. terminal workflow results and delivery receipts.

It currently surfaces:

- approval required
- launch failed
- run stopped
- run rejected
- delivery blocked
- delivery awaiting approval
- delivery drifted
- delivery unreachable

Operations have their own cursor. Pagination applies to the resulting operation stream, including multiple operations originating from one run. It does not paginate source runs and then expand them afterward.

## Audit ledger

The audit ledger is append-only operational evidence. It is not a cryptographic transparency log and must not be described as tamper-proof.

A mutating authenticated request records:

```text
intent
  ↓
execute
  ├─ success          → succeeded
  ├─ business failure → failed
  └─ process / ledger interruption
                       → intent-only
```

An intent-only correlation means that outcome evidence is incomplete or unknown. It does not mean the business operation failed.

The success-ledger write intentionally occurs outside the business execution catch. If the side effect succeeds and the success evidence cannot be written, Blogmaatic leaves the correlation intent-only rather than fabricating a failed business outcome. If the business operation fails and writing its failure evidence also fails, the original business error remains authoritative.

Each ledger record contains:

- correlation ID
- phase (`intent`, `succeeded`, `failed`)
- authenticated actor ID and actor kind
- action
- resource type and resource ID
- API request ID when applicable
- run ID when applicable
- bounded JSON evidence
- occurrence time

Bearer credentials and raw internal exception messages are never audit evidence.

External event audit resource identities are source-scoped (`<source>/<producer-event-id>`) so two providers may safely reuse producer-local IDs.

## Time authority

Persisted control-plane instants are canonical fixed-width UTC strings:

```text
YYYY-MM-DDTHH:mm:ss.SSSZ
```

For example:

```text
2026-09-22T23:00:00.000Z
2026-09-22T23:00:00.100Z
2026-09-22T23:00:00.120Z
```

This matters because SQLite range and keyset predicates compare these columns as `TEXT`. Fixed-width UTC representation keeps lexical and chronological ordering aligned.

Local scheduling still preserves user wall-clock time and IANA timezone behavior. Fixed-width UTC applies to the persisted instant after timezone resolution.

## Failure posture

- invalid cursors and malformed query filters are client errors;
- runtime-dependent live queries fail closed if the durable runtime is unavailable;
- cached runtime phase is never presented as current truth by the live operator filter;
- audit writes do not replace the original business error;
- query APIs never bypass the canonical store or runtime to manufacture status.

## Future Control Room contract

The Control Room should remain a thin operator client over these surfaces:

```text
Control Room
    │
    ├── automations
    ├── runs
    ├── schedules
    ├── operations
    └── audit
          │
          ▼
     Operator API
          │
    ┌─────┴─────────┐
    ▼               ▼
Control-plane     Durable
SQLite facts      runtime truth
```

No UI component should open the control-plane SQLite database directly or introduce a competing aggregation authority.
