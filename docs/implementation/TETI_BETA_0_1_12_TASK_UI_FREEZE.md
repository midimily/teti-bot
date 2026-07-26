# Teti Beta 0.1.12 — 双 Mac 任务 UI 冻结

Status: implementation baseline
Version target: `0.1.12`
Frozen on: 2026-07-26

## 1. Product boundary

Beta 0.1.12 closes one explicit collaboration loop between two Confirmed Teti
identities:

1. The requester selects one Capability advertised by the remote Callable
   Passport.
2. The requester writes an instruction and may attach bounded JPEG or PNG
   images.
3. The receiver reviews the complete instruction and every verified image.
4. The receiver explicitly chooses `allow once` or `reject`.
5. An approved request creates one local, short-lived, single-use Execution
   Grant and runs one qualified local Adapter.
6. Task state and bounded Artifacts are returned to the requester.

This is not a chat surface, a permanent permission, an arbitrary remote command
runner, or a complete A2A endpoint.

## 2. A2UI-inspired local UI contract

Teti adopts the A2UI principles of a trusted local component catalog, separate
structure and data, stable component identity, explicit actions, and incremental
state updates. Teti does **not** accept remote A2UI component definitions or
transmit A2UI JSON over Chatmail in 0.1.12.

Trusted components:

- `TaskWorkspace`
- `TaskInbox`
- `TaskSummaryRow`
- `PeerIdentity`
- `CapabilityPicker`
- `TaskTextInput`
- `AttachmentPicker`
- `AttachmentPreview`
- `ApprovalScope`
- `TaskStatus`
- `ActionBar`
- `ArtifactList`
- `ImageViewer`

Stable local actions:

- `task.compose`
- `task.draft.attach_image`
- `task.draft.remove_attachment`
- `task.send`
- `task.allow_once`
- `task.reject`
- `task.cancel`
- `task.stop`
- `artifact.copy`
- `artifact.save`

An action submits only its immutable Task identity and the minimal selected
context. The Runtime reloads and validates authoritative state before every
mutation.

## 3. Surface and navigation

- Task work uses a dedicated `600 × 360` notch-panel mode within the existing
  native `640 × 360` safety ceiling.
- The top center remains clear for a physical notch. Context and back navigation
  stay on the left; Passport, Task Inbox and Settings stay on the right.
- Header and bottom actions are fixed. The middle content area scrolls.
- Losing focus may collapse the panel, but never discards a draft, dismisses an
  approval, cancels execution, or changes Task state.
- A task badge counts only incoming requests that still require a decision.

## 4. Composer rules

- A non-empty text instruction is mandatory.
- The UI accepts at most 6,000 Unicode code points and the Runtime retains the
  existing 24 KiB UTF-8 hard limit.
- The requester may attach zero to four images.
- Initial image formats are JPEG and PNG.
- Each image is at most 5 MiB; all images together are at most 12 MiB; the
  longest side is at most 4,096 pixels.
- EXIF/GPS and original local paths never cross the Task boundary.
- An image control is available only when the selected remote Capability
  advertises image input.
- A v1 or otherwise text-only peer remains usable for text tasks and never
  receives speculative image content.
- The default expiry is one hour. Beta 0.1.12 does not expose a TTL selector.

## 5. Approval rules

The receiver sees the peer identity, Capability, selected local Agent, complete
text, verified image previews, expiry, and the exact one-time scope before an
approval control is enabled.

`Allow once` is never the default focused action and cannot be triggered by
window focus, outside click, or an unmodified Enter key. It fails closed when
attachments are incomplete, the request expired, the Capability is unavailable,
or the local Adapter no longer accepts the advertised input modes.

## 6. User-visible states

Network and execution state reuse the A2A-aligned vocabulary already frozen by
Teti: `submitted`, `working`, `completed`, `failed`, `canceled`, and `rejected`.
Approval and delivery remain separate local dimensions.

The UI distinguishes:

- waiting for delivery
- waiting for peer approval
- receiving attachments
- working
- completed
- failed
- rejected
- cancellation requested
- canceled
- expired

A requester cancellation remains `cancellation requested` until a remote state
update confirms the terminal state. Retrying a terminal task creates a new Task
ID.

## 7. Artifact boundary

Results are Artifacts, not chat messages. Beta 0.1.12 qualified Adapters return
bounded text Artifacts. The v2 contract reserves bounded image descriptors, but
image-result transport and saving remain outside the 0.1.12 completion claim.
Teti never automatically writes result files into a user-selected directory.

Process output, stderr, executable paths, workspaces, credentials, prompts from
other sessions, and diagnostic stacks are never eligible Artifact fields.

## 8. Compatibility boundary

- Task protocol v1 remains the text-only compatibility floor.
- Task protocol v2 adds explicit ordered input parts and attachment descriptors.
- Version negotiation chooses one highest common version.
- A known v2 peer is sent only v2 Task payloads; Teti does not duplicate the
  same request as v1.
- The Application Envelope remains version 1. New Task semantic objects are
  carried as typed payloads within that existing envelope.

## 9. Attachment safety boundary

Image bytes never enter the JSON Application Envelope. Chatmail carries them as
file messages through the official DeltaChat attachment API. Envelopes carry
only bounded descriptors and cryptographic digests.

Runtime staging uses a private profile directory, generated names, atomic
writes, MIME sniffing, byte/pixel limits, SHA-256 verification, TTL cleanup and
per-task quotas. A receiver cannot approve a Task until every declared part is
present and verified. Orphan and expired parts are removed without touching the
Chatmail account database or user source files.

## 10. Task Inbox ordering

1. incoming requests awaiting approval, earliest expiry first
2. working tasks, most recently updated first
3. outgoing requests awaiting approval, most recently updated first
4. terminal tasks, terminal timestamp descending

The list endpoint returns bounded summaries. Full input and Artifact details are
loaded only for the selected Task.

## 11. Completion gate

0.1.12 is complete only when:

- a real qualified Adapter advertises and safely consumes image input;
- two isolated Runtime/profile instances complete text and image-input tasks
  online and after offline delivery;
- duplicate, reordered, oversized, corrupted and expired attachment messages
  fail closed;
- approval, rejection, cancellation, execution and Artifact delivery survive
  Runtime and Desktop restarts;
- existing 0.1.11 text Task and Passport behavior remains compatible.
