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

### Policy

Policy is evaluated before compilation or delivery. Slice 1 supports deterministic declarative matching by publication status, route, extension, and tags with `allow`, `deny`, and `require_approval` effects. Approval is bound to the exact source revision so an approval cannot silently authorize later edits.

### Projection

A projection is the destination-specific compiled form of a publication revision. Every projection includes a stable fingerprint supplied by the extension. The fingerprint is the comparison boundary for verification and drift detection.

### Delivery

Deliveries carry an idempotency key derived from publication, revision, route, and desired fingerprint. Extensions must preserve or reconcile that identity when talking to remote systems.

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

Core must never branch on provider names.

## Intentionally deferred

This slice does not add fake WordPress, Jekyll, or social integrations. The test publisher exists only inside the test suite to exercise the extension contract. Real extensions are the next layer and must use their actual provider semantics.

Durable workflow execution, persistent stores, secrets, CloudEvents, CEL policy expressions, extension sandboxing, analytics, and MCP are also deferred until this core contract is proven.
