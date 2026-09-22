# Blogmaatic

Blogmaatic is being rebuilt as a modular **publication automation control plane**.

It manages one logical publication across multiple publishing hubs while keeping provider behavior outside the core. WordPress, Jekyll/Git, social platforms, newsletters, and future systems connect through extensions.

## Current foundation

The executable authority chain is:

`Publication -> Publication IR -> Publication Group -> Policy -> Projection -> Extension -> Delivery -> Verification -> Receipt -> Reconciliation`

Slice 1 established the platform-neutral publication kernel.

Slice 2 added the managed extension runtime and connection authority plus the first real publisher: `@blogmaatic/extension-jekyll-git`.

Slice 3 adds `@blogmaatic/secrets` and the second real publisher: `@blogmaatic/extension-wordpress-rest`. WordPress credentials are resolved from secret references at request time, while the extension uses the native REST API for authenticated posts, media, categories, tags, drafts, scheduling, inspection, and update-in-place reconciliation.

The original 2017 Django prototype remains in the repository for deliberate migration analysis; it is not an authority for the new architecture.

## Packages

- `@blogmaatic/core` — publication domain, policy, projection, delivery, verification, reconciliation.
- `@blogmaatic/extension-sdk` — managed extension manifest, connection authority, health and lifecycle runtime.
- `@blogmaatic/secrets` — provider-neutral secret-reference resolution with scoped plaintext exposure.
- `@blogmaatic/extension-jekyll-git` — real Jekyll/Git repository publisher.
- `@blogmaatic/extension-wordpress-rest` — real WordPress REST publisher using Application Password authentication.

See [`docs/architecture/publication-kernel.md`](docs/architecture/publication-kernel.md), [`docs/architecture/extensions.md`](docs/architecture/extensions.md), and [`docs/architecture/wordpress-rest.md`](docs/architecture/wordpress-rest.md).

## Development

Requires Node.js 24 LTS or newer and Git.

```bash
npm install
npm run check
```

Provider SDKs and credentials belong in extension packages and connection/secrets infrastructure, never in `@blogmaatic/core`.
