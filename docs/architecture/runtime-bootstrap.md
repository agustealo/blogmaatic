# Local Runtime and First-Run Bootstrap

Slice 11 turns the proven Blogmaatic components into one local application runtime without creating a second publishing or workflow authority. Slice 14 tightens the consumer authentication boundary so the bundled browser UI no longer handles the Operator API bearer credential.

## Runtime spine

```text
Control Room :4320
      |
      | /api proxy (loopback only, runtime-authenticated)
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

The operator credential file is created with owner-only permissions on POSIX systems and is never copied into `runtime.json`, URLs, the Control Room bundle, browser state, local storage, or Git.

## First run

```bash
npm install
npm run build
npm run runtime:init -- --jekyll-repo /absolute/path/to/site
npm run runtime:start
```

For an existing Jekyll repository, initialization discovers its current Git branch and Git author identity. `--author-name` and `--author-email` may be supplied when the repository has no local Git identity. Publishing does not push by default. `--push` must be explicit.

The bundled Control Room requires no credential-copy step. Once the runtime is running, the browser connects to the same-origin `/api` proxy. The proxy owns the local operator credential and injects it server-side only after origin/fetch-site validation.

`npm run runtime:token` remains an advanced escape hatch for an explicit external Operator API client. It is not part of the normal Control Room flow.

## Managed Restate

On macOS and Linux, `managed-local` uses the pinned `@restatedev/restate-server` and `@restatedev/restate` packages installed with the workspace. The runtime refuses to attach to an unknown process already occupying the managed Restate ports. Restate is started with a persistent base directory and a generated configuration that explicitly binds ingress, admin, and the optional query-engine listener to loopback addresses. The Blogmaatic workflow endpoint is registered through the official CLI without development `--force` semantics.

Only Restate ingress and admin are startup-readiness surfaces. The query-engine listener is still loopback-bound when enabled, but its absence does not make an otherwise healthy managed Restate instance fail startup.

Restate's current distribution publishes local server binaries for macOS and Linux. Other platforms must use `restate.mode=external` until a supported local binary strategy exists. The publication/control-plane contracts are unchanged in external mode.

## Startup activation boundary

Startup has a strict side-effect boundary. Blogmaatic first brings up and validates every fallible component: Restate, configured publisher connections, projection state, workflow endpoint, deployment registration, control-plane state, Operator API, and the Control Room host. The scheduler is created during composition but **does not start dispatching until every one of those components is ready**.

That rule is important because a due schedule may publish content immediately. A failed Control Room or listener startup must never be able to reject `startRuntime()` after publication side effects have already escaped.

## Scheduler authority

Schedules are not inert configuration. The runtime owns one polling loop which calls the canonical `AutomationControlPlane.dispatchDueSchedules()` API. Claim leases and deterministic schedule fire identities remain in the control-plane store, so the loop does not introduce a second scheduling truth.

Only one scheduler dispatch may be active at a time. Shutdown stops future timer creation and waits for the active dispatch to finish before any dependent runtime authority is closed. This prevents SQLite from being closed underneath a schedule claim or a successfully submitted durable run from being left unrecorded.

## Control Room hosting and authentication

The production Control Room bundle is served by a loopback-only static host. `/api/*` is a narrow reverse proxy to the Operator API.

The browser never supplies or receives the Operator API bearer credential. The runtime proxy owns that credential and replaces any incoming `Authorization` header with its own server-side authority. Before doing so, it rejects browser requests whose `Sec-Fetch-Site` is not `same-origin`/`none` or whose explicit `Origin` does not match the Control Room host. Proxied API responses are marked `no-store`.

The proxy forwards only the non-secret headers the operator contract needs, does not forward cookies, does not follow redirects, and applies restrictive browser security headers including same-origin resource policy. Browser routing falls back to `index.html`; file traversal is rejected. IPv6 loopback origins are emitted with bracketed host syntax so `::1` configurations produce valid URLs.

Direct Operator API clients remain bearer-authenticated and may use the advanced token command deliberately. Removing bearer material from the bundled browser UI does not weaken the Operator API boundary.

## Shutdown

Shutdown order is intentional and reverses the active application surfaces before state is released:

1. stop future scheduler work and await any active scheduler dispatch;
2. stop the Control Room host;
3. stop the Operator API so no new mutations enter;
4. close the Blogmaatic workflow endpoint;
5. stop managed Restate;
6. close projection and control-plane SQLite stores.

External Restate is never stopped by Blogmaatic.

The workflow endpoint is closed before managed Restate so no new local workflow handler requests are accepted while the durable runtime is being torn down. Durable execution state remains owned by Restate and resumes on the next successful start.

## Production proof

The runtime integration burn uses the real managed Restate server and a real temporary Git/Jekyll repository. It drives the path through the authenticated Operator API, durable Restate workflow, publication kernel, and Jekyll/Git extension, verifies the generated post and Git commit, reaches the same run through the Control Room proxy, shuts the runtime down, starts it again from the same SQLite and Restate state, and confirms the completed result is still available without creating another Git commit.

Distribution burns additionally require the packaged archive and the installed native package to call the Control Room `/api` surface without a browser bearer header. The request succeeds only when the runtime-owned proxy injects the real operator credential.

No fake publisher or in-memory workflow substitute is used for this proof.

## Extension posture

Slice 11 wires the real Jekyll/Git publisher into first-run because it can be proven locally without provider credentials. Other publisher packages remain extensions and are not silently fabricated or auto-configured. A runtime configuration that references an extension not wired into the active runtime fails closed.

Publisher credential storage is a separate authority from the local operator token. The existing `@blogmaatic/secrets` abstraction will be extended with a true OS credential-store adapter; this slice deliberately does not fake that boundary with shell commands that can expose secret material in process arguments.
