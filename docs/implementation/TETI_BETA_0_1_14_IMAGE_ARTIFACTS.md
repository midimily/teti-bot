# Teti Beta 0.1.14 — Reliable Image Artifacts

Status: implemented; physical two-Mac sign-off pending

Application version: `0.1.14`

Implemented on: 2026-07-27

## Product invariant

An `image-editing` task succeeds only when at least one real, verified image is
available to the requester. Text that claims an image was produced is not an
image result and cannot produce a completed Task.

## Local execution

- Runtime registers `openai.codex.imagegen` only after the existing Codex CLI
  qualification and local-login check pass.
- The Adapter invokes Codex app-server through bundled Node, submits task text
  through stdin, supplies only the explicitly attached local images, and uses a
  read-only task workspace with approval disabled.
- Apps, hooks, MCP servers, web search, multi-Agent work and shell execution are
  disabled for this bounded path.
- Runtime consumes the official `imageGeneration` item and its `savedPath`.
  `savedPath` is treated as a candidate rather than proof that the file is ready:
  Runtime waits up to ten seconds for the file to become a complete supported
  image, strips non-allowlisted metadata and atomically persists up to four
  verified outputs into the isolated task workspace. The Kernel then ingests
  those private copies into Teti's Artifact store before deleting the workspace.
- A valid persisted image takes precedence over a late non-zero app-server exit.
  This prevents a generated image from being discarded merely because the
  experimental server closes before its final turn notification.
- The bounded JSONL reader accepts at most 8 MiB per app-server line. The
  current Codex schema requires `imageGeneration.result` alongside `savedPath`;
  this limit admits Teti's maximum 5 MiB image after base64 expansion without
  turning the protocol reader into an unbounded allocation.
- Immediately after JSON parsing, Runtime projects only
  `type`/`status`/`savedPath` for an image result. The duplicate, large
  `result` string and `revisedPrompt` are neither retained, logged, copied into
  the runner manifest nor admitted to an Artifact. The verified file at
  `savedPath` remains the only image candidate.
- A missing image, malformed manifest, path escape, unsupported format,
  oversized output, timeout, cancellation or process failure produces only a
  safe failure code and no partial Artifact.

## 0.1.14 P0 result-boundary repair

The original implementation assumed that `imageGeneration.savedPath` meant the
file was immediately complete, copied it after a fixed delay and still allowed a
later process exit to decide the Task outcome. Real tasks demonstrated that the
PNG could already exist while this post-generation boundary returned either
`ADAPTER_EXIT_NONZERO` or the generic `ADAPTER_OUTPUT_INVALID`.

The repaired boundary now distinguishes:

- `ADAPTER_IMAGE_RESULT_MISSING`: no image result signal was produced;
- `ADAPTER_IMAGE_RESULT_NOT_READY`: the candidate never became readable and complete;
- `ADAPTER_IMAGE_RESULT_INVALID`: the completed candidate is not an accepted PNG/JPEG;
- `ADAPTER_IMAGE_SERVER_EXITED`: app-server exited before an image candidate existed;
- `ADAPTER_IMAGE_GENERATION_TIMEOUT`: no terminal image result arrived in time.
- `ADAPTER_IMAGE_PROTOCOL_LIMIT`: an app-server JSONL line exceeded the bounded
  8 MiB transport allowance.

Automated regression coverage includes partial-file completion, permanently
invalid and missing files, and app-server exiting non-zero immediately after it
has emitted a valid `savedPath`. It also includes an official-shape
`imageGeneration` event whose `result` exceeds 2 MiB, an over-8-MiB failure, and
the real bundled runner path through Kernel into the private Artifact Store. No
prompt, duplicate image result, filesystem path or upstream process output
crosses the safe Task error boundary.

The real local smoke test used an existing non-private project PNG. Codex
returned a 1254 x 1254 PNG through `imageGeneration.savedPath`; the output had a
different SHA-256 from the input and passed image inspection. No Chatmail
account or Registry data was created or modified by this smoke test.

## Task protocol v3

Application Envelope remains version 1. Task protocol v3 extends the existing
multipart task flow with reliable image result delivery:

1. Presence advertises `taskProtocolVersions: [1, 2, 3]`.
2. The requester may select `image-editing` only for a Peer known to support v3.
3. The receiver still reviews the complete text and input images and grants one
   local execution only.
4. Runtime persists the generated image and queues one artifact attachment per
   image.
5. Image bytes are sent before the Artifact manifest; delivery remains durable
   and retryable.
6. The requester MIME-sniffs, bounds, hashes and stores each file, then matches
   it to the immutable Artifact descriptor.
7. UI shows `任务已完成 · 结果接收中` if status arrives before the image and
   renders the verified result gallery when ready.

Chatmail may reorder status, attachment and Artifact messages. The receiver
therefore supports both attachment-before-manifest and manifest-before-
attachment without acknowledging a message before durable processing.

## 0.1.14 P0 asynchronous Chatmail attachment repair

DeltaChat's `download_full_message` schedules a Post-Message download; it does
not wait for the file to become available. Teti therefore treats attachment
delivery as a durable state machine:

- `Available` or `Failure`: request the full download once and re-read the
  message state;
- `InProgress`: do not request the download again and keep the Chatmail message
  fresh;
- `Done` with a private Blob path: validate, hash, copy and persist the image;
- acknowledge the Chatmail message only after the Task attachment and its
  readiness state have been durably saved;
- `TASK_ATTACHMENT_PENDING` and `TASK_DEPENDENCY_PENDING` never enter the
  five-failure malformed-message isolation path;
- a `MsgsChanged` event or a later backlog poll re-reads the same unacknowledged
  message, so a Runtime restart can finish the transfer.

Post-Message metadata can arrive before its encrypted caption. Because that
caption carries the `teti.task.attachment` Envelope, Runtime applies a narrow
pre-envelope gate before treating a textless message as disposable: the sender
must be a Confirmed Peer, the advertised size must stay within the Task image
limit, and the filename or MIME metadata must identify a bounded Teti PNG/JPEG.
Only then may Runtime request the partial download and keep it fresh. After the
caption becomes available, the normal Envelope, identity, expiry, immutable
descriptor and image-content checks still run before persistence and
acknowledgement.

Expired attachment envelopes may be acknowledged without downloading their
files. The repair intentionally does not scan for or revive historical
attachments that an older 0.1.14 build already marked as seen; those test Tasks
must be sent again.

## Compatibility

- Both Macs should run 0.1.14 for image editing. Presence performs explicit
  Task-version discovery; App version is diagnostic only.
- Known Task-v1/v2 Peers retain their existing text and image-input behavior,
  but Teti refuses to send them an image-editing request whose result contract
  cannot be honored.
- Delayed Task-v1/v2 and Passport schema-1/2 messages remain strictly parsed;
  they cannot downgrade an established newer snapshot.

## Automated and physical gates

Automated coverage includes manifest allowlisting, workspace path confinement,
generated-image persistence, mandatory-image failure, two-image input, result
attachment verification, status-before-Artifact, Artifact-before-Task,
transient persistence retry, Runtime restart and old Task-version handling. It
also covers asynchronous `Available -> InProgress -> Done` delivery for one,
two and four input images, a generated result image, more than five slow polls,
`MsgsChanged`, caption-hidden Post-Message delivery, retry from `Failure`, and
restart while a download remains in progress.

Physical two-Mac sign-off must verify:

1. both Apps report 0.1.14 and exchange Task version 3 through Presence;
2. an image-editing capability is selectable only when the receiver advertises
   it in Callable Passport and Task v3 is known;
3. one-image and two-image requests preserve editor focus and show the complete
   review before allow-once;
4. the requester receives and can open at least one actual result image;
5. taking the requester offline before result delivery still completes after
   restart without a duplicate Task or lost Artifact;
6. killing Runtime during execution produces a safe failed state, never a
   false completed image result;
7. quitting the App reaps Codex app-server and bundled Node child processes.
