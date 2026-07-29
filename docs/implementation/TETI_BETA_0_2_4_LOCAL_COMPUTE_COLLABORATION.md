# Teti Beta 0.2.4 — Local Compute Collaboration

Status: implementation and automated contract gates landed; production
Osaurus qualification and physical two-Mac acceptance remain blocked by the
external conditions listed below.

Application version: `0.2.4`

## Goal

Allow one confirmed Teti to request general text assistance from the other
Teti's receiver-local Osaurus/Bonsai runtime without learning or selecting the
receiver's endpoint, model, hardware, credential, path, or Agent configuration.

## Safe Compute Offer

Callable Passport schema 4 adds one exact, privacy-minimized offer:

```json
{
  "offerId": "local.compute.general-text-assistance.v1",
  "capability": "general-text-assistance",
  "resourceClass": "local_model",
  "executionLocation": "receiver_local",
  "inputModes": ["text"],
  "outputModes": ["text"],
  "concurrency": 1,
  "approval": "allow_once",
  "observedAt": "2026-07-29T00:00:00.000Z"
}
```

Only a Runtime-qualified, Host-registered Connector may contribute this offer.
Observation, installation, process state, or a matching Agent name is
insufficient. Unknown fields and non-exact values fail protocol validation.

The offer never carries:

- the Bonsai model ID or file path;
- the Osaurus endpoint or port;
- exact CPU, GPU, memory, or device details;
- a Runtime credential or external API token;
- a local Connector, Adapter, executable, or Agent configuration;
- an Osaurus Agent prompt, Memory, Skill, Tool, or Workspace binding.

## Receiver-owned resolution and approval

Task v5 remains the execution request envelope. The requester sends only the
advertised `offerId`, `capabilityId`, text, and abstract temporary Workspace
request. The receiver must match both offer and capability before it can mint a
single-use local Execution Grant. A legacy `capability:` alias cannot resolve
the local-compute Connector.

The receiver maps the offer to its own `OsaurusRuntimeConnector`, fixed model,
verified listener identity, and `LoopbackHttpTransport`. The compute execution
uses a synthetic path-free `workspace:none.<taskId>` grant binding and never
creates or opens a Host Workspace. A remote request for a durable Workspace is
rejected for this offer.

The UI labels this route `本地算力`. It does not use `免费算力`. Incoming tasks
remain pending until the receiver explicitly selects `仅允许一次`; rejection is
terminal and does not invoke Osaurus.

## Queue, cancellation, and recovery

- active Osaurus inference concurrency is exactly one;
- at most eight receiver-local tasks may wait in FIFO order;
- a ninth waiting task fails with a bounded busy result instead of growing
  memory without limit;
- a queued task can be canceled before any HTTP request starts;
- Runtime shutdown cancels both active and queued tasks;
- Osaurus identity, health, fixed-model inventory, and Insights policy are
  re-qualified before every execution;
- a stopped or replaced listener fails closed; a later task can bind to a newly
  qualified PID after Osaurus recovers;
- when Osaurus is absent during Teti startup, qualification is retried every 15
  seconds without starting or modifying Osaurus.

## Local-only and token boundary

Teti creates a fresh connection only to exact IPv4 `127.0.0.1`, refuses
redirects and socket reuse, and re-verifies the connected socket owner. The
request has one user text message, `stream: true`, and `tools: []`; it omits
`Authorization`, `X-Osaurus-Agent-Id`, Memory, session, Skill, prompt, and
Workspace fields. This proves that Teti itself consumes no external API token
on this route. It does not claim that arbitrary third-party Runtime code can
never perform its own egress; production qualification remains fail-closed.

## Automated gate coverage

- strict schema-4 Compute Offer validation and forbidden-field rejection;
- Host-only offer projection and exact receiver resolution;
- two-peer abstract offer delivery, allow-once execution, and text Artifact;
- concurrency one, bounded queue, queued cancellation, queue overflow, and
  shutdown cleanup;
- delayed first token as a cold-start case;
- HTTP cancellation observed as a closed server stream;
- model missing, model-load failure, insufficient memory, 503/busy, redirect,
  malformed SSE, and untrusted Runtime mappings;
- stopped Runtime rejection followed by fresh PID recovery;
- no `Authorization` header and no non-loopback Teti request path;
- Codex, CodeBuddy, Task, Passport, Workspace, and image behavior regression
  suite.

## Production blockers and physical sign-off

Two conditions remain release blockers on this development Mac:

1. The reviewed official Osaurus implementation retains the decoded request
   body in its 500-entry in-memory Insights ring. `X-Persist: false` does not
   disable that retention, so qualification returns
   `OSAURUS_INSIGHTS_BODY_RETENTION` and publishes no Compute Offer.
2. The installed `/Applications/Osaurus.app` fails strict macOS code-signature
   verification (`code or signature have been modified`). Teti reports
   `OSAURUS_RUNTIME_UNTRUSTED` and refuses the listener.

These are deliberately not bypassed. Consequently the app and DMG can be
built, and the complete collaboration path can be covered with controlled
fixtures, but the release gate “two physical Macs execute a real Osaurus text
task” cannot be signed until both Macs have a trusted Osaurus build with a
machine-verifiable no-request-body-retention mode.

Physical acceptance after the blockers clear must cover: cold model start,
queued concurrent tasks, active and queued cancellation, memory pressure,
receiver rejection, Osaurus stop/restart, loopback-only traffic capture, and
confirmation that no external API token is consumed.

`KD-0.1.15-MULTI-IMAGE-DELIVERY` remains separately waived until the planned
post-0.2 upgrade review; 0.2.4 local compute is text-only and does not claim to
fix that defect.
