# Teti Beta 0.2.8 — Long-Horizon Collaboration

## Outcome

Beta 0.2.8 changes a collaboration from one potentially long provider call
into a durable sequence owned by `TetiHostAgent`. Every `LocalChildAgent`
executes one stage only. The Host decides whether to wait for input, pause,
continue with an explicitly selected Child, or mark the latest Artifact final.

The implementation is text-only for `long_horizon` in this release. Existing
single-stage text and image Tasks continue through Task v6. This keeps the
known multi-image physical-Mac defect out of the new recovery state machine
until the planned post-upgrade review.

## Contracts

`CollaborationTaskRequest.executionMode` is mandatory in Task v6 and is either
`single_stage` or `long_horizon`. Long-horizon receiver state contains:

- current phase and stage index;
- bounded Progress;
- continuation expiry and renewal count;
- pending supplemental input and current input request;
- locally available Child targets;
- stages with derived execution Task ID, Child/Connector, instruction digest,
  input Workspace revision and expected mutation mode;
- Host checkpoints containing stage, committed Workspace revision and Artifact
  IDs;
- append-only intermediate/final Artifact metadata;
- an ordered local audit trail.

The limits are 16 stages, 32 Artifacts, 256 audit events, 8 KiB per supplemental
instruction, eight renewals, 24 hours per renewal and seven days absolute
lifetime. A temporary long-horizon Workspace resolves to
`durable_collaboration`; an arbitrary host path remains impossible.

## Protocol and privacy

Task v6 adds `teti.task.input`, status schema 2 and staged Artifact schema 2.
The requester receives only phase, stage number, Workspace revision, bounded
Progress, continuation expiry, input request ID and optional final Artifact ID.
It never receives Child or Connector IDs, instruction/checkpoint digests, the
audit trail, provider execution ID, local paths or Runtime configuration.

Supplemental input is stage-bound and idempotent by `inputId`. Delivery never
starts a Child automatically. The receiver must explicitly choose Continue and
may select a different currently ready Child. Teti records a `child_selected`
event when that choice changes.

If Continue omits a Child selection, the Host may reuse only the exact previous
Child/Connector pair. When that pair is no longer ready, the operation fails
with `TASK_CHILD_SELECTION_REQUIRED`; it never falls through to the first
available alternative. This keeps failure recovery a visible user decision at
both the UI and lifecycle API boundaries.

## Workspace, Checkpoint and Artifact rules

Each stage receives a derived execution Task ID, a fresh Execution Handle and
a one-time Authority. Snapshot-writing stages must produce exactly input
revision + 1. Read-only, no-Workspace and bounded-context stages must leave the
revision unchanged. Any mismatch discards the stage output and creates no Host
checkpoint.

Successful stage output is appended as an intermediate Artifact. It is never
overwritten by a later result. The Host checkpoint binds the exact Workspace
revision and all Artifact IDs produced by that stage. Completion changes only
the latest Artifact's role to final and publishes its ID in peer status.
The requester persists the stage index and role beside each Artifact, so a
reordered Chatmail delivery cannot relabel stage 2 output as stage 1.

## Pause, recovery and expiry

Current production Connectors do not claim native pause/resume. Pause is
therefore truthful stage-boundary pause: while working, a pause request is
recorded and takes effect after the Child finishes. At a boundary, Continue
mints a new stage and execution epoch. A missing/crashed Child becomes
`input_required`; no external-side-effect call is replayed automatically.

The continuation expiry is included in Execution Authority schema 4. The
Kernel stops at the earlier Connector timeout/deadline and rechecks the
deadline before Artifact persistence and Workspace commit. Expired execution
cannot write. Renewal is therefore accepted only at a stage boundary, before
the next immutable Authority is minted. Every pause, resume, Child selection,
renewal, restart reconciliation, failure and completion remains visible in the
receiver-local audit.

## Desktop behavior

The composer exposes Single Call and Continuous Collaboration. Task detail
shows stage, Workspace revision, progress, lease, intermediate Artifacts and a
local expandable audit. The requester can send one supplemental instruction;
the receiver can pause at the boundary, choose a Child, continue, complete, or
renew one hour. Controls remain native buttons/selects/textarea with labels and
keyboard operation.

## Release gates

Automated coverage proves:

- the real lifecycle `task.send` boundary accepts and preserves
  `executionMode: long_horizon`;
- a stage-boundary session survives receiver Runtime reconstruction;
- supplemental input resumes the next stage and never auto-runs;
- selecting a different Child is explicit and audited, and an unavailable
  previous Child cannot trigger an implicit fallback;
- exact Workspace revision conflict discards the stale Artifact and checkpoint;
- intermediate Artifacts remain when a later Artifact becomes final;
- expired work cannot publish a late Artifact;
- Task v6 does not downgrade to Task v5.

Release compatibility is part of the same sign-off, but remains a Host-level
admission concern rather than a Child capability. The production Registry
`/release-policy` route must pass its exact smoke test. A locally obsolete Host
must not mint the next stage, renew a continuation, accept supplemental input,
or let an active Child publish late output. The Child still owns only its
current stage; it never interprets release policy and never decides whether the
Task may continue. Durable Task, Workspace, Checkpoint and audit state remain
on disk for the upgraded Host to reconcile without silently replaying a stage.

The compatibility sub-gate additionally proves fail-open behavior without
authoritative evidence, sticky offline lock after an effective floor was
cached, policy rollback protection, and strict separation between local
release support and per-Peer Task v6 compatibility. The unavoidable boundary
is explicit: 0.2.7 and older binaries have no self-enforcement client and
cannot be retroactively frozen by deploying a Worker route.

The adjacent P1 peer-identity fix also moves Registry Profile recovery out of
Chatmail polling. Missing nicknames retry independently with bounded backoff;
a successful partial refresh immediately revises the Runtime Passport without
waiting for Task, attachment, presence, or AI Passport traffic.

Still required for release sign-off:

- physical 0.2.8 launch against the deployed policy, followed by an offline
  restart using the accepted cache;
- a staged future-floor drill in a non-production Worker environment, including
  active-stage cancellation and upgraded-Host reconciliation audit;
- physical two-Mac long collaboration across repeated App and Sidecar restarts;
- real Codex and CodeBuddy staged text execution;
- Osaurus interruption/recovery under cold start and memory pressure;
- the existing 0.1.15 multi-image review, performed separately from the
  text-only long-horizon path;
- resolution of the existing Osaurus Insights body-retention and invalid local
  signature blockers before claiming real Osaurus acceptance.
