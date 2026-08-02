# Teti Beta 0.2 Roadmap

Status: 0.2.10 Security and Recovery RC automated gates landed; current official
Osaurus Insights retention and an untrusted local Osaurus signature remain
release blockers for Osaurus publication, and physical two-Mac sign-off remains
pending

Current application version: `0.2.10`

## Release history clarification

The public product line did not land Beta 0.1.6, 0.1.7, or 0.1.8. Work once
described as 0.1.9–0.1.12 was folded into the Beta 0.1.13 product baseline rather
than shipped as separate product releases. The effective sequence for this
roadmap is therefore 0.1.5 → 0.1.13 → 0.1.14 → 0.1.15 → 0.2.0 → 0.2.1 → 0.2.2 → 0.2.3 → 0.2.4 → 0.2.5 → 0.2.6 → 0.2.7 → 0.2.8 → 0.2.9 → 0.2.10.

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

## 0.2.2 — Collaboration Workspace v1

Goal: give Agent collaboration, long-running Tasks, future Memory, and Artifact
work a stable Teti-owned container without exposing either Mac's filesystem.

Implemented:

- `ephemeral_task` and `durable_collaboration` Workspace modes;
- Workspace schema v1 with ID, owner, participants, revision, quota, retention,
  bounded manifest, and timestamps;
- Task protocol v5, which can request a temporary Workspace or reference an
  already confirmed Workspace ID/revision using only abstract access rights;
- ExecutionGrant v2 and ExecutionAuthority v2 bind the approved Workspace ID,
  revision, and `read` / `write` / `create_artifact` access;
- each Child Agent runs inside a private Workspace Snapshot; successful writes
  commit as a new revision, while stale concurrent revisions fail closed;
- committed trees reject traversal paths, symlinks, unsupported file types,
  byte quota violations, and file-count quota violations;
- ephemeral Workspaces use TTL and are removed after a Runtime crash/restart;
- durable Workspaces and their manifests are verified and recovered after
  restart;
- the lifecycle `task.send` boundary validates abstract Workspace requests and
  rejects path-like extension fields;
- AI Passport and Settings panels are anchored to their own toolbar icon, with
  each panel's top-right edge aligned to the clicked icon's horizontal center.

Explicitly unsupported in v1: `external_user_folder`, `arbitrary_host_path`,
and `remote_path`.

Release gates:

1. Absolute paths, traversal segments, path extension fields, and symlink
   escapes are rejected before commit or execution.
2. Workspace byte/file quotas and ephemeral TTL cleanup pass.
3. Runtime restart removes crashed ephemeral state and recovers durable state.
4. Concurrent Snapshots cannot overwrite a newer revision.
5. Task, Passport, ExecutionGrant, and network envelopes contain no local
   Workspace Snapshot path.
6. Codex, CodeBuddy, cancellation, timeout, process cleanup, output bounds,
   image delivery, and Artifact behavior remain green on Task v6.

## 0.2.3 — Osaurus Local Runtime Child

Goal: add the first `LocalService` Child Agent on the 0.2 Host/Child framework,
using Osaurus only as a bounded local model Runtime facade.

Implemented:

- `Osaurus Runtime Child -> Osaurus Connector -> LoopbackHttpTransport ->
  /v1/chat/completions -> Bonsai`;
- the Child origin is explicitly `runtime_facade`; its Passport name is
  `Osaurus Runtime (Bonsai)`, never `Osaurus Native Agent`;
- text-only input/output, fixed `OsaurusAI/Bonsai-27b-1bit-JANG`, empty tools,
  no Agent header, no Osaurus Memory, no Osaurus Agent Prompt, and no Host
  Workspace;
- per-Child concurrency is one, independently of the Host's global concurrency;
- Teti only discovers an already-running Osaurus instance and never starts,
  downloads, configures, or modifies it;
- only exact IPv4 loopback URLs are accepted; redirects, hostname aliases,
  credentials, query strings, fragments, LAN exposure, and socket reuse are
  rejected;
- shared configuration is rebound to the live listener PID, canonical
  `Osaurus.app` path, Bundle ID, Developer Team ID, code-directory hash, and the
  owner of the exact established TCP connection before a request body is sent;
- strict, bounded SSE is atomically committed only after a valid finish reason
  and `[DONE]`; malformed or tool-bearing streams return no partial Artifact;
- cancellation destroys request, response, and socket; the accepted Osaurus
  baseline cancels request Tasks when the channel closes;
- model absence, load failure, insufficient memory, inference saturation/503,
  malformed SSE, untrusted Runtime, and unavailable Runtime have distinct safe
  error mappings.

Release blocker:

- the reviewed official Osaurus source captures the decoded
  `/chat/completions` request body and submits it to its 500-entry in-memory
  `InsightsService` ring buffer;
- `X-Persist: false` disables chat-history persistence only and does not disable
  Insights request-body retention;
- there is no public, per-request, verifiable opt-out in the reviewed Runtime;
- therefore production qualification returns
  `OSAURUS_INSIGHTS_BODY_RETENTION`, the Connector is not registered, and no
  callable capability enters Passport. Installed/running observation may still
  be shown separately.

Release gates:

1. Osaurus provides a documented and machine-verifiable mode in which the full
   request body is not retained by Insights, and Teti verifies that mode before
   sending task text. Teti must not silently modify Osaurus configuration.
2. A trusted, supported Osaurus build and the fixed Bonsai model pass health and
   model inventory qualification; missing or mismatched evidence fails closed.
3. A process merely occupying localhost cannot qualify: config, listener PID,
   connected socket owner, app location, Bundle ID, Team ID, and CDHash all
   agree at request time.
4. Redirect refusal, strict SSE, bounded output, concurrency one, and all safe
   error mappings pass automated tests.
5. Cancellation closes the HTTP stream and a real supported Osaurus Runtime
   returns its inference activity to baseline; this still requires physical
   Runtime sign-off.
6. Codex and CodeBuddy execution, Workspace behavior, Task collaboration, and
   Passport sharing remain green.

## 0.2.4 — Local Compute Collaboration

Goal: publish a privacy-minimized local-compute capability and let a confirmed
Peer request receiver-local Osaurus/Bonsai text work through explicit
allow-once approval.

Implemented:

- Callable Passport schema 4 and an exact `general-text-assistance` Compute
  Offer with `local_model`, `receiver_local`, text-only I/O, concurrency one,
  and `allow_once`;
- Host-registered offer provenance; Agent observation or naming cannot create
  an offer;
- exact `offerId + capability` receiver resolution to the local Connector;
- no remote Runtime, model, port, path, hardware, credential, or configuration
  selection;
- no Host Workspace for the Runtime facade;
- concurrency one plus an eight-task receiver-local queue, queued
  cancellation, bounded overflow, and shutdown cleanup;
- per-execution Osaurus re-qualification and startup retry without auto-start
  or configuration mutation;
- `本地算力` UI labeling and no `免费算力` claim.

Release status and the complete gate matrix are recorded in
[`implementation/TETI_BETA_0_2_4_LOCAL_COMPUTE_COLLABORATION.md`](implementation/TETI_BETA_0_2_4_LOCAL_COMPUTE_COLLABORATION.md).
The current Insights retention and invalid local Osaurus signature keep real
two-Mac acceptance blocked; no bypass is permitted.

## 0.2.5 — Durable Async Execution v1

Goal: establish a restart-queryable, cancelable long-running execution base
without silently replaying external side effects.

Implemented:

- receiver-local `ExecutionHandle` schema v1 with Task, Workspace, Child,
  Connector, epoch, lease, progress, provider ID, checkpoint, and resume state;
- durable mode-`0600` handle persistence and startup reconciliation;
- explicit Connector declarations for Progress, Pause, Resume, Checkpoint, and
  Cancel, plus pure-compute versus possible-side-effect semantics;
- checkpoint restart only for Workspace-pure work with an explicit contained
  checkpoint; current production Connectors truthfully remain non-resumable;
- resume mints a new one-time authority and increments `executionEpoch`;
- stale completion, cancellation, checkpoint, and Artifact callbacks cannot
  update a newer epoch;
- local UI query and explicit resume controls without exposing provider IDs or
  checkpoint paths to a Peer;
- semantic Passport presentation diffing prevents periodic polling from
  flashing an unchanged expanded connection detail.

The full implementation and gate matrix are recorded in
[`implementation/TETI_BETA_0_2_5_DURABLE_ASYNC_EXECUTION_V1.md`](implementation/TETI_BETA_0_2_5_DURABLE_ASYNC_EXECUTION_V1.md).

## 0.2.6 — Child Agent Memory v1

Goal: give local Child Agents controlled, auditable long-term context without
depending on provider-native Memory or enabling Peer-shared Memory.

Implemented:

- Teti-owned Task, Workspace and Child Agent scope policy; Task context remains
  execution-only while both durable scopes default to disabled;
- exact local authorization followed by a separate save action on a completed
  receiver-local text Artifact; no peer or completion event can auto-write;
- schema-v1 private records with Task, Peer, Workspace, Child, digest, expiry
  and visible local-user provenance;
- strict Workspace/Child isolation, 90-day expiry, deletion, authorization
  revocation and owner-only JSON export;
- authoritative-store retrieval with no stale v1 index, at most four records,
  4 KiB per record and 8 KiB total injection;
- Host-owned reference-data envelope injection; Connector context and all peer
  protocols remain Memory-free;
- Task-poll semantic diffing fixes the remaining expanded Peer Passport flash
  caused by the global renderer's two-second timestamp-only refresh.

The complete contract and gate matrix are recorded in
[`implementation/TETI_BETA_0_2_6_CHILD_AGENT_MEMORY_V1.md`](implementation/TETI_BETA_0_2_6_CHILD_AGENT_MEMORY_V1.md).

## 0.2.7 — Osaurus Native Child Agent

Goal: connect a dedicated, fixed Osaurus Agent through `/agents/{id}/run` while
preserving Teti-owned collaboration, Workspace, durable execution and Memory
contracts.

Implemented:

- separate Runtime-facade and Native-Agent Child/Connector/Transport/Passport
  identities;
- local Settings control for the fixed Agent UUID;
- signed Runtime plus exact local Agent-policy audit and public metadata match;
- deny-only Tools, provider Memory, Host Workspace and Autonomous Exec
  authority, rechecked for every execution;
- file-change Readiness invalidation, Connector withdrawal and queued/in-flight
  cancellation;
- a Host-selected 64 KiB bounded Workspace context with no path mount;
- `/agents/{id}/run` text streaming, cancellation, strict SSE and existing
  Durable Execution state mapping;
- a privacy-minimized `native_agent` Compute Offer and allow-once receiver
  resolution;
- post-transition and post-native-resize measurement fixing Peer Passport
  bottom clipping without restoring periodic flashing;
- field-stability corrections that isolate Peer Passport polling from optional
  local settings reads, keep toolbar panels inside the native viewport, and
  hide absent Agent definitions and Osaurus-only configuration.

The complete gate matrix is recorded in
[`implementation/TETI_BETA_0_2_7_OSAURUS_NATIVE_CHILD_AGENT.md`](implementation/TETI_BETA_0_2_7_OSAURUS_NATIVE_CHILD_AGENT.md).
Official Insights request-body retention and physical two-Mac acceptance remain
release blockers.

## 0.2.8 — Long-Horizon Collaboration

Goal: upgrade one long-running invocation into a Host-owned, restart-safe
collaboration whose Child Agents each execute exactly one bounded stage.

Implemented:

- Task protocol v6 with explicit `single_stage` or `long_horizon` execution;
- receiver-local stages, Progress, Checkpoints, audit events, bounded renewal,
  pause-at-stage-boundary and user-supplied continuation input;
- durable Collaboration Workspace creation for temporary long-horizon requests,
  optimistic per-stage revision checks and stage-specific execution IDs;
- append-only intermediate Artifacts and an explicit final-Artifact decision;
- privacy-minimized peer status plus `teti.task.input`; Child bindings, audit,
  checkpoint details and provider execution identity remain receiver-local;
- explicit Child selection for continuation, including failure recovery; Teti
  never switches Child automatically;
- execution-deadline enforcement before Artifact persistence and Workspace
  commit, so expired work cannot write late output;
- desktop controls and accessible stage/audit presentation for input, pause,
  continuation, completion and one-hour bounded renewal.
- a deployed local Release Policy authority for 0.2.8 and later, independent
  from Peer compatibility and the Registry KV data plane; old Peers are
  isolated without globally freezing the current supported Host.

The full contract and gate matrix are recorded in
[`implementation/TETI_BETA_0_2_8_LONG_HORIZON_COLLABORATION.md`](implementation/TETI_BETA_0_2_8_LONG_HORIZON_COLLABORATION.md).
Release sign-off also requires the production policy smoke gate, cached-floor
offline lock test, rollback/mutation rejection, and a non-production
future-floor drill. This cannot claim retroactive self-lock for 0.2.7 or older
binaries because that client code is absent from those builds.

## 0.2.9 — Teti Host Agent Delegation Foundation

Goal: establish the product structure in which Teti owns a bounded plan and
Codex, CodeBuddy and Osaurus are local Child Agents, without introducing an
autonomous Planner.

Implemented:

- receiver-local `DelegationPlan` schema v1 with an explicit-user source,
  fixed depth one and one to four ordered Child execution steps;
- a mandatory final `Teti Host` Artifact aggregation step;
- exact local Child/Connector/Capability/Resource binding frozen into every
  step, with independent input/output budget, timeout and Workspace access;
- target re-resolution before every step so changed Readiness, binding,
  capacity or authority fails closed;
- one Child stage at a time through the existing Long-Horizon, Workspace,
  Execution Handle and Authority path;
- append-only Artifact provenance recording step, producer, Resource binding
  and committed Workspace revision;
- deterministic ordered text and image-reference aggregation, with no model
  call hidden inside Host aggregation;
- a `DelegationPlanner` interface plus a fail-closed disabled implementation;
- explicit local lifecycle methods and desktop controls for selecting the
  ordered plan; no remote message can submit a plan or local Connector field;
- failure stops the frozen plan. No next Child, fallback or re-planning occurs
  automatically.

The complete contract and gate matrix are recorded in
[`implementation/TETI_BETA_0_2_9_TETI_HOST_AGENT_DELEGATION_FOUNDATION.md`](implementation/TETI_BETA_0_2_9_TETI_HOST_AGENT_DELEGATION_FOUNDATION.md).
Task protocol remains v6 because the plan, budgets, bindings, provenance and
audit are receiver-local. The production Release Policy floor intentionally
remains `0.2.8` until a separate release promotion changes it.

## 0.2.10 — Security and Recovery RC

Goal: freeze the Beta 0.2 behavior and run one concentrated security, recovery
and migration gate without adding product features.

Implemented:

- one repeatable `test:security-recovery-rc` gate covering Codex, CodeBuddy,
  Osaurus Runtime and Native, Workspace, Child Memory, durable execution,
  Artifact handling, two-peer transport and Host delegation;
- fail-closed SHA-256 integrity verification for receiver-local checkpoints
  before every explicit resume;
- atomic private checkpoint replacement and a local Execution Handle store v2
  integrity ledger; migrated 0.2.9 handles receive no invented trust and a
  legacy checkpoint cannot resume until recaptured;
- explicit adversarial tests for checkpoint mutation, remote delegation,
  per-step budget expansion, malicious Artifact path fields and oversized
  Artifact text;
- retained proofs for non-replay of side-effecting work, execution epoch races,
  localhost PID/signature binding, bounded Osaurus concurrency/queueing,
  Workspace symlink escape, optimistic revision conflicts, Memory scope
  isolation, offline delivery and out-of-order message convergence.

No Task, Passport, Application Envelope, Connector, Compute Offer or UI feature
was added. Task remains v6, Passport remains schema 4, the collaboration epoch
remains 2 and the production Release Policy floor remains `0.2.8` pending an
explicit operator promotion.

The complete gate matrix and residual physical sign-off are recorded in
[`implementation/TETI_BETA_0_2_10_SECURITY_AND_RECOVERY_RC.md`](implementation/TETI_BETA_0_2_10_SECURITY_AND_RECOVERY_RC.md).
