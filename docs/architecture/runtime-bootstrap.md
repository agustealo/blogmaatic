# Local Runtime and First-Run Bootstrap

Slice 11 turns the proven Blogmaatic components into one local application runtime without creating a second publishing or workflow authority.

## Runtime spine

```text
Control Room :4320
      |
      | /api proxy (loopback only)
      v
Operator API :4317
      |
      v
Automation Control Plane ---- SQLite control-plane facts
      |
      v
Restate ingress :8080
      |
      v
Publication workflow endpoint :9080
      |
      v
Publication Kernel ----------- SQLite projection state
      |
      v
Publisher extensions
```

The runtime owns process lifecycle and composition. Domain behavior stays in the existing packages.

## State authorities

The local data directory contains separate authorities:

- `runtime.json`: non-secret runtime configuration, connection references, policies, and local bind settings;
- `control-plane.sqlite`: automation definitions, run identities, schedules, leases, and audit evidence;
- `projection-state.sqlite`: last verified remote projection identities and fingerprints;
- `restate/`: the managed Restate server's durable execution state;
- `secrets/operator.token`: the local Operator API bearer credential.

The operator credential file is created with owner-only permissions on POSIX systems and is never copied into `runtime.json`, URLs, the Control Room bundle, or Git.

## First run

```bash
npm install
npm run build
npm run runtime:init -- --jekyll-repo /absolute/path/to/site
npm run runtime:start
```

For an existing Jekyll repository, initialization discovers its current Git branch and Git author identity. `--author-name` and `--author-email` may be supplied when the repository has no local Git identity. Publishing does not push by default. `--push` must be explicit.

Retrieve the local operator credential only when needed by the Control Room:

```bash
npm run runtime:token
```

The token command intentionally writes only the credential to stdout so it can be copied or piped deliberately.

## Managed Restate

On macOS and Linux, `managed-local` uses the pinned `@restatedev/restate-server` and `@restatedev/restate` packages installed with the workspace. The runtime refuses to attach to an unknown process already occupying the managed Restate ports. Restate is started with a persistent base directory and the Blogmaatic workflow endpoint is registered through the official CLI without development `--force` semantics.

Restate's current distribution publishes local server binaries for macOS and Linux. Other platforms must use `restate.mode=external` until a supported local binary strategy exists. The publication/control-plane contracts are unchanged in external mode.

## Scheduler authority

Schedules are not inert configuration. The runtime owns one polling loop which calls the canonical `AutomationControlPlane.dispatchDueSchedules()` API. Claim leases and deterministic schedule fire identities remain in the control-plane store, so the loop does not introduce a second scheduling truth.

## Control Room hosting

The production Control Room bundle is served by a loopback-only static host. `/api/*` is a narrow reverse proxy to the Operator API. It forwards only the headers the operator contract needs, does not forward cookies, does not follow redirects, and applies restrictive browser security headers. Browser routing falls back to `index.html`; file traversal is rejected.

## Shutdown

Shutdown order is intentional:

1. stop the scheduler and Control Room;
2. stop the Operator API so no new mutations enter;
3. stop managed Restate so it stops driving workflow work;
4. close the workflow endpoint;
5. close projection and control-plane SQLite stores.

External Restate is never stopped by Blogmaatic.

## Extension posture

Slice 11 wires the real Jekyll/Git publisher into first-run because it can be proven locally without provider credentials. Other publisher packages remain extensions and are not silently fabricated or auto-configured. A runtime configuration that references an extension not wired into the active runtime fails closed.
