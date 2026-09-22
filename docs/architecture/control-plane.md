# Automation Control Plane

Slice 7 adds the durable wake-up layer that decides **when** an automation should run and preserves the exact evidence used to start it.

The control plane is deliberately separate from the durable workflow runtime:

```text
Publication / External Event / Schedule
                |
                v
        Blogmaatic Control Plane
        ------------------------
        automation registry
        event inbox
        scheduler
        run registry
                |
                v
          AutomationLauncher
                |
                v
       Restate durable adapter
                |
                v
        Publication automation
```

Blogmaatic owns definitions, trigger identity, routing decisions, schedules and run records. Restate owns workflow journaling, replay, durable timers and approval suspension after a run has been launched.

## Automation registry

Automation definitions are immutable `(automationId, version)` snapshots. Registering different content under an existing version fails closed.

`automation_heads` identifies the one active version and whether it is enabled. Event routing only considers that active enabled version. A new version therefore does not reinterpret an event that was already received.

## Event inbox and frozen routing

Every event is assigned a deterministic trigger identity derived from both its producer `source` and producer-local event `id`.

The trigger inbox and all matching run requests are committed in one SQLite transaction before any durable runtime call is made.

On first receipt:

```text
event
  -> find active matching automations
  -> evaluate conditions
  -> create exact run snapshots
  -> commit trigger + runs
  -> launch runtime
```

On duplicate receipt:

```text
same source + same event id
  -> load the previously committed runs
  -> do not re-evaluate current automation versions
  -> launch only runs that are not already recorded started
```

This is intentional. Webhook retries cannot adopt newer automation logic or a newer publication revision after the first routing decision has been accepted.

## Deterministic run identity

Run IDs are SHA-256-derived from:

- trigger identity
- automation id
- automation version
- publication id
- publication revision id

The control plane reserves the run before calling the runtime. A launch failure is stored as `launch_failed`; retrying uses the same run ID.

If the process crashes after Restate accepts the workflow but before Blogmaatic records `started`, recovery submits the same Restate workflow ID. Restate workflow identity then converges on the already accepted execution instead of creating a second publication run.

## Run registry

The durable dispatch states are:

- `prepared` - trigger and exact run snapshot are committed, runtime launch has not been acknowledged
- `started` - runtime returned an invocation identity
- `launch_failed` - launch was not acknowledged and is eligible for safe retry with the same run ID

Runtime phase is tracked separately from dispatch state and can be refreshed through the launcher status contract. This keeps control-plane dispatch truth separate from workflow execution truth.

## Scheduler

Schedules are Blogmaatic-owned records. Slice 7 supports:

- one-time schedules
- daily schedules
- weekly schedules using ISO weekdays `1..7`
- IANA timezones
- `catch_up_once` missed-run behavior
- `skip` missed-run behavior with a configurable grace window

A schedule pins:

- one exact automation version
- one exact publication revision
- the publication-group snapshots used by that automation

A later edit does not silently change an already configured scheduled release. A new release intent must update or replace the schedule explicitly.

### Wall-clock and DST semantics

Local schedules use `@js-temporal/polyfill` while Blogmaatic's supported Node 24 line does not provide Temporal as a default runtime API.

Recurring schedules preserve the requested local wall-clock time. Time-zone conversion uses Temporal's `compatible` disambiguation:

- during a fall-back overlap, the earlier valid instant is selected
- during a spring-forward gap, the local time is shifted forward to the next valid instant

All instants are normalized to canonical UTC strings before they enter SQLite due/lease comparisons. Mixed offset representations therefore cannot change temporal ordering in a text comparison.

## Scheduler leases

Due schedules are claimed inside `BEGIN IMMEDIATE` transactions with:

- a random claim token
- a claim-expiry instant
- a bounded batch limit

Expired claims are reclaimable after a worker crash. Claim completion and release are token-guarded so a stale worker cannot mutate a claim owned by another worker.

A schedule fire also has deterministic trigger/run identity. If two workers race across a lease boundary, downstream runtime identity remains idempotent rather than creating two logical publication runs.

## Misfire policy

`catch_up_once` executes the currently due fire once, then advances recurrence beyond the current instant.

`skip` compares lateness against `misfireGraceMs`. If the fire is too stale, no automation is launched and recurrence advances beyond the current instant.

The scheduler does not replay every missed daily/weekly occurrence after a long outage in this slice. That avoids a restart causing a publication burst.

## Restate launcher

`RestateAutomationLauncher` uses the current Restate workflow ingress client:

- `workflowSubmit` for detached, idempotent launch
- shared `status` handler for observation
- shared `approve` handler for human decisions
- `workflowAttach` when a caller explicitly wants the terminal workflow result

The control plane depends only on the `AutomationLauncher` interface. Restate remains replaceable by another durable runtime adapter without changing registry, event, schedule or run semantics.

## Failure boundaries

The control plane distinguishes:

- trigger deduplication
- routing/validation failure
- runtime launch failure
- durable workflow execution status
- publication business outcomes inside the workflow

These are not collapsed into one generic `failed` state. The separation is required for safe retry and useful operator diagnostics.

## Current non-goals

Slice 7 deliberately does not add:

- arbitrary cron-expression parsing
- a visual workflow builder
- CEL or another expression language
- distributed queues outside the durable runtime
- a second scheduler service
- a cloud-only control plane

The next layers should consume these contracts rather than create parallel trigger or schedule authorities.
