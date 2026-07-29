# Teti Beta 0.2.3 — Osaurus Local Runtime Child

Status: implementation landed behind a fail-closed production qualification
gate; not release-ready because current official Osaurus retains request bodies
in Insights

Application version: `0.2.3`

Reviewed upstream Osaurus commit:
`bbad6ed9165e186e2e212f5160e6594dc3345c5e`

## Product boundary

This version adds the first `LocalService` Child Agent to the Host/Child Agent
framework:

```text
Teti Host Agent
  -> Osaurus Runtime Child
  -> Osaurus Connector
  -> LoopbackHttpTransport
  -> POST /v1/chat/completions
  -> OsaurusAI/Bonsai-27b-1bit-JANG
```

The internal and projected origin is `runtime_facade`. The Passport display
name is `Osaurus Runtime (Bonsai)`. It must not be named, treated as, or promoted
to an Osaurus Native Agent.

The accepted surface is deliberately narrow:

- text input and text output only;
- fixed model `OsaurusAI/Bonsai-27b-1bit-JANG`;
- one execution at a time for the Child;
- no tools or tool loop;
- no Osaurus Memory, Agent prompt, Skill, or Agent ID;
- no Host Workspace or attachment;
- no automatic Osaurus launch, installation, download, or configuration write;
- no LAN endpoint, hostname alias, IPv6 alias, redirect, query, fragment,
  credential, proxy, or pooled connection.

## Qualification pipeline

Observation and callability remain separate. Finding `Osaurus.app` or an
`osaurus` process may produce a local observation, but cannot create a callable
Passport entry.

Callability requires all of the following:

1. read a bounded, regular, non-symlinked
   `~/.osaurus/runtime/<instanceId>/configuration.json`;
2. require `health=running`, `address=127.0.0.1`,
   `exposeToNetwork=false`, and the exact URL/port relationship;
3. find exactly one listener PID for that port;
4. resolve the listener executable to
   `/Applications/Osaurus.app/Contents/MacOS/osaurus` or the same path below the
   current user's `~/Applications`;
5. require Bundle ID `com.dinoki.osaurus`, Developer Team ID `4W8QF9VR2F`, a
   valid code-directory hash, and strict `codesign` verification;
6. re-run listener identity verification immediately before connecting;
7. after TCP establishment but before writing the body, bind the exact client
   port/server port pair to the same listener PID and code identity;
8. require a supported Runtime version, healthy API, and the exact fixed model
   owned by `osaurus`;
9. require a machine-verifiable no-request-body-retention policy.

Any missing, ambiguous, changed, or mismatched evidence fails closed. Shared
configuration `updatedAt` orders multiple candidates; it is not treated as a
heartbeat. Stale files are harmless because live listener, socket-owner, and
signature checks remain mandatory.

## Request contract

The request body is exactly:

```json
{
  "model": "OsaurusAI/Bonsai-27b-1bit-JANG",
  "messages": [{ "role": "user", "content": "<task text>" }],
  "stream": true,
  "tools": []
}
```

Teti sends `X-Persist: false` and a bounded idempotency key. It deliberately
does not send `X-Osaurus-Agent-Id`, an Authorization header, session identity,
Memory input, Agent prompt, Workspace path, or peer identity.

## Stream and cancellation behavior

`LoopbackHttpTransport` accepts only HTTP 200 `text/event-stream`. It validates
one OpenAI chat-completion chunk per SSE event, the exact model, one choice,
assistant-only deltas, permitted finish reasons, a non-empty bounded result,
and terminal `[DONE]`. Tool/function calls and malformed or trailing events fail
closed.

Stream text is buffered up to 512 KiB and committed to Host output only after
the whole stream validates. This prevents a malformed tail from publishing a
partial Artifact or corrupting the safe failure marker.

Cancellation and force-kill destroy the request, response, and socket. The
reviewed Osaurus HTTP handler cancels its in-flight request Tasks when the
channel becomes inactive or input closes. Automated tests verify that the
server observes the client socket close; a real Runtime check that inference
activity returns to baseline remains a physical release gate.

## Safe failure map

| Runtime outcome | Teti safe code |
| --- | --- |
| no trusted listener / connection failure | `ADAPTER_RUNTIME_UNAVAILABLE` |
| identity mismatch or redirect | `ADAPTER_RUNTIME_UNTRUSTED` |
| inference saturation / HTTP 503 | `ADAPTER_RUNTIME_BUSY` |
| fixed model missing or unavailable | `ADAPTER_MODEL_UNAVAILABLE` |
| model/internal load failure | `ADAPTER_MODEL_LOAD_FAILED` |
| insufficient unified memory / OOM | `ADAPTER_INSUFFICIENT_MEMORY` |
| malformed, tool-bearing, incomplete, or oversized SSE | `ADAPTER_STREAM_INVALID` / `ADAPTER_OUTPUT_LIMIT` |

The error response body is bounded to 64 KiB and never enters Passport or the
remote Task contract.

## Unresolved upstream privacy blocker

The reviewed official Osaurus source decodes the full chat-completion body into
`requestBodyString`, passes it to `logRequest`, and stores request logs in a
500-entry in-memory `InsightsService` ring buffer. `X-Persist: false` controls
chat-history persistence, not Insights logging. No documented per-request
header or advertised capability disables the Insights body copy.

Teti cannot solve that from the client: the Runtime needs plaintext for
inference, and changing Osaurus settings is explicitly outside this version's
authority. Consequently the production policy reports
`OSAURUS_INSIGHTS_BODY_RETENTION`; qualification does not return a Connector,
Host registers nothing, and Passport advertises no Osaurus callable capability.

Unblocking requires an official Osaurus contract that is both documented and
machine-verifiable before task text is sent. Teti must add a qualification test
for that exact contract; a UI promise or `X-Persist: false` alone is
insufficient.

## Upstream evidence

- [OpenAI-compatible endpoint and strict tool semantics](https://github.com/osaurus-ai/osaurus/blob/bbad6ed9165e186e2e212f5160e6594dc3345c5e/docs/OpenAI_API_GUIDE.md)
- [Shared Runtime configuration contract](https://github.com/osaurus-ai/osaurus/blob/bbad6ed9165e186e2e212f5160e6594dc3345c5e/docs/SHARED_CONFIGURATION_GUIDE.md)
- [HTTP request-body logging, persistence switch, and channel cancellation](https://github.com/osaurus-ai/osaurus/blob/bbad6ed9165e186e2e212f5160e6594dc3345c5e/Packages/OsaurusCore/Networking/HTTPHandler.swift)
- [Insights 500-entry in-memory ring buffer](https://github.com/osaurus-ai/osaurus/blob/bbad6ed9165e186e2e212f5160e6594dc3345c5e/Packages/OsaurusCore/Managers/InsightsService.swift)

## Verification

Automated coverage includes:

- exact request body/header and Workspace refusal;
- loopback endpoint validation and redirect refusal;
- signed app/listener/established-socket binding and spoofed PID rejection;
- strict/atomic SSE success and malformed-stream rejection;
- model, OOM, load, 503, and SSE safe error mapping;
- socket-close cancellation observation;
- fixed model and Insights qualification gates;
- `runtime_facade` Passport naming and origin;
- per-Child concurrency one while preserving Host global concurrency;
- existing Codex, CodeBuddy, Workspace, Task, Passport, and lifecycle tests.

Local automated result: `499/499` tests passed, along with Desktop
TypeScript checking, the production web/runtime bundle, Rust `cargo check`, and
`git diff --check`.

The read-only local qualification check found an Osaurus Runtime claim at
`127.0.0.1:1337`, but strict macOS signature verification reported that the
installed `/Applications/Osaurus.app` signature is invalid or its signed code
was modified. Qualification therefore returned
`degraded / OSAURUS_RUNTIME_UNTRUSTED`, registered no Connector, and sent no
task body. Repairing or reinstalling that App is a separate local prerequisite;
it would not remove the independent upstream Insights-retention blocker.

Not completed in this implementation run:

- a real Osaurus inference, because the local App identity is currently
  untrusted and current Insights behavior independently blocks task text before
  dispatch;
- real-Runtime cancellation-to-idle confirmation;
- two-Mac installed application acceptance;
- App or DMG build (not requested for this step).
