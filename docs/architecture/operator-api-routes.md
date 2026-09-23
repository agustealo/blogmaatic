# Operator API Route Contract

All `/v1/*` routes require a bearer credential with the documented permission. `GET /healthz` is the only public route.

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | public | liveness |
| GET | `/v1/automations` | `automations:read` | list active automation heads with cursor pagination |
| POST | `/v1/automations` | `automations:write` | register immutable automation version |
| GET | `/v1/automations/:automationId` | `automations:read` | read active automation head |
| GET | `/v1/automations/:automationId/versions` | `automations:read` | list exact version history with cursor pagination |
| GET | `/v1/automations/:automationId/versions/:version` | `automations:read` | read exact version |
| POST | `/v1/automations/:automationId/versions/:version/activate` | `automations:write` | activate/enable exact version |
| POST | `/v1/events` | `events:ingest` | route source-scoped external event |
| GET | `/v1/runs` | `runs:read` | list/filter durable runs; runtime-phase filtering refreshes live runtime truth |
| POST | `/v1/runs/manual` | `runs:write` | idempotent manual trigger |
| GET | `/v1/runs/:runId` | `runs:read` | inspect dispatch/runtime phase |
| POST | `/v1/runs/:runId/approvals` | `approvals:write` + expected role | submit revision-bound decision |
| GET | `/v1/runs/:runId/result` | `runs:read` | retrieve terminal workflow result |
| GET | `/v1/schedules` | `schedules:read` | list/filter schedules with cursor pagination |
| POST | `/v1/schedules` | `schedules:write` | create or safely replace exact-version/revision schedule |
| GET | `/v1/schedules/:scheduleId` | `schedules:read` | inspect schedule |
| POST | `/v1/scheduler/dispatch` | `schedules:dispatch` | claim and dispatch currently due fires |
| GET | `/v1/operations` | `operations:read` | live paginated operator-attention projection |
| GET | `/v1/audit` | `audit:read` | query append-only audit evidence |

Collection routes use opaque, resource-scoped keyset cursors. A cursor from one resource family is not valid for another. Invalid cursors and malformed query filters return `400 INVALID_REQUEST`.

`GET /v1/runs?runtimePhase=...` does not trust the cached SQLite phase. It refreshes current durable-runtime status before filtering. `/v1/operations` likewise combines stored run identity with current runtime status and terminal delivery results; it does not create a second durable status authority.

Manual triggering requires `Idempotency-Key`. The server owns `initiatedBy` and `occurredAt`.

Approval requests contain only `decision` and optional `note`. The server owns reviewer identity, expected role, expected step, revision, and decision time.

Event requests may contain producer event metadata, publication and groups, but event source authority always comes from the authenticated integration credential. Audit resource identity for an external event is source-scoped so producer-local IDs do not collide across integrations.

Mutating authenticated routes append an audit `intent` before execution and a `succeeded` or `failed` outcome afterward. An intent without an outcome means outcome evidence is incomplete or unknown; it must not be interpreted as a failed business operation.
