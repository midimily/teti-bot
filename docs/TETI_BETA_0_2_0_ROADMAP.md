# Teti Beta 0.2 Roadmap

Status: 0.2.1 Host/Child Agent Core implemented; automated release verification complete; physical two-Mac sign-off pending

Current application version: `0.2.1`

## Release history clarification

The public product line did not land Beta 0.1.6, 0.1.7, or 0.1.8. Work once
described as 0.1.9–0.1.12 was folded into the Beta 0.1.13 product baseline rather
than shipped as separate product releases. The effective sequence for this
roadmap is therefore 0.1.5 → 0.1.13 → 0.1.14 → 0.1.15 → 0.2.0 → 0.2.1.

## 0.2 product direction

Teti will converge on a Runtime-owned Agent collaboration kernel:

- Teti remains the collaboration, trust, scheduling, consent, and audit plane.
- Codex and CodeBuddy continue through controlled local CLI Connectors backed
  by `ProcessTransport`.
- Osaurus is the first local-model Runtime target in the 0.2 line.
- Provider-specific units implement one internal Agent Connector contract instead
  of leaking CLI, HTTP, or model-specific concepts into collaboration Tasks.
- Workspace, durable task state, memory references, Skill references, and
  asynchronous continuation are introduced as Teti-owned contracts before Teti
  grows into a fuller primary Agent.
- Additional open-source Agents are planned for Beta 0.3, after the internal
  contract and Osaurus path are proven.

## 0.2.0 — Breaking Collaboration Baseline

Goal: close the 0.1 line and establish an intentionally incompatible baseline.

Implemented:

- application version `0.2.0`, Application Envelope v2, collaboration epoch 2;
- Task transport accepts and advertises only Task protocol v4;
- network Passport accepts and advertises only Callable Passport schema 3;
- no speculative Task or Passport downgrade for an unknown Peer;
- 0.1 application traffic is never dispatched to Task, Passport, or other
  application handlers;
- bounded legacy-envelope header inspection classifies a confirmed 0.1 Peer as
  reachable but `需要升级`, independently from Online/Checking/Offline;
- Profile/Store v2 uses `~/.teti/store-v2` and a root `profile.json` manifest;
- identity, Chatmail account/contact data, confirmed connections, sharing
  settings, and Agent detector preferences are copied once into Store v2;
- old Tasks, attachments, messages, Peer capability state, and connections are
  copied to read-only `~/.teti/legacy-0.1` and never enter executable state;
- active v2 Task, message-replay, and Peer-protocol stores start empty;
- per-image local diagnostics record expected, sent, stored, acknowledged,
  expired, and failed states without exposing local paths;
- incomplete image sets cannot be approved, executed, or reported complete.

Compatibility policy:

- 0.2 does not support a 0.1 wire-compatibility mode.
- 0.2 never sends Application Envelope v1, Task v1–v3, or Passport v1/v2.
- A confirmed 0.1 Peer is shown as `需要升级`; it is not misreported as offline.
- Connection handshakes remain a separate trust-layer contract so identity and
  confirmed relationships can migrate, but application collaboration begins
  only after both Peers prove epoch 2.

Known-defect waiver:

- `KD-0.1.15-MULTI-IMAGE-DELIVERY`: on physical dual-Mac collaboration, Tasks
  with 2 or 4 images have historically had a high incomplete-delivery rate;
  one-image delivery is usually successful.
- 0.2.0 temporarily waives the physical completion-rate gate only. It does not
  waive integrity, isolation, idempotency, authorization, or execution gates.
- Missing images must remain visible as X/Y, remain non-actionable, and retry
  only their own attachment IDs. Hash mismatch, cross-Task attachment binding,
  duplicate false counts, incomplete execution, and false completion are
  release blockers.
- The completion-rate defect is re-tested and reviewed after both Macs have
  completed one 0.2 upgrade cycle.

Release gates:

1. 0.1.15 single-image result actions, picker stability, composer eligibility,
   and reachability regressions pass; the multi-image rate is handled only by
   the explicit waiver above.
2. Two 0.2.0 Macs establish epoch-2 Presence and collaborate normally.
3. A confirmed 0.1 Peer remains reachable, is labeled `需要升级`, and receives
   no Task or Passport from 0.2.
4. 0.1 Application Envelopes and historical Passport/Task contracts are
   rejected before business dispatch.
5. Migrated 0.1 Tasks cannot be executed or imported into active Task state,
   including after restart or repeated migration.
6. Codex and CodeBuddy Adapter qualification, timeout, cancellation, bounded
   output, login recovery, and Artifact tests remain green.
7. App and DMG build, signing verification, install launch, and two-Mac physical
   acceptance complete.

## 0.2.1 — Host/Child Agent Core

Goal: freeze one local Agent integration framework and migrate the already
working Codex and CodeBuddy paths without adding a provider.

Implemented:

- `TetiHostAgent` owns local authorization, execution state, isolated task
  workspaces, Transport selection, cancellation, timeout, output limits,
  Artifact projection, and cleanup;
- `LocalChildAgent` is a Host-owned aggregate of one local Agent and its
  registered Connectors and resource bindings;
- `AgentConnector` contains only provider-specific invocation and output
  decoding; its context excludes task text, Execution Authority, Passport,
  Chatmail, and peer identity;
- `ExecutionTransport` is selected by the Host from a local-only execution
  specification;
- `ExecutionAuthority` is short-lived, exact-input-bound, and single-use. The
  Host validates and consumes it before any Connector or Transport starts;
- `AgentResourceBinding` binds Child Agent, Connector, Transport kind, and
  curated capabilities without entering Task or Passport;
- `ProcessTransport` retains detached process-group termination, TERM/KILL
  escalation, minimal environment, stdin delivery, timeout, and bounded output;
- `FakeTransport` provides deterministic in-memory contract tests;
- `LoopbackHttpTransport` is reserved but explicitly disabled and performs no
  HTTP in 0.2.1;
- Codex text and Codex image execution are migrated to Codex Connectors;
- CodeBuddy text execution is migrated to a CodeBuddy Connector;
- no new vendor is qualified or advertised.

Release gates:

1. Codex text and image pipelines complete through Connector +
   `ProcessTransport` with no Artifact regression.
2. CodeBuddy text completes through Connector + `ProcessTransport` with no
   qualification or output regression.
3. Cancellation, timeout, detached process-group cleanup, shutdown cleanup,
   combined stdout/stderr limits, and safe error projection remain green.
4. Connector source imports no Passport, Chatmail, or connection module, and
   Connector context carries no peer identity or authorization object.
5. Task and callable Passport projections contain no Transport kind,
   executable, arguments, environment, or workspace path.
6. Reused, expired, target-mismatched, or input-mismatched
   `ExecutionAuthority` is rejected before execution.
7. The accepted multi-image physical-delivery defect remains visible and
   fail-closed; it is not silently reclassified as fixed by this refactor.

## Planned follow-on versions

### 0.2.2 — Workspace and durable collaboration identity

- introduce a Teti-owned Workspace ID and bounded Workspace manifest;
- bind Task, Artifact, memory reference, and asynchronous continuation to the
  Workspace without allowing a remote Peer to choose a local filesystem path;
- define cleanup, retention, ownership, and migration rules.

### 0.2.3 — Osaurus local Runtime Adapter

- integrate Osaurus as a native Agent Runtime rather than treating a chat
  completion endpoint as Teti's architectural center;
- prefer the Osaurus Agent/CLI execution route where it preserves Agent
  lifecycle, tool policy, cancellation, and progress semantics;
- use `/v1/chat/completions` only as a bounded model-inference surface beneath
  the Connector when a task genuinely needs model completion rather than Agent
  behavior.

### 0.2.4 — Memory and Skill foundations

- add explicit, permissioned memory references scoped to Workspace and Task;
- add Skill identity/version/reference contracts without transporting arbitrary
  executable Skill content across Peers;
- define provenance, expiration, revocation, and disclosure boundaries.

### 0.2.5 — Long-running asynchronous collaboration

- durable checkpoints, retry policy, pause/resume, cancellation propagation,
  progress snapshots, and crash recovery;
- bounded concurrency and scheduling owned by Teti Runtime;
- no unattended reusable execution grant by default.

### 0.2.6 — 0.2 stabilization

- complete the post-upgrade multi-image review;
- run the full compatibility, migration, restart, security, and physical Mac
  matrix;
- freeze the internal Connector, Workspace, Task, memory-reference, and Skill-
  reference contracts for the Beta 0.3 open-source Agent expansion.
