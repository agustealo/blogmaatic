# @blogmaatic/operator-api

Authenticated Fastify 5 adapter over Blogmaatic's canonical control plane and durable automation runtime.

The package intentionally contains no publication repository, scheduler, workflow engine, or provider logic. It exposes both command routes and the canonical query surfaces used by future operator clients.

```ts
import { RestateAutomationLauncher } from "@blogmaatic/automation-restate";
import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { StaticBearerAuthorizer, startOperatorApi } from "@blogmaatic/operator-api";

const store = new SqliteControlPlaneStore("./blogmaatic.sqlite");
const runtime = new RestateAutomationLauncher({ url: "http://127.0.0.1:8080" });
const controlPlane = new AutomationControlPlane({ store, launcher: runtime });
const authorizer = new StaticBearerAuthorizer([
  {
    id: "local-operator",
    token: process.env.BLOGMAATIC_OPERATOR_TOKEN!,
    permissions: ["*"],
    roles: ["*"],
  },
]);

await startOperatorApi(
  { controlPlane, store, runtime, authorizer },
  { port: 4317 },
);
```

## Operator read model

The API exposes paginated queries for automation heads/version history, runs, schedules, live operational attention, and audit evidence.

`GET /v1/operations` and `GET /v1/runs?runtimePhase=...` use the durable runtime for current phase truth. The SQLite `runtime_phase` column is only a cache. Operator clients should not infer current workflow state directly from the database.

Collection cursors are opaque and resource-scoped. Return them unchanged to the same endpoint family.

## Audit evidence

Authenticated mutating routes write append-only audit evidence as `intent` followed by `succeeded` or `failed`. An intent-only correlation means the outcome evidence is incomplete or unknown. The ledger deliberately does not fabricate a business failure when execution succeeded but writing the success evidence later failed.

The ledger records authenticated actor, action, resource, request/run correlation and bounded evidence. It does not store bearer credentials or raw internal exception messages, and it is not presented as a cryptographic tamper-proof log.

Production deployments should inject a high-entropy token through their secret-management boundary. Do not commit bearer credentials to a repository or static configuration file.
