# Blogmaatic

Blogmaatic is being rebuilt as a modular **publication automation control plane**.

It manages one logical publication across multiple publishing hubs while keeping provider behavior outside the core. WordPress, Jekyll/Git, social platforms, newsletters, and future systems connect through extensions.

## Current foundation

The executable authority chain is:

`Publication -> Publication IR -> Publication Group -> Policy -> Projection -> Extension -> Delivery -> Verification -> Receipt -> Reconciliation`

Slice 1 established the platform-neutral publication kernel.

Slice 2 adds the extension runtime and connection authority plus the first real publisher: `@blogmaatic/extension-jekyll-git`. That extension writes real Jekyll Markdown/front matter, manages approved local assets, commits through Git, can push to a configured Git remote, verifies observed state, detects committed drift, refuses to overwrite uncommitted human edits, and rolls back pre-commit mutations when build verification fails.

The original 2017 Django prototype remains in the repository for deliberate migration analysis; it is not an authority for the new architecture.

## Packages

- `@blogmaatic/core` — publication domain, policy, projection, delivery, verification, reconciliation.
- `@blogmaatic/extension-sdk` — managed extension manifest, connection authority, health and lifecycle runtime.
- `@blogmaatic/extension-jekyll-git` — real Jekyll/Git publisher extension.

See [`docs/architecture/publication-kernel.md`](docs/architecture/publication-kernel.md) and [`docs/architecture/extensions.md`](docs/architecture/extensions.md).

## Development

Requires Node.js 24 LTS or newer and Git.

```bash
npm install
npm run check
```

Provider SDKs and credentials belong in extension packages and connection/secrets infrastructure, never in `@blogmaatic/core`.
