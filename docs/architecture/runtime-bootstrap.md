# Local Runtime and First-Run Bootstrap

Slice 11 turns the proven Blogmaatic components into one local application runtime without creating a second publishing or workflow authority. Slice 14 tightens the consumer authentication boundary so the bundled browser UI never handles the Operator API bearer credential and the privileged proxy is not exposed as an unauthenticated loopback bridge.

## Runtime spine

```text
one-time Control Room launch URL
      ↓
HttpOnly SameSite runtime session
      ↓
Control Room :4320
      |
      | /api proxy (loopback only, session-gated)
      v
Operator API :4317 (bearer-authenticated)
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

The Control Room browser session is a separate, runtime-memory authority. At each runtime start, Blogmaatic creates a random one-time launch capability and a random session token. The launch capability is printed as the Control Room URL. Its first successful GET exchanges it for an `HttpOnly; SameSite=Strict` session cookie and permanently consumes that launch capability. The session token is never written to disk and is invalidated when the runtime stops.

Publisher credentials are a third authority. `runtime.json` stores only secret references. On macOS and Linux, local consumer credentials may use `vault:<locator>` references backed by the OS credential store; environment-variable references remain available as the read-only `env:` provider.

## First run

```bash
npm install
npm run build
npm run runtime:init -- --jekyll-repo /absolute/path/to/site
npm run runtime:start
```

For an existing Jekyll repository, initialization discovers its current Git branch and Git author identity. `--author-name` and `--author-email` may be supplied when the repository has no local Git identity. Publishing does not push by default. `--push` must be explicit.

`runtime:start` prints a one-time Control Room launch URL. Open that URL in the browser. There is no Operator API token field and no credential-copy step.

`npm run runtime:token` remains an advanced escape hatch for an explicit external Operator API client. It is not part of the normal Control Room flow.

## Managed Restate

On macOS and Linux, `managed-local` uses the pinned `@restatedev/restate-server` and `@restatedev/restate` packages installed with the workspace. The runtime refuses to attach to an unknown process already occupying the managed Restate ports. Restate is started with a persistent base directory and a generated configuration that explicitly binds ingress, admin, and the optional query-engine listener to loopback addresses. The Blogmaatic workflow endpoint is registered through the official CLI without development `--force` semantics.

Only Restate ingress and admin are startup-readiness surfaces. The query-engine listener is still loopback-bound when enabled, but its absence does not make an otherwise healthy managed Restate instance fail startup.

Restate's current distribution publishes local server binaries for macOS and Linux. Other platforms must use `restate.mode=external` until a supported local binary strategy exists. The publication/control-plane contracts are unchanged in external mode.

## Startup activation boundary

Startup has a strict side-effect boundary. Blogmaatic first brings up every runtime authority required for safe execution: Restate, projection state, workflow endpoint, deployment registration, control-plane state, Operator API, and the Control Room host. Configured publisher connections are validated and health-inspected during composition, but an invalid, unhealthy, degraded, or temporarily unreachable destination is diagnostic rather than a reason to take the entire local control plane offline. A workflow that targets that destination still fails or blocks through the canonical extension/delivery path.

The scheduler is created during composition but **does not start dispatching until every required listener and state authority is ready**. That rule is important because a due schedule may publish content immediately. A failed Control Room or listener startup must never be able to reject `startRuntime()` after publication side effects have already escaped.

## Scheduler authority

Schedules are not inert configuration. The runtime owns one polling loop which calls the canonical `AutomationControlPlane.dispatchDueSchedules()` API. Claim leases and deterministic schedule fire identities remain in the control-plane store, so the loop does not introduce a second scheduling truth.

Only one scheduler dispatch may be active at a time. Shutdown stops future timer creation and waits for the active dispatch to finish before any dependent runtime authority is closed. This prevents SQLite from being closed underneath a schedule claim or a successfully submitted durable run from being left unrecorded.

## Control Room hosting and authentication

The production Control Room bundle is served by a loopback-only static host. `/api/*` is a narrow reverse proxy to the Operator API.

The browser never supplies or receives the Operator API bearer credential. Instead, a one-time launch capability establishes a separate HttpOnly browser session. Every privileged `/api` request must carry that session cookie, target the exact bound Control Room `Host`, and satisfy browser origin/fetch-site checks. Requests without a valid runtime session fail before the Operator API is contacted.

That session gate matters because `Origin`, `Host`, and `Sec-Fetch-Site` checks alone are browser-CSRF defenses, not local-process authentication: a non-browser local process can forge ordinary HTTP headers. The unguessable runtime-memory session capability prevents an arbitrary process that merely reaches the loopback port from borrowing the proxy's operator authority.

Incoming browser `Authorization` is ignored. Once the session gate succeeds, the proxy adds the real operator credential server-side, forwards only the non-secret headers the operator contract needs, never forwards cookies upstream, never follows redirects, and marks API responses `no-store`.

The host applies restrictive browser security headers including same-origin resource policy. Browser routing falls back to `index.html`; file traversal is rejected. IPv6 loopback origins are emitted with bracketed host syntax so `::1` configurations produce valid URLs.

Direct Operator API clients remain bearer-authenticated and may use the advanced token command deliberately. Removing bearer material from the bundled browser UI does not create a second unauthenticated API surface.

For Vite development, the dev proxy follows the same ownership principle: it reads the existing local operator credential server-side, injects it only into loopback Operator API requests, removes browser cookies before forwarding, and refuses remote, credential-bearing, or path-bearing proxy targets.

## Publisher credential vault

`@blogmaatic/secrets` is the canonical secret-reference authority. Slice 14 adds a mutable `vault:` provider for the supported local platforms without changing extension configuration into a secret store.

- macOS uses Keychain generic-password items. Secret writes are sent to the `security` tool through its interactive stdin path rather than as ordinary process arguments.
- Linux uses Secret Service through `secret-tool`; secret writes are supplied on stdin. The Debian package declares `libsecret-tools` as an installation dependency.
- locators and stored payloads are Blogmaatic-namespaced and bounded in size;
- helper processes run without a shell, with execution timeouts and output limits;
- resolved and stored mutable byte buffers are zeroed after callback/write scope;
- missing-secret errors redact the locator rather than echoing it.

Distribution Quality performs real store/read/delete round trips against a temporary macOS Keychain and a fresh Linux Secret Service session before packaging. Runtime configuration contains only references such as `vault:wordpress/application-password`, never the credential value.

The vault is an authority layer, not yet a complete connection-management UI. Creating/editing WordPress, LinkedIn, and Facebook connection records and placing their credentials into the vault from the Control Room is deliberately left to the next consumer-management slice rather than reintroducing plaintext configuration or browser-local secrets here.

## Shutdown

Shutdown order is intentional and reverses the active application surfaces before state is released:

1. stop future scheduler work and await any active scheduler dispatch;
2. stop the Control Room host and destroy its in-memory browser session;
3. stop the Operator API so no new mutations enter;
4. close the Blogmaatic workflow endpoint;
5. stop managed Restate;
6. close projection and control-plane SQLite stores.

External Restate is never stopped by Blogmaatic.

The workflow endpoint is closed before managed Restate so no new local workflow handler requests are accepted while the durable runtime is being torn down. Durable execution state remains owned by Restate and resumes on the next successful start.

## Production proof

The runtime integration burn uses the real managed Restate server and a real temporary Git/Jekyll repository. It drives the path through the authenticated Operator API, durable Restate workflow, publication kernel, and Jekyll/Git extension, verifies the generated post and Git commit, bootstraps a real Control Room browser session, reaches the same run through the tokenless Control Room client path, shuts the runtime down, starts it again from the same SQLite and Restate state, and confirms the completed result is still available without creating another Git commit.

Distribution burns additionally require the packaged archive and the installed native package to consume the one-time Control Room launch URL, receive the scoped session cookie, and call `/api` with no browser bearer header. The request succeeds only when the session is valid and the runtime-owned proxy injects the real operator credential.

The same distribution matrix burns the real OS credential provider on Linux x64, macOS arm64, and macOS x64 before the platform package is assembled.

No fake publisher or in-memory workflow substitute is used for these proofs.

## Extension posture

The local runtime registers the real Jekyll/Git, WordPress REST, LinkedIn REST, and Facebook Pages publishers through one `ExtensionRuntime`. Jekyll remains the only publisher configured automatically by the existing first-run CLI because it can be proven from a local repository without external credentials. HTTP/social destinations are never fabricated or silently auto-configured.

WordPress, LinkedIn, and Facebook use the same `SecretAuthority` to resolve `env:` or `vault:` references. A broken destination is reported during startup inspection without taking unrelated publishers or the operator control plane offline; actual publication still goes through the existing policy, projection, delivery, verification, and receipt contracts.
