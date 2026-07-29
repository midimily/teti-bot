# Teti Beta 0.2.7 — Osaurus Native Child Agent

Status: implementation landed; source verification is green. Physical two-Mac
acceptance remains pending. The official Osaurus request-body Insights policy
still blocks production Readiness and is not bypassed.

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

The user creates a dedicated Agent in Osaurus, turns off Tools, Osaurus Memory,
Autonomous Exec and Host Workspace, then saves its UUID in Teti Settings. Teti
stores only that UUID in owner-only `osaurus-native-child.json`. An optional
`TETI_OSAURUS_NATIVE_AGENT_ID` launch override takes precedence and rejects UI
mutations.

Readiness requires all of the following:

1. the current loopback listener belongs to the signed canonical Osaurus app;
2. the fixed custom Agent JSON is a regular, bounded file under the local
   Osaurus Agent store and its UUID matches;
3. `toolsEnabled == false`, `memoryEnabled == false`, Autonomous Exec is absent
   or explicitly disabled, and both Host Workspace fields are absent;
4. the Agent has a fixed configured model;
5. `GET /agents/{id}` agrees on ID, custom-Agent status, effective model and
   update time;
6. the request-body retention policy is verifiably disabled.

Osaurus currently does not expose the four authority switches through
`GET /agents/{id}`. Teti therefore combines signed Runtime/API evidence with a
local read-only policy audit of the authoritative Agent record. Missing or
unknown fields fail closed. Teti never changes Osaurus configuration.

The Agent record digest is captured in a local execution spec, re-audited before
every request, and watched for changes. A change removes the Connector and its
Passport offer immediately, cancels queued/in-flight work for that Connector,
and requires fresh qualification.

## Authority intersection

The effective permission is the intersection of:

- the one-time Teti `ExecutionAuthority`;
- the Native Child descriptor (`text` only, concurrency one, bounded context,
  no checkpoint/resume);
- the audited Osaurus provider authority, whose Tools, Memory, Host Workspace
  and Autonomous Exec decisions must all be `deny`.

The provider authority is exact-key validated again at Transport launch. A
caller cannot add tools, select another Agent or model, supply a provider token,
or turn a Teti Workspace grant into a host-folder mount.

## Workspace, Memory and transport

`bounded_context` is distinct from a direct Workspace Snapshot mount. The Host
creates its private Snapshot, selects at most 16 UTF-8 source/text files, limits
each file to 16 KiB and the whole selection to 64 KiB, and serializes relative
paths plus content into a reference-data envelope. The Child sees no local
path. The Snapshot is discarded without commit because this initial Native
Child is text-output only.

Teti-managed 0.2.6 Memory can be selected independently and remains labeled as
untrusted historical reference data. Osaurus provider-native Memory stays off
because its writes, retrieval and deletion are not yet auditable through the
provider API.

`OsaurusAgentTransport` sends exactly one streaming request to the fixed
`/agents/{id}/run` path with a user message, `stream: true`, `tools: []` and
`tool_choice: none`; it omits a model so Osaurus applies the Agent's configured
model. Redirects, non-loopback sockets, listener/PID changes, authority digest
changes, tool-call frames and malformed SSE fail closed. Closing the HTTP
stream is the cancellation mechanism and maps to the existing Teti Task and
Durable Execution states.

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

## Gate status

- Runtime Child and Native Child distinction: covered by core/Passport tests.
- configuration change invalidates Readiness: file audit, digest and Host
  unregister tests landed.
- Tools/Memory/Workspace/Autonomous authority bypass: exact deny audit and
  launch validation landed.
- long task state mapping: existing Durable Execution state/epoch path is used;
  Native declares non-resumable Cancel semantics.
- no direct Osaurus-to-Peer channel: not representable in Connector or
  Transport inputs.
- official Insights request-body retention: **blocked**, intentionally prevents
  production registration.
- physical two-Mac run/cancel/restart acceptance: pending.
