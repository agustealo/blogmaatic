# Extension Runtime and Connection Authority

Blogmaatic integrations are extensions. The core publication kernel never branches on WordPress, Jekyll, Facebook, LinkedIn, or another provider name.

## Runtime boundary

`@blogmaatic/extension-sdk` adds the managed runtime around the core publisher contract.

A managed publisher declares:

- a namespaced extension id
- semantic version
- extension API version
- connection schema version
- publisher capabilities
- connection validation
- connection health checks
- compile, inspect, and deliver behavior inherited from the core publisher contract

The runtime rejects duplicate extensions, malformed manifests, duplicate capabilities, disabled connections, and connections owned by another extension.

## Connection authority

Connections are configuration records, not credential bags.

A connection contains:

- stable connection id
- owning extension id
- display name
- active/disabled state
- extension-specific JSON settings
- secret references only
- created/updated timestamps

Raw credentials are intentionally not part of the connection record. A dedicated secrets authority will resolve `secretRefs` in a later slice. Extensions must not persist credentials inside publication groups or route variants.

Extension ownership is immutable. Replacing a connection can update its settings/status but cannot silently move it to another extension.

## Jekyll/Git proof extension

`@blogmaatic/extension-jekyll-git` is the first production extension because it exercises file and Git semantics instead of an HTTP API.

### Connection settings

Required:

- `repositoryPath` — absolute path to an existing Jekyll Git work tree
- `branch` — branch Blogmaatic is authorized to manage
- `authorName`
- `authorEmail`

Optional:

- `postsDirectory` (default `_posts`)
- `draftsDirectory` (default `_drafts`)
- `assetsDirectory` (default `assets/blogmaatic`)
- `remote` (default `origin`)
- `push` (default `false`)
- `siteBaseUrl`
- `buildVerification` (`none` or `bundle`)
- `assetSourceRoots` — explicit absolute directories from which local publication assets may be read

### Channels

The extension supports two channels:

- `posts` -> dated Jekyll post under `_posts`
- `drafts` -> undated Jekyll draft under `_drafts`

Document filenames use the stable publication id rather than the mutable title. A publication may carry a stable `slug`; otherwise the Jekyll slug falls back to the publication id.

### Compilation

The extension compiles Publication IR blocks into deterministic Markdown and YAML-compatible front matter. Blogmaatic-managed front matter cannot be overridden through route custom metadata.

Local assets are publishable only when their real path is inside a configured `assetSourceRoots` entry. Managed assets are copied into the Jekyll repository and Markdown references the published repository URL, never the source machine path.

Projection fingerprints cover both document content and managed asset bytes. This means an externally modified image is drift just like an externally modified article body.

### Human-work protection

Committed external edits are treated as drift and may be reconciled by the publication control plane.

Uncommitted edits to any managed document or asset fail closed as `unreachable`. Blogmaatic will not overwrite work that a human has not committed or discarded.

### Delivery transaction

Delivery:

1. validates connection health and branch ownership
2. refuses conflicting uncommitted target paths
3. snapshots target files
4. writes the document/assets atomically
5. optionally runs `bundle exec jekyll build`
6. stages only managed paths
7. commits only when content changed
8. optionally pushes the configured branch
9. returns Git commit evidence

A failure before the Git commit restores the snapshots and unstages managed paths. A push failure intentionally leaves the local commit intact so a later retry can push the already-created publication commit rather than regenerate it.

### Remote verification

When `push=false`, the local Git work tree is the destination authority.

When `push=true`, inspection fetches the configured remote branch and verifies that the latest commits affecting every managed projection path are present remotely. Local content is not considered synchronized merely because the file exists.

This matters for crash/retry behavior: a commit that succeeded locally but failed to push remains drifted until the remote actually contains it.

## Current safety invariants

- core contains no provider-name branching
- extension ids are namespaced and versioned
- connections cannot cross extension ownership
- disabled connections fail closed
- provider mutations remain inspect-first
- synchronized projections are no-ops
- committed drift updates the existing projection
- uncommitted human edits are preserved
- repository writes cannot escape the configured repository root
- local asset reads are allowlisted by real path
- local source filesystem paths are not emitted into generated content
- pre-commit build failures roll back managed files
- push-enabled delivery is verified against the remote branch

## Deliberately deferred

The runtime is currently in-process and connection records are in-memory. Persistence, encrypted secret resolution, durable workflow execution, CloudEvents, CEL policy expressions, extension sandboxing, MCP, and marketplace packaging remain later slices.

The next provider proof should use a remote HTTP API, preferably WordPress REST, so the same kernel/runtime contracts are exercised against authentication, remote identifiers, API versioning, media upload, and server-side drafts.
