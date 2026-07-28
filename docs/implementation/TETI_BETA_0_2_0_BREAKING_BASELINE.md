# Teti Beta 0.2.0 — Breaking Collaboration Baseline

Status: implemented and packaged; physical two-Mac sign-off pending

Application version: `0.2.0`

Implemented on: 2026-07-28

## Contract freeze

| Boundary | Beta 0.2.0 contract |
| --- | --- |
| Collaboration epoch | 2 |
| Application Envelope | v2 only |
| Task protocol | v4 only |
| Network Passport | schema 3 only |
| Profile manifest | schema 2 |
| Active Store | schema 2 under `~/.teti/store-v2` |
| Legacy collaboration data | read-only, non-executable `~/.teti/legacy-0.1` |

There is no 0.1 downgrade sender. Unknown Peers receive neither a Task nor a
Passport until current compatibility is explicitly observed.

## One-time migration

Migration runs while holding the profile Runtime lock and builds the active
Store in a staging directory before atomic rename. Source 0.1 data is not
mutated.

Copied into active v2 state:

- canonical Teti identity;
- Chatmail account database and local contacts;
- confirmed connections only;
- Passport sharing settings;
- Agent detector preferences.

Started empty in active v2 state:

- Application replay IDs;
- Tasks and Task Peer negotiation state;
- Task attachments;
- Peer protocol capabilities.

Copied into the legacy archive with read-only files and explicitly cleanable
owner-only directories:

- old Tasks and attachments;
- old Application replay IDs;
- old Peer protocol capabilities;
- old connection snapshot.

The v2 profile manifest is written last. Re-running migration is idempotent, and
an incomplete staged Store cannot be treated as a finished profile.

## Old-Peer behavior

A bounded outer-header inspection recognizes traffic from a confirmed
Application Envelope v1 sender. This observation may refresh reachability and
records epoch 1, but does not inspect or dispatch the payload. The UI presents:

- relationship compatibility: `需要升级`;
- independent reachability: Online, Checking, or Offline.

Task submission fails before transport with an upgrade-required error.

## Multi-image containment

Known defect: `KD-0.1.15-MULTI-IMAGE-DELIVERY`.

Beta 0.2.0 accepts that 2- or 4-image physical delivery may remain incomplete
during the first upgrade cycle. It does not accept unsafe convergence:

- each expected image has a local-only diagnostic state and attempt count;
- stored and acknowledged counts are presented as X/Y;
- missing images are scanned independently, so one present image cannot hide
  later missing images;
- approval recalculates readiness and returns `TASK_ATTACHMENTS_PENDING` until
  every descriptor has a verified durable file;
- incomplete Tasks cannot invoke an Adapter or publish completed status;
- attachment expiry records a terminal diagnostic state.

## Automated evidence

- v1 Application Envelope rejection occurs before payload dispatch;
- Passport schema 1/2 network rejection;
- no speculative Task or Passport downgrade;
- current two-Peer heartbeat and schema-3 Passport exchange;
- old Peer is reachable, labeled incompatible, and receives no Task;
- migration preserves the allowed identity/contact/connection subset and is
  idempotent;
- legacy Tasks are read-only and active Task Store starts empty;
- four-image fault injection drops two images, rejects approval at 2/4, retries
  only missing IDs, then reaches 4/4;
- Codex and CodeBuddy controlled Adapter unit/integration coverage remains part
  of the full regression suite.

## Remaining release evidence

Automated packaging evidence:

- ad-hoc signed arm64 `Teti.app`, version 0.2.0, minimum macOS 15.0;
- `Teti-0.2.0-arm64-macos15-adhoc-alpha.dmg`, 56,205,967 bytes;
- SHA-256 `b49c09bc3b2f72342e553ebf733dec0efdfa6be64f6c46b45c3aa699ad1cbdf2`;
- DMG create/verify/mount/unmount, App metadata, native inventory, deep code
  signature, bundled Node, DeltaChat RPC, lifecycle health, and repository-path
  independence checks passed;
- this controlled Alpha is ad-hoc signed, not Developer ID signed, hardened, or
  notarized, and may require macOS Privacy & Security → Open Anyway.

Remaining physical evidence:

1. Install the DMG on two Macs and confirm same-version collaboration.
2. Confirm a 0.1 Peer is explicitly shown as requiring upgrade.
3. Confirm migrated 0.1 Tasks never appear as actionable after restart.
4. Repeat single-, two-, and four-image delivery after both Macs complete one
   upgrade cycle; record the multi-image completion rate separately from the
   fail-closed integrity gate.
