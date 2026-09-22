# Operator API Route Contract

All `/v1/*` routes require a bearer credential with the documented permission. `GET /healthz` is the only public route.

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | public | liveness |
| POST | `/v1/automations` | `automations:write` | register immutable automation version |
| GET | `/v1/automations/:automationId` | `automations:read` | read active automation head |
| GET | `/v1/automations/:automationId/versions/:version` | `automations:read` | read exact version |
| POST | `/v1/automations/:automationId/versions/:version/activate` | `automations:write` | activate/enable exact version |
| POST | `/v1/events` | `events:ingest` | route source-scoped external event |
| POST | `/v1/runs/manual` | `runs:write` | idempotent manual trigger |
| GET | `/v1/runs/:runId` | `runs:read` | inspect dispatch/runtime phase |
| POST | `/v1/runs/:runId/approvals` | `approvals:write` + expected role | submit revision-bound decision |
| GET | `/v1/runs/:runId/result` | `runs:read` | retrieve terminal workflow result |
| POST | `/v1/schedules` | `schedules:write` | create exact-version/revision schedule |
| GET | `/v1/schedules/:scheduleId` | `schedules:read` | inspect schedule |
| POST | `/v1/scheduler/dispatch` | `schedules:dispatch` | claim and dispatch currently due fires |

Manual triggering requires `Idempotency-Key`. The server owns `initiatedBy` and `occurredAt`.

Approval requests contain only `decision` and optional `note`. The server owns reviewer identity, expected role, expected step, revision, and decision time.

Event requests may contain producer event metadata, publication and groups, but event source authority always comes from the authenticated integration credential.
