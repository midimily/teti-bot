# Teti Beta 0.2.5 — Durable Async Execution v1

Status: implementation landed; automated verification and physical acceptance
remain release gates.

## Goal

Beta 0.2.5 establishes a receiver-local, restart-queryable execution identity
for long-running collaboration. It does not claim that every current Child
Agent can resume. Codex, Codex Image, CodeBuddy, and Osaurus currently declare
cancel support only; their interrupted executions remain queryable but are not
automatically replayed or labeled recoverable.

## Frozen local contract

`ExecutionHandle` schema v1 contains:

- `taskId`, `workspaceId`, `childAgentId`, and `connectorId`;
- monotonically increasing `executionEpoch`;
- local-only `providerExecutionId` and `checkpointRef`;
- renewable `leaseExpiresAt`;
- bounded `progress` state and message;
- `resumeCapability`, currently `none` or `checkpoint_restart`.

Every Connector declares `supportsProgress`, `supportsPause`,
`supportsResume`, `supportsCheckpoint`, and `supportsCancel`, plus execution
semantics. Resume requires both explicit checkpoint support and
`workspace_pure_compute` semantics. A Connector that can cause external side
effects can never be replayed automatically after its process disappears.

## Runtime behavior

- The receiving Host writes handles atomically to Store v2 with mode `0600`.
- Runtime startup reconciles non-terminal handles with live in-memory work.
  Orphans become `interrupted`; no task is silently launched again.
- A qualifying Connector may return an explicit checkpoint inside its private
  Workspace Snapshot. The Host resolves containment, rejects symlink/path
  escape, and copies the checkpoint into receiver-private storage before the
  Snapshot is cleaned.
- Resume is an explicit local UI action. It mints a fresh one-time grant and
  authority, increments `executionEpoch`, and restarts from the private
  checkpoint.
- Completion, cancellation, Artifact persistence, and checkpoint capture all
  validate the current epoch. Duplicate completion and old-epoch callbacks are
  ignored.
- UI exposes only safe state, epoch, and a bounded progress message. Provider
  IDs and checkpoint paths remain local Runtime details and never enter Task,
  Passport, Chatmail, or peer status messages.

## Passport detail refresh correction (partial in 0.2.5)

Passport observation still polls every three seconds, but the controller now
compares a semantic presentation projection before asking the application to
render. This removed Passport timestamp/revision churn. Subsequent physical use
found a second source: the independent two-second Task poll still asked the
global shell to render and replaced the expanded connection DOM. Beta 0.2.6
closes that remaining path with a Task presentation projection. Sharing,
reachability, resource, Agent, capability, visible Task state, and other real
changes still render normally.

## Release gates

Automated gates cover:

1. Sidecar restart turns an orphan into a queryable interruption without
   replay.
2. Workspace-pure resume requires a captured explicit checkpoint and increments
   the epoch.
3. Old completion, late Artifact publication, and cancel/resume races cannot
   overwrite a newer execution.
4. Duplicate completion is idempotent and the local handle store remains
   private.
5. Connector declarations cannot claim Resume without Checkpoint.
6. Passport timestamp-only polling does not rebuild the expanded detail UI;
   the independent Task-poll path is a 0.2.6 correction.

Physical gates still required before release sign-off:

- Teti UI restart, Sidecar restart, and Child Agent crash on both Macs;
- real Osaurus interruption/cancellation and inference-stop observation;
- no duplicate external side effect under restart and cancellation races;
- delayed Artifact delivery against a newer epoch;
- the inherited 0.1.15 multi-image acceptance review.

The existing Osaurus Insights body-retention blocker and the locally
untrusted/invalid Osaurus app signature remain fail-closed. Beta 0.2.5 does not
weaken either gate.
