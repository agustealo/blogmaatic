# Publication Kernel

Blogmaatic is a publication automation control plane. The core does not know how WordPress, Jekyll, Facebook, LinkedIn, or future publishing hubs work. Those systems connect through publisher extensions.

## Slice 1 authority chain

The first kernel slice establishes this executable path:

`Publication -> Publication IR -> Publication Group -> Policy -> Projection -> Extension -> Delivery -> Verification -> Receipt -> Reconciliation`

### Publication

A publication is the logical item being managed. It owns lifecycle state and points at one immutable current revision.

### Publication IR

`PublicationIR` is Blogmaatic's platform-neutral representation. It carries structured blocks, assets, tags, language, and extension-safe JSON attributes. Provider payloads are compiled from this representation; provider objects never become canonical core state.

### Publication Group

A group contains routes. Each route targets one extension connection/channel and declares the capabilities required for that route. Capability negotiation is fail-closed.

A canonical Publication does not implicitly target every enabled group. Publishing intent is explicit and revisioned under `PublicationIR.attributes.publishingTargets.groupIds`. Drafts may have no targets, but dispatch is fail-closed until at least one group is selected. Every selected group must still exist, be enabled, and contain at least one enabled route at dispatch time. Legacy publications without target metadata remain readable/editable but never fall back to global groups.

### Policy

Policy is evaluated before compilation or delivery. Slice 1 supports deterministic declarative matching by publication status, route, extension, and tags with `allow`, `deny`, and `require_approval` effects. Approval is bound to the exact source revision so an approval cannot silently authorize later edits.

### Projection

A projection is the destination-specific compiled form of a publication revision. Every projection includes a stable fingerprint supplied by the extension. The fingerprint is the comparison boundary for verification and drift detection.

### Preview

Destination preview is a read-only compile operation over the exact same publisher extension contract used by delivery. Given a canonical Publication revision and an enabled Publication Group, Blogmaatic can compile every enabled route without inspecting or mutating the remote provider.

The preview boundary is provider-neutral. Each route returns its destination identity, source revision, projection fingerprint, a sanitized compiled payload, and a compact UI summary. One route may fail compilation without suppressing the previews for other destinations. This makes fidelity loss, scheduling decisions, provider modes, generated paths, and other projection differences visible before delivery.

Preview evidence is not remote acceptance evidence. Only delivery followed by provider inspection can produce a verified receipt.

Sanitization removes credential-shaped fields and local source filesystem paths before payloads cross the Operator API boundary.

### Destination matrix

Content exposes a derived Publication Destination Matrix for the current canonical revision.

The matrix is not a new source of truth. It composes existing authorities:

- active Publication Workspace revision
- every enabled route in the Publication's explicitly selected Publication Groups
- complete durable distribution history
- current extension compilation/preview results

A matrix row is identified by the full configured destination identity:

`groupId + routeId + extensionId + connectionId + channel`

Using the full identity prevents historical evidence from a rewired route from being attributed to a new destination that happens to reuse the same route id.

Derived delivery state is intentionally conservative:

- `not_sent`: no matching durable distribution evidence
- `current`: latest matching receipt is verified for the current canonical revision
- `update_available`: latest matching receipt is verified for an older canonical revision
- `drifted`: latest matching receipt reports remote drift
- `failed`: latest matching receipt is blocked, awaiting approval, unreachable, or otherwise not verified

Compile readiness is a separate dimension. A route may have valid historical delivery evidence while the current revision fails compilation. The matrix surfaces both truths rather than replacing one with the other.

The manager consumes all distribution-history pages before deriving latest receipt and delivery count. Selected configured routes that have never been sent therefore appear immediately, before their first delivery. Unselected globally enabled groups are intentionally absent from the matrix because they are not part of this Publication's distribution intent.

### Delivery

Delivery is reconcile-first. Before mutating a destination, the kernel inspects the remote projection. A synchronized projection is a no-op, a missing projection requires `article.create`, and a drifted projection requires `article.update` and carries the existing remote identity into delivery. This keeps duplicate prevention in the control plane instead of hoping every provider offers native idempotency.

Deliveries also carry an idempotency key derived from publication, revision, route, and desired fingerprint. Extensions must preserve or reconcile that identity when talking to remote systems.

### Verification and receipts

A successful API call is not enough. After delivery, the kernel asks the extension to inspect the remote object. A receipt is only `verified` when the observed remote fingerprint matches the desired projection fingerprint.

### Reconciliation

Reconciliation observes remote state without publishing. It reports `create`, `update`, `none`, or `blocked`, providing the base for desired-state publishing and future drift controllers.

## Core boundaries

Core owns:

- publication lifecycle and immutable revisions
- platform-neutral Publication IR
- publication groups and routes
- extension capability negotiation
- policy and revision-bound approvals
- idempotency identity
- delivery receipts
- remote verification
- reconciliation decisions

Extensions own:

- provider authentication and connections
- payload compilation
- provider-specific validation
- API/file/Git delivery
- remote object inspection
- provider-specific fingerprints and evidence
- destination-specific projection payloads used by both preview and delivery

Core must never branch on provider names.

## Intentionally deferred

This slice does not add fake WordPress, Jekyll, or social integrations. The test publisher exists only inside the test suite to exercise the extension contract. Real extensions are the next layer and must use their actual provider semantics.

Durable workflow execution, persistent stores, secrets, CloudEvents, CEL policy expressions, extension sandboxing, analytics, and MCP are also deferred until this core contract is proven.
