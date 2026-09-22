# Durable Publication Automation

Slice 6 turns Blogmaatic publication groups into durable workflows without making a workflow vendor part of the publication domain.

## Authority boundary

`@blogmaatic/automation` owns Blogmaatic's automation language:

- automation identity and version
- manual and event triggers
- publication conditions
- publication-group steps
- human approval steps
- durable delays
- business-failure policy
- run/result/status contracts
- the `AutomationPublisher` boundary used to invoke publication groups

`@blogmaatic/automation-restate` is the first durable-execution adapter. Restate is responsible for journaling, durable promises, timers, replay, and retry mechanics. Publication core, extension contracts, publication groups, and automation definitions contain no Restate types.

A future durable adapter may implement the same Blogmaatic automation contracts without changing publication or extension logic.

## Run snapshots

An automation run carries the exact automation definition, publication revision, trigger evidence, and publication-group configuration that the run started with.

This is intentional. A long-running workflow must not silently change meaning because an operator edits a publication group or automation definition while the run is waiting for approval or a timer.

Automation definitions are versioned. A new definition version applies to new runs; an existing run continues against its captured version.

## Trigger and condition model

Slice 6 defines two trigger forms:

- `manual`
- `event`, identified by an exact event type

Conditions can constrain publication status plus `tagsAll` and `tagsAny`.

The external event router and schedule/recurrence engine are deliberately not implemented in this slice. They will create durable runs later; they are not embedded into the workflow executor.

## Steps

### Publish group

A `publish_group` step delegates to the existing publication kernel through `AutomationPublisher`.

The publication kernel remains authoritative for policy, capabilities, compilation, remote inspection, delivery, verification, receipts, drift handling, and projection identity.

`verified` receipts are success. `blocked`, `drifted`, `awaiting_approval`, or an empty receipt set are business failures. The step can either stop or continue after a business failure.

`unreachable` is treated as transient and is retried durably by the Restate adapter.

### Human approval

An `approval` step suspends on a Restate durable promise. The signal must match all of:

- run id
- step id
- required role
- exact publication revision

An approval for an older revision cannot authorize a newer publication revision. Rejection is a durable business outcome, not an infrastructure error, and later steps do not execute.

Accepted automation approvals are translated into the core's existing route-level `ApprovalGrant` contract when a later publication-group step executes.

### Delay

A `delay` step uses a Restate durable timer. Process restarts or workflow replay do not restart previously completed publication steps.

The initial contract limits a single delay to 365 days. Recurring calendar schedules remain a trigger concern rather than a giant sleeping automation definition.

## Retry authority

The adapter distinguishes retryable infrastructure failure from business failure.

- an `unreachable` delivery receipt is retryable
- blocked/drifted/approval business outcomes are not infrastructure retries
- publisher exceptions fail terminal by default
- deployments may provide `isRetryablePublisherError` to explicitly classify known transient publisher exceptions

This default is intentionally fail-safe. Authentication, configuration, validation, or other permanent provider failures must not become infinite retry loops merely because the runtime is durable.

## Workflow identity and observability

Each Restate workflow is keyed by the Blogmaatic `runId`. Restate therefore provides one durable workflow execution for that run identity.

Workflow state exposes a queryable `AutomationRunStatus` containing:

- automation id/version
- publication/revision
- current phase
- completed step ids
- current step
- expected approval, when applicable
- operator-facing detail
- durable update timestamp

This is the runtime status of one run. A searchable cross-run execution ledger and automation registry remain later control-plane concerns.

## Replay proof

The integration suite uses a real Restate server through `@restatedev/restate-sdk-testcontainers`.

The burn enables Restate `alwaysReplay` mode so suspension points force replay. It proves that:

1. the origin publication step executes
2. the workflow suspends for approval
3. replay does not execute the completed origin publication again
4. a wrong-revision approval is rejected
5. an exact approval resumes the same run
6. a durable delay completes
7. the later social publication executes once
8. final status is queryable
9. human rejection prevents all later steps

The test publisher exists only inside the integration suite. Production automation executes through the `AutomationPublisher` interface and the real publication kernel.

## Deliberately deferred

- persistent automation-definition registry
- event ingestion/router
- scheduled and recurring triggers
- cross-run execution ledger/search
- notifications for waiting approvals/failures
- typed provider error taxonomy shared by extensions
- cancellation and operator intervention
- compensation/replacement workflows
- CEL policy expressions
- CloudEvents envelope
- alternate durable adapters

These are subsequent control-plane slices, not placeholders in the production runtime.
