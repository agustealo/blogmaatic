# Blogmaatic

Blogmaatic is being rebuilt as a modular **publication automation control plane**.

It manages one logical publication across multiple publishing hubs while keeping provider behavior outside the core. WordPress, Jekyll/Git, social platforms, newsletters, and future systems connect through extensions.

## Current foundation

The executable authority chain is:

`Publication -> Publication IR -> Publication Group -> Policy -> Variant/Projection -> Extension -> Delivery -> Verification -> Receipt -> Reconciliation`

Slice 1 established the platform-neutral publication kernel.

Slice 2 added the managed extension runtime and connection authority plus the first real publisher: `@blogmaatic/extension-jekyll-git`.

Slice 3 added `@blogmaatic/secrets` and `@blogmaatic/extension-wordpress-rest`, proving authenticated remote CMS publishing, media/taxonomy management, scheduling, ownership-safe inspection, and update-in-place reconciliation.

Slice 4 adds provider-neutral social adaptation, durable projection identity, and `@blogmaatic/extension-linkedin-rest`. Rich Publication IR can now be projected into constrained destinations with an explicit fidelity report instead of silently pretending every hub supports the same content model. Server-generated remote identities are persisted through the core projection-state contract, with a file-backed SQLite adapter for restart-safe reconciliation.

The original 2017 Django prototype remains in the repository for deliberate migration analysis; it is not an authority for the new architecture.

## Packages

- `@blogmaatic/core` — publication domain, policy, projection state, delivery, verification, reconciliation.
- `@blogmaatic/extension-sdk` — managed extension manifest, connection authority, health and lifecycle runtime.
- `@blogmaatic/secrets` — provider-neutral secret-reference resolution with scoped plaintext exposure.
- `@blogmaatic/variants` — destination capability profiles, social adaptation, fidelity reporting, and minimum-fidelity gates.
- `@blogmaatic/state-sqlite` — durable remote projection identity using Node's built-in SQLite runtime.
- `@blogmaatic/extension-jekyll-git` — real Jekyll/Git repository publisher.
- `@blogmaatic/extension-wordpress-rest` — real WordPress REST publisher using Application Password authentication.
- `@blogmaatic/extension-linkedin-rest` — versioned LinkedIn organization-post publisher with drift-aware commentary updates and fail-closed structural reconciliation.

See [`docs/architecture/publication-kernel.md`](docs/architecture/publication-kernel.md), [`docs/architecture/extensions.md`](docs/architecture/extensions.md), [`docs/architecture/wordpress-rest.md`](docs/architecture/wordpress-rest.md), and [`docs/architecture/social-projections.md`](docs/architecture/social-projections.md).

## Development

Requires Node.js 24 LTS or newer and Git.

```bash
npm install
npm run check
```

Provider SDKs and credentials belong in extension packages and connection/secrets infrastructure, never in `@blogmaatic/core`.
