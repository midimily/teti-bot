# Teti Beta 0.2.2 — Collaboration Workspace v1

Status: implemented; automated release verification passed; physical two-Mac
sign-off pending

Application version: `0.2.2`

## Scope

Beta 0.2.2 introduces the first Teti-owned collaboration container. It does not
mount a user folder and does not accept a path from a remote Teti. The supported
modes are:

- `ephemeral_task`: bounded task-local state with TTL, removed after a Runtime
  crash or restart;
- `durable_collaboration`: versioned state that is verified and restored after
  restart.

The following modes are deliberately not part of Workspace v1:
`external_user_folder`, `arbitrary_host_path`, and `remote_path`.

## Contracts

Workspace schema v1 contains `workspaceId`, `ownerTetiId`,
`participantTetiIds`, `revision`, `mode`, `quota`, `retentionPolicy`, `manifest`,
`createdAt`, and `updatedAt`. The manifest contains only validated relative
file names, byte lengths, hashes, and timestamps.

Task protocol v5 carries exactly one abstract Workspace request:

- `temporary` plus ordered access rights; or
- `reference` plus Workspace ID, expected revision, and ordered access rights.

No Task may carry a local or remote path. The receiver resolves the request
after explicit task approval and persists a local-only `TaskWorkspaceBinding`.
An existing Workspace reference is usable only when both the requester and the
local Teti are members and the requested revision still exists.

ExecutionGrant v2 and ExecutionAuthority v2 contain the Workspace ID, revision,
and ordered access rights (`read`, `write`, `create_artifact`). Snapshot paths
remain inside the Host Runtime and are never serialized into Task, Passport,
Chatmail, Grant, or peer state.

## Snapshot execution and commit

Before a Connector starts, `TetiHostAgent` asks the Workspace Store for a
private Snapshot of the approved revision. Input images are copied into that
Snapshot and removed before commit. A Child Agent sees only the Snapshot path.

On successful execution, a writable Snapshot is scanned, bounded, copied into
a new revision directory, and published with an atomic metadata update. The
commit uses optimistic revision checking: if another execution already
advanced the Workspace, the stale execution fails with
`ADAPTER_WORKSPACE_CONFLICT` instead of overwriting it. Failed, canceled,
timed-out, read-only, or abandoned Snapshots are discarded.

## Storage and recovery

Production state is rooted below Store v2 at
`~/.teti/store-v2/collaboration-workspaces`. All derived disk paths come from
validated local IDs. Index files use private permissions and atomic rename.

At startup:

- all surviving Snapshot scratch directories are deleted;
- all `ephemeral_task` Workspaces are deleted as crashed transient state;
- each `durable_collaboration` Workspace is rescanned and its content is
  compared with the committed manifest before use.

## Security gates

- relative paths reject absolute roots, backslashes, empty/dot/dot-dot
  segments, NUL/control characters, and overlong segments;
- tree scans and copies use `lstat` and reject every symbolic link and
  non-regular file;
- byte and file quotas are checked before a revision is committed;
- ephemeral TTL is positive, bounded to 24 hours, and actively cleaned;
- Task v5 and lifecycle validation reject path-like extension fields;
- Task/Passport projections remain free of Snapshot paths and execution
  transport details.

## UI insertion

The AI Passport and Settings surfaces are now owned by a relative anchor around
their corresponding toolbar button. Each panel opens below the icon with its
top-right edge aligned to the icon's center, instead of using one shared
left-positioned panel origin. Existing outside-click, keyboard, focus, and
reduced-motion behavior is retained.

## Verification

Automated coverage includes durable restart recovery, ephemeral crash cleanup,
TTL cleanup, quota enforcement, symlink escape rejection, optimistic conflict,
Host Snapshot execution/commit, Task v5 negotiation, path-field rejection,
multi-image Task transport, TypeScript validation, and the existing desktop UI
regression suite. The final local gate passed 487 repository tests plus 2
Workspace contract tests, desktop TypeScript checking, the production frontend
build, and Rust `cargo check`.
