# Blogmaatic

Blogmaatic is a modular **publication automation control plane** for maintaining one logical publication across multiple publishing hubs.

It combines durable automation, policy, destination-aware content projection, provider extensions, verification, reconciliation, and an operator Control Room. Provider behavior stays outside the core: Jekyll/Git, WordPress, LinkedIn, Facebook, and future destinations connect through extension contracts rather than provider branches in the publication kernel.

## Architecture

The executable authority chain is:

```text
Trigger / Schedule / Operator
            ↓
       Control Plane
            ↓
    Durable Automation
            ↓
     Publication Group
            ↓
       Policy Engine
            ↓
 Variant / Projection
            ↓
    Extension Runtime
            ↓
 Delivery / Verification
            ↓
 Receipt / Reconciliation
```

The local application adds:

```text
Control Room
    ↓
Operator API
    ↓
Control Plane + SQLite
    ↓
Restate durable runtime
    ↓
Publication Kernel
    ↓
Publisher extensions
```

Current real publisher classes prove materially different delivery models:

- **Jekyll/Git** — files, assets, Git commits/push, build verification, drift repair.
- **WordPress REST** — authenticated CMS API, media, taxonomy, scheduling, remote IDs and update-in-place reconciliation.
- **LinkedIn** — constrained social projection, fidelity reporting, opaque post identity and safe partial updates.
- **Facebook Pages** — Graph API text/link/image/multi-image/scheduled posts with immutable-drift protection.

Restate is an execution adapter, not Blogmaatic's domain model. SQLite owns local control-plane/projection facts; Restate owns durable workflow journaling, replay, timers, and approval suspension.

## Consumer installation

Slice 12 produces portable managed-runtime archives for:

- Linux x64
- macOS Apple Silicon
- macOS Intel

Each archive contains the compiled Blogmaatic runtime and Control Room, the locked production dependency graph, a pinned Node.js 24.21 runtime, and pinned Restate binaries. The target machine does **not** need a repository checkout, Node.js, or npm.

Verify the matching `.sha256` file before extraction, then:

```bash
./blogmaatic-0.11.0-<platform>-<arch>/bin/blogmaatic version
./blogmaatic-0.11.0-<platform>-<arch>/bin/blogmaatic init --jekyll-repo /absolute/path/to/site
./blogmaatic-0.11.0-<platform>-<arch>/bin/blogmaatic doctor
./blogmaatic-0.11.0-<platform>-<arch>/bin/blogmaatic start
```

Retrieve the local operator credential only when needed:

```bash
./blogmaatic-0.11.0-<platform>-<arch>/bin/blogmaatic token
```

The application state directory is separate from the installation, so the versioned application archive can be replaced without moving publication/run state.

Windows currently requires `restate.mode=external`; Blogmaatic does not claim an unverified managed Restate binary path on Windows.

See [`docs/architecture/distribution.md`](docs/architecture/distribution.md) for the artifact, integrity, compatibility, and clean-install proof contract.

## Main packages

- `@blogmaatic/core` — publication domain, policy, projection state, delivery, verification and reconciliation.
- `@blogmaatic/variants` — destination capability profiles, adaptation and fidelity reporting.
- `@blogmaatic/extension-sdk` — extension manifests, connections, health and lifecycle.
- `@blogmaatic/secrets` — scoped secret-reference resolution.
- `@blogmaatic/state-sqlite` — durable remote projection identity.
- `@blogmaatic/automation` — provider-neutral automation definitions and run contracts.
- `@blogmaatic/automation-restate` — durable Restate execution adapter.
- `@blogmaatic/control-plane` — automation registry, event routing, schedules, deterministic run identity and audit authority.
- `@blogmaatic/operator-api` — authenticated operator/control-plane HTTP surface.
- `@blogmaatic/operator-client` — browser-safe typed client for the operator API.
- `@blogmaatic/extension-jekyll-git` — real Jekyll/Git publisher.
- `@blogmaatic/extension-wordpress-rest` — real WordPress publisher.
- `@blogmaatic/extension-linkedin-rest` — real LinkedIn organization-post publisher.
- `@blogmaatic/extension-facebook-pages` — real Facebook Pages publisher.
- `@blogmaatic/control-room` — React/Vite operational UI.
- `@blogmaatic/runtime` — local application composition, first-run bootstrap, managed Restate lifecycle and consumer CLI.

## Development

Development uses a committed dependency graph and exact install semantics.

Requirements:

- Node.js 24.21.x
- npm 11.19.x
- Git
- Docker for the existing Restate Testcontainers integration burn

```bash
npm ci --ignore-scripts
npm run check
```

To burn a local portable distribution after building:

```bash
npm run build
rm -rf node_modules
npm ci --omit=dev --ignore-scripts
npm run distribution:stage
```

Provider credentials belong in connection/secrets infrastructure, never in `@blogmaatic/core`. Durable-runtime code belongs behind the automation adapter. Trigger, schedule and run authority belongs in the control plane rather than extensions.

## Architecture documents

- [`publication-kernel.md`](docs/architecture/publication-kernel.md)
- [`extensions.md`](docs/architecture/extensions.md)
- [`wordpress-rest.md`](docs/architecture/wordpress-rest.md)
- [`social-projections.md`](docs/architecture/social-projections.md)
- [`facebook-pages.md`](docs/architecture/facebook-pages.md)
- [`durable-automation.md`](docs/architecture/durable-automation.md)
- [`control-plane.md`](docs/architecture/control-plane.md)
- [`runtime-bootstrap.md`](docs/architecture/runtime-bootstrap.md)
- [`distribution.md`](docs/architecture/distribution.md)
