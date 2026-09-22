# Social Projections and Fidelity

Blogmaatic does not treat cross-posting as copying one payload into many APIs. A logical publication may be represented differently at each destination while remaining one managed publication.

## Adaptation contract

`@blogmaatic/variants` accepts:

- the canonical `Publication` / Publication IR
- a destination capability profile
- a route-level adaptation policy

It returns:

- destination commentary
- selected media assets
- optional article-card metadata
- a `FidelityReport`

The adapter is provider-neutral. LinkedIn is its first consumer, not its architecture.

## Fidelity

A projection may lose or flatten source semantics. Examples include headings becoming plain text, galleries exceeding a destination image limit, tables becoming linear text, embeds becoming links, or commentary requiring truncation.

Each transformation emits a fidelity issue with severity and detail. The report also exposes a deterministic score and whether the projection is exact.

Routes may set a minimum fidelity requirement. Compilation fails before network mutation when the generated representation falls below that threshold.

The score is an operational signal, not a claim that destinations are interchangeable. Provider extensions still own provider-specific constraints and validation.

## Projection identity

Social APIs commonly generate remote identifiers after creation. Searching a provider after restart by commentary, URL, or title is not a safe ownership protocol.

Core therefore persists a `RemoteIdentity` per publication route through `ProjectionStateStore`.

The kernel behavior is:

1. compile the desired projection
2. load known remote identity for publication + route
3. inspect that exact remote object
4. reconcile missing/synchronized/drifted/unreachable state
5. deliver only when needed
6. persist verified/delivered remote identity
7. clear stale identity when the provider confirms the object is gone

An identity is used only when its extension and connection still match the route.

`@blogmaatic/state-sqlite` provides the first durable implementation using Node's built-in SQLite support. Core remains storage-agnostic.

## LinkedIn v0.1

`@blogmaatic/extension-linkedin-rest` proves the social path against the versioned LinkedIn Posts API.

Current scope is deliberately narrow:

- organization authors only
- `posts` channel only
- text posts
- article-card posts using explicit source/title/description
- public main-feed distribution
- versioned REST and Rest.li headers
- access token supplied through Secrets Authority

The extension requires read access as well as write access because desired-state publishing must inspect the exact remote object after creation and on later reconciliation.

### Text mode

Text mode compiles rich Publication IR to destination commentary. Canonical URL and hashtags are policy-controlled. Out-of-band commentary drift is repaired in place through LinkedIn's partial-update operation.

### Article mode

Article mode uses the canonical publication URL as the explicit article source, with publication title and summary as card metadata. Blogmaatic does not depend on provider URL scraping.

Article-card structural fields are not treated as safely mutable. If source/title/description drifts remotely, the extension reports drift but delivery fails closed rather than delete/recreate the post automatically. This protects engagement history and avoids a destructive crash window.

### Ownership

A LinkedIn projection is owned by its stored server-generated URN. The extension does not search the account and adopt a similar-looking post.

If the stored object no longer exists, the kernel removes the stale identity and a future reconciliation can create a replacement deliberately.

## Current limits

LinkedIn v0.1 intentionally does not yet add image/video/document upload, member-profile publishing, polls, multi-image posts, engagement analytics, comments, or automatic delete/recreate migration. These can be added as extension capabilities once their lifecycle and reconciliation semantics are proven without weakening the current contracts.
