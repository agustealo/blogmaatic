# @blogmaatic/operator-api

Authenticated Fastify 5 adapter over Blogmaatic's canonical control plane and durable automation runtime.

The package intentionally contains no publication repository, scheduler, workflow engine, or provider logic.

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

Production deployments should inject a high-entropy token through their secret-management boundary. Do not commit bearer credentials to a repository or static configuration file.
