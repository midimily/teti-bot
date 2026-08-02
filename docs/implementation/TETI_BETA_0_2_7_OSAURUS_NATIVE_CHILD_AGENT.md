# Teti Beta 0.2.7 — Osaurus Native Child Agent

Status: implementation landed; source verification is green. Physical two-Mac
acceptance remains pending. The official Osaurus request-body Insights policy
is now an explicit local-owner risk for Native Child rather than a hidden
Readiness blocker.

## Outcome

Beta 0.2.7 adds a provider-native Child without treating Osaurus itself as a
remote collaboration peer:

```text
Teti Host Agent
  -> Osaurus Native Child Proxy
  -> Osaurus Agent Connector
  -> OsaurusAgentTransport
  -> POST /agents/{fixed-agent-id}/run
  -> Osaurus Native Agent
```

`Osaurus Runtime (Bonsai)` remains a `runtime_facade`; `Osaurus Native Agent
(Teti)` is a separate `native_agent`. They use different Child IDs, Connector
IDs, Transport kinds, resource bindings, Compute Offer IDs and Passport names.

## Local setup and Readiness

The user creates a dedicated Agent in Osaurus and saves its UUID in Teti
Settings. Teti preserves the Agent's local Tools, Osaurus Memory and Autonomous
Exec choices instead of rewriting or rejecting them. Direct Host Workspace
mounting remains unsupported. Teti stores only that UUID in owner-only
`osaurus-native-child.json`. An optional
`TETI_OSAURUS_NATIVE_AGENT_ID` launch override takes precedence and rejects UI
mutations.

Readiness requires all of the following:

1. the current loopback listener belongs to the signed canonical Osaurus app;
2. the fixed custom Agent JSON is a regular, bounded file under the local
   Osaurus Agent store and its UUID matches;
3. Tools, Memory and Autonomous Exec have explicit readable local states, and
   both Host Workspace fields are absent;
4. the Agent has a fixed configured model;
5. `GET /agents/{id}` agrees on ID, custom-Agent status, effective model and
   update time;
6. the request-body retention policy can be determined. `unknown` still fails
   closed; the known official in-memory Insights retention is surfaced as an
   accepted risk.

Osaurus currently does not expose the authority switches through
`GET /agents/{id}`. Teti therefore combines signed Runtime/API evidence with a
local read-only audit of the authoritative Agent record. Missing or malformed
states fail closed, but enabled Tools, Memory and Autonomous Exec are recorded
rather than rejected. Teti never changes Osaurus configuration.

The Agent record digest is captured in a local execution spec, re-audited before
every request, and watched for changes. A change removes the Connector and its
Passport offer immediately, cancels queued/in-flight work for that Connector,
and requires fresh qualification.

## Authority intersection

The effective permission is the intersection of:

- the one-time Teti `ExecutionAuthority`;
- the Native Child descriptor (`text` only, concurrency one, bounded context,
  no checkpoint/resume);
- the observed Osaurus provider configuration. Tools, Memory and Autonomous
  Exec may remain enabled; direct Host Workspace access remains disabled.

The provider configuration is exact-key validated again at Transport launch.
A caller cannot select another Agent or model, supply a provider token, or turn
a Teti Workspace grant into a host-folder mount. Provider-native Tools, Memory
and autonomous side effects are explicitly accepted local-owner policy in this
Beta and are not yet controlled or audited by Teti.

The same local-owner policy applies to the official Osaurus Insights ring for
Native Child only. Teti continues to send `X-Persist: false`, exposes the known
retention in Settings and local diagnostics, and records
`OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED`; it does not mislabel the Agent as
fully private. If the installed Runtime's retention behavior cannot be
determined, qualification still blocks with
`OSAURUS_INSIGHTS_POLICY_UNVERIFIED`. The separate 0.2.3 Runtime Facade keeps
its original strict retention gate.

## Workspace, Memory and transport

`bounded_context` is distinct from a direct Workspace Snapshot mount. The Host
creates its private Snapshot, selects at most 16 UTF-8 source/text files, limits
each file to 16 KiB and the whole selection to 64 KiB, and serializes relative
paths plus content into a reference-data envelope. The Child sees no local
path. The Snapshot is discarded without commit because this initial Native
Child is text-output only.

Teti-managed 0.2.6 Memory can be selected independently and remains labeled as
untrusted historical reference data. Osaurus provider-native Memory may remain
enabled, but its writes, retrieval and deletion are not yet auditable through
the provider API; this is a documented residual risk rather than a Readiness
blocker.

`OsaurusAgentTransport` sends exactly one streaming request to the fixed
`/agents/{id}/run` path with a user message and `stream: true`; it omits model
and tool overrides so Osaurus applies the Agent's local configuration.
Redirects, non-loopback sockets, listener/PID changes, configuration digest
changes, unsupported output frames and malformed SSE fail closed. Closing the
HTTP stream is the cancellation mechanism and maps to the existing Teti Task
and Durable Execution states.

The `/run` endpoint is connection-bound, not a detached resumable provider job.
This Connector therefore truthfully declares Cancel only. Teti's local
ExecutionHandle still maps queued, running, completed, failed and canceled
states, while Pause, Resume and Checkpoint remain false.

## Passport and collaboration

The Native Child publishes only a privacy-minimized `native_agent`,
receiver-local, text-only, concurrency-one, allow-once Compute Offer after
qualification. Agent UUID, model, endpoint, port, policy digest, local record,
Workspace content and provider configuration never enter Passport or Task.

The remote Peer chooses the abstract capability. The receiver resolves it to
the fixed local Agent only after Allow Once. Osaurus never receives Peer Teti
identity, Chatmail state, Passport state or a callback address, so it cannot
communicate directly with the remote Teti.

## Peer Passport clipping correction

The 0.2.6 semantic-render fix exposed an older timing dependency: window height
was measured two animation frames after expansion, before the 180 ms CSS grid
transition reached its final geometry. The removed periodic Task render had
previously hidden this by causing a later remeasurement.

0.2.7 measures initially, again on the exact `grid-template-rows`
`transitionend` (with a bounded fallback), and once more after the native Tauri
resize resolves. This preserves the non-flashing semantic render while keeping
the final Passport content visible above the screen bottom.

## 0.2.7 field stability corrections

Two-peer inspection confirmed that the local Chatmail history contained valid
incoming and outgoing schema-4 Passport messages and that the current parser
projected the incoming resources, Agents, capabilities and bindings correctly.
The missing Peer
Passport was therefore not a sharing-policy or wire-protocol failure. The UI
controller had coupled the required `passport.get` read to the optional local
Agent-observation and Osaurus-settings reads with one fail-fast aggregation. A
failure in either local-only request discarded the already valid Peer Passport
snapshot.

The Passport poll is now an independent critical path. Local Agent and Osaurus
settings refresh through a separately guarded, failure-tolerant read that can
neither suppress the Peer snapshot nor block the next three-second Passport
poll. A regression test forces both optional reads to fail and verifies that a
fresh remote Passport still reaches presentation state.

The two toolbar panels now derive their maximum scroll height from the real
header anchor, panel gap and bottom safety margin, including the notch-specific
header position. This replaces the incorrect viewport-only allowance that let
the bottom one or two lines extend beyond the native window.

Settings treats Agent discovery as positive-evidence inventory: only an Agent
reported installed or running is listed. Unknown and not-installed detector
definitions remain internal. The Osaurus Native configuration unit is rendered
only after the local observer positively identifies Osaurus as installed or
running; this changes no Connector qualification or security rule.

## Gate status

- Runtime Child and Native Child distinction: covered by core/Passport tests.
- configuration change invalidates Readiness: file audit, digest and Host
  unregister tests landed.
- Native provider defaults: Tools/Memory/Autonomous states are recorded and
  accepted; direct Host Workspace mounting and remote configuration mutation
  remain rejected. Provider-native side-effect audit is future work.
- long task state mapping: existing Durable Execution state/epoch path is used;
  Native declares non-resumable Cancel semantics.
- no direct Osaurus-to-Peer channel: not representable in Connector or
  Transport inputs.
- field stability: optional local settings failure cannot hide a valid Peer
  Passport; absent Agents and absent Osaurus are not rendered in Settings;
  toolbar panel bounds are covered by controller, view-model and CSS contract
  tests.
- official Insights request-body retention: **accepted Native-only local-owner
  risk**, visible in Settings and diagnostics; an unknown policy still blocks.
- physical two-Mac run/cancel/restart acceptance: pending.
