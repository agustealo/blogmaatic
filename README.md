# Blogmaatic

Blogmaatic is being rebuilt as a modular **publication automation control plane**.

The product manages one logical publication across multiple publishing hubs while keeping provider logic outside the core. WordPress, Jekyll/Git, social platforms, newsletters, and future systems connect through extensions.

## Current foundation

Slice 1 establishes the publication kernel:

`Publication -> Publication IR -> Publication Group -> Policy -> Projection -> Extension -> Delivery -> Verification -> Receipt -> Reconciliation`

The new core lives in `packages/core`. The original 2017 Django prototype remains in the repository for deliberate migration analysis; it is not the authority for the new architecture.

See [`docs/architecture/publication-kernel.md`](docs/architecture/publication-kernel.md) for the contract and boundaries.

## Development

Requires Node.js 24 LTS or newer.

```bash
npm install
npm run check
```

The core currently has no runtime dependencies. Provider SDKs belong in extension packages, not in `@blogmaatic/core`.
