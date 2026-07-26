# Teti Beta 0.1.12 — Task Collaboration Implementation

Status: implemented
Application version: `0.1.12`
Implemented on: 2026-07-26

## Outcome

Beta 0.1.12 completes the first consent-gated collaboration loop between two
Confirmed Teti nodes:

1. the requester selects a Capability from the remote Callable Passport;
2. Teti sends required text and optionally up to four verified PNG/JPEG inputs;
3. Chatmail retains the asynchronous Task while either Desktop is offline;
4. the receiver reviews the complete input and chooses allow once or reject;
5. allow once creates one local short-lived Execution Grant and invokes a
   Runtime-qualified Adapter in its isolated task directory;
6. working, completed, failed, rejected and canceled state is synchronized;
7. the requester receives a bounded text Artifact.

No receipt, presence heartbeat or attachment arrival can execute an Agent.

## Runtime ownership

The lifecycle Runtime owns Task persistence, Chatmail polling, attachment
verification, retry, approval mutation, Adapter execution and status/Artifact
delivery. Desktop is a consumer through bounded lifecycle methods:

- `task.summary`
- `task.get`
- `task.attachment.stage`
- `task.attachment.resolve`
- `task.send`
- `task.approve`
- `task.reject`
- `task.cancel`

Background Adapter completion is re-entered through the same serialized peer
operation queue as polling and UI calls, preventing lost updates to the Task
store.

## Protocol and compatibility

Application Envelope stays at version 1. Task protocol supports `[1, 2]`:

- v1: bounded text request and receipt;
- v2: multipart text/image request plus attachment descriptors.

The typed semantic objects are `teti.task.request`, `teti.task.receipt`,
`teti.task.attachment`, `teti.task.status`, `teti.task.cancel`, and
`teti.task.artifact`. A known peer receives only the highest common Task
version. An old v1 peer remains usable for text and never receives image bytes.

Task identity uses `(requesterTetiId, taskId)`. Duplicate immutable content is
idempotent; conflicting reuse fails closed. Status revisions are monotonic and
cannot regress a terminal state.

## Image boundary

Image JSON contains only generated attachment identity, MIME type, byte length,
dimensions and SHA-256. File bytes use DeltaChat's official `misc_send_msg`
file parameter and `download_full_message` receive flow.

The private attachment store:

- uses profile-owned `0700` directories and `0600` files;
- copies through an atomic temporary file;
- MIME-sniffs PNG/JPEG rather than trusting an extension;
- enforces 5 MiB per image, 12 MiB total, four images and 4096 px dimensions;
- removes metadata by writing a sanitized image representation;
- validates length, dimensions and digest before approval;
- enforces four-image/12 MiB per-task and 256 MiB/2,048-file private-store
  ceilings, including attachments that arrive before a reordered request;
- uses generated filenames and never transmits the source path;
- removes orphaned and expired data without touching the Chatmail database.

## Execution boundary

Approval reloads authoritative Task state and checks identity, TTL, attachment
readiness, current Capability and accepted input modes. The local Execution
Grant is single-use, lasts no more than five minutes, permits only the fixed
Adapter entrypoint and isolated task directory, and grants no user-file access.

Codex receives image paths inside the isolated task directory via repeated
official `--image` arguments; task text remains on stdin. The `--` separator is
required so the variadic image option cannot consume stdin. CodeBuddy remains
subject to its previously frozen qualification gates. Output is bounded and
converted to a text Artifact; stderr, paths and internal diagnostics are not
shared.

## Desktop UI

The trusted local Task workspace is `600 × 360` and A2UI-inspired without
accepting remote UI definitions. It provides an Inbox, composer, complete input
review, allow-once/reject controls, lifecycle states and Artifact view. Header
and action bar remain visible while the middle area scrolls. Draft text and
staged images survive focus collapse.

Inbox order is:

1. incoming requests awaiting approval, earliest expiry first;
2. working tasks, newest update first;
3. outgoing submitted tasks, newest first;
4. terminal tasks, newest first.

The list is bounded to 100 summaries; full Task content loads only on selection.

## Verification

- strict Task v1/v2 and Application Envelope validation tests;
- attachment permissions, MIME, metadata, quota and digest tests;
- Chatmail exact RPC file-send and download mapping tests;
- duplicate, conflict, expiry, version and offline retry tests;
- two isolated peer Runtime end-to-end image Task, approval, fake execution and
  Artifact return test;
- real local Codex image Adapter smoke test;
- lifecycle bridge size/allowlist tests;
- TypeScript typecheck, full Node suite, Rust suite and release App build;
- 600 × 360 local visual verification with no browser console errors.

## Explicit limits

- No automatic or reusable approval.
- No repository, cwd, arbitrary file, command, environment, model or tool
  selection from a peer.
- No remote A2UI payload, public A2A endpoint, Agent Card or MCP platform.
- No image-result Artifact delivery in 0.1.12.
- No launchd daemon behavior after Teti Desktop exits.
