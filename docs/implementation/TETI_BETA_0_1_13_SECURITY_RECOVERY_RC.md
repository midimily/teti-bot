# Teti Beta 0.1.13 — Security, Recovery and RC

Status: implemented; physical two-Mac sign-off pending

Application version: `0.1.13`

Implemented on: 2026-07-26

## Outcome

Beta 0.1.13 hardens the 0.1.12 collaboration loop without changing Application
Envelope version 1, Task protocol versions 1/2, Chatmail, Registry, account
lifecycle, Passport sharing consent or the allow-once permission boundary.

The source and automated dual-Runtime candidate passes the RC engineering
matrix below. The release remains a controlled ad-hoc Alpha until the same DMG
passes the physical two-Mac checklist. RC in this document means a code
candidate for Beta 0.2.0; it does not mean Developer ID signing, notarization or
public macOS distribution.

## Recovery and security matrix

| Scenario | Frozen behavior | Automated evidence |
| --- | --- | --- |
| Duplicate request | Same `(requesterTetiId, taskId)` and immutable body creates one record; conflicting reuse fails closed | Two isolated `PeerConnectionRuntime` instances and in-memory Chatmail relay |
| Out-of-order status | Highest monotonic revision wins; completed/failed/canceled/rejected cannot regress | Working/completed delivery order reversed |
| Out-of-order receipt | Older receipt cannot erase a newer conflict/rejection; forged future receipt is isolated | Receipt order reversed and future timestamp injected |
| Runtime crash | Persisted incoming `working` state becomes failed with `TASK_RUNTIME_RESTARTED`; requester receives the terminal update | Runtime reconstructed over the same Task and connection stores |
| Agent exit | Unexpected process termination returns `ADAPTER_EXIT_NONZERO`, emits no partial Artifact, reaps the process and removes its isolated workspace | Fake Agent kills itself during Kernel execution |
| Authentication expiry | Adapter maps local-login expiry to `ADAPTER_AUTH_REQUIRED`; user logs in locally and explicitly allows once again | First execution fails auth, second explicit approval completes |
| Task expiry | Offline and `auth_required` Tasks obey the original absolute TTL | Deterministic clock advances beyond TTL |
| Malicious payload | Envelope is capped at 128 KiB before JSON parse; top-level fields and payloads are allowlisted; later valid messages still process | Oversized raw message followed by valid presence in one poll |
| Old Teti | Known Task-v1 peer receives a text-only v1 request and schema-v1 text Artifact; images require v2 | Peer capability store fixed to `[1]` |
| Adapter timeout/cancel | Kernel bounds time, combined output, concurrency, process group and isolated workspace lifetime | Fake-Agent timeout, cancellation and output-limit tests |

No test inspects or creates a real Chatmail account, mutates Registry data, or
depends on a repository path inside the packaged Runtime.

## Authentication UX

An Agent authentication error is not presented as an opaque permanent failure.
The receiving Task is shown as `Agent 需要登录`, explains that Teti does not
store credentials, and offers `登录后重试一次`. That action is still a new
single-use local grant. It is unavailable after the Task expires.

## Compatibility freeze

- Application Envelope stays at version 1.
- Task versions stay `[1, 2]`; no speculative protocol version is advertised.
- Passport schema 1/2 are receive-only compatibility; outgoing Passport uses
  schema 3 exclusively. Presence advertises `passportSchemaVersions: [3]`, and
  the Peer capability is persisted independently from the latest snapshot.
- Unknown old applications may safely ignore unsupported Task message types.
- Known v1 Task peers use text only; no image descriptor or image byte is sent.
- Strict top-level Envelope validation applies to version 1. A future envelope
  extension therefore requires an explicit version review, not silent fields.

## Post-RC P0 reliability corrections (version remains 0.1.13)

The first physical task test exposed delivery and UI defects that were fixed on
the same 0.1.13 reliability line before image-result support was versioned:

- the composer DOM is no longer rebuilt by the two-second Runtime refresh, so
  the instruction field keeps focus and selection;
- Chatmail messages are marked seen only after their validated payload is
  durably stored; transient failures remain retryable with a bounded poison
  message limit;
- Artifacts arriving before a local Task record are deferred instead of
  discarded, and delayed Artifacts can be applied after a completed status;
- the requester distinguishes `completed` from `result receiving` while an
  Artifact is still in transit;
- Task headings use the confirmed Peer nickname and exact local timestamp.

These corrections do not change Task protocol 1/2 or add image output. Reliable
image output is the separately versioned 0.1.14 Task-v3 feature.

## Physical two-Mac RC checklist

Use the generated `Teti-0.1.13-arm64-macos15-adhoc-alpha.dmg` on two Apple
Silicon Macs running macOS 15 or later. Prefer separate test macOS users. Keep
quarantine enabled and use System Settings > Privacy & Security > Open Anyway;
never disable Gatekeeper or remove quarantine with `xattr`.

1. Verify the supplied SHA-256 on both Macs, mount the DMG and drag Teti to
   Applications.
2. Confirm each App reports version 0.1.13 and starts its embedded Node,
   lifecycle Runtime and DeltaChat RPC without global Node or a source checkout.
3. Confirm neither existing profile creates a duplicate Teti/Chatmail identity
   after upgrade, quit/relaunch or Mac restart.
4. Establish or load one Confirmed connection and enable Passport sharing only
   where the test requires it.
5. Mac A sends a text Task while Mac B is online. Mac B reviews all input,
   allows once, and Mac A receives working then a bounded completed Artifact.
6. Repeat with one explicitly selected PNG/JPEG input and verify the receiver
   preview before approval. Do not use private test material.
7. Leave Mac B offline, send from A, then start B before TTL. Verify exactly one
   pending request appears and A later receives an acknowledgement.
8. Send another Task and quit B while it is working. Relaunch B and verify both
   sides converge to `TASK_RUNTIME_RESTARTED`, without silent re-execution.
9. Start a Task with the selected Agent logged out or expired. Verify B shows
   the local-login instruction, then log in using the Agent itself and choose
   allow once again. Confirm no credential appears on A.
10. Cancel a submitted or working Task and verify both sides converge without a
    late Artifact changing the terminal state.
11. If a retained 0.1.11/0.1.12 test Mac is available, verify connection and
    Passport remain usable. For a known Task-v1 fixture, verify text-only Task
    completion; do not expect image Task support from an old peer.
12. Quit both Apps and confirm Node, lifecycle and DeltaChat child processes
    terminate. Re-run App `codesign --verify --deep --strict` to ensure no file
    was written into either App bundle.

Record App version, macOS version, Teti IDs, Task IDs, timestamps, state shown on
each side, and sanitized Runtime/Console errors for every failure. Never include
task text, credentials, source files or private image content in the report.

## Release gate

Automated source verification and DMG packaging are necessary but not the final
two-device claim. Beta 0.2.0 promotion requires the checklist above to pass on
two physical Macs, including offline delivery, Runtime restart, local-auth
recovery and install-from-DMG behavior.

The 0.1.13 DMG is arm64, macOS 15+, ad-hoc signed and not notarized. It is for
controlled testing only and must not be described as Gatekeeper-trusted or as an
Apple Developer ID release.
