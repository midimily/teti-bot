# Teti Beta 0.2.1 — Host/Child Agent Core

Status: implemented; automated gates complete; physical dual-Mac acceptance pending

Application version: `0.2.1`

## Scope

Beta 0.2.1 is an internal execution-architecture release. It migrates the
existing Codex, Codex Image, and CodeBuddy execution paths to one Host/Child
Agent framework. It does not add Osaurus or any other provider, and it does not
change the explicit user-controlled Passport sharing rule.

## Frozen abstractions

| Contract | Owner | Responsibility |
| --- | --- | --- |
| `TetiHostAgent` | Teti Runtime | authorization, routing, task state, workspaces, limits, cancellation, Artifact persistence |
| `LocalChildAgent` | Teti Runtime | local aggregate of one Agent, its Connectors, bindings, capabilities, and content modes |
| `AgentConnector` | provider integration | fixed provider invocation and bounded output decoding |
| `ExecutionTransport` | Teti Runtime | execute one validated local-only specification and expose lifecycle control |
| `ExecutionAuthority` | Teti Runtime | short-lived, exact-input-bound, single-use permission for one local execution |
| `AgentResourceBinding` | Teti Runtime | bind Child Agent, Connector, Transport kind, and curated capabilities |

The version-1 definitions and validators live in
`core/callability/agent-core.ts`.

## Execution flow

1. A receiver explicitly approves one collaboration Task.
2. Task Runtime validates its local `ExecutionGrant` and derives an
   `ExecutionAuthority` without requester identity.
3. `TetiHostAgentKernel` validates Task target, content modes, Authority target,
   exact input digest, expiry, and one-time use.
4. The Host creates an isolated task workspace and stages verified images.
5. The selected Connector receives only task ID, capability ID, workspace, and
   staged images, then returns an `ExecutionSpec`.
6. The Host checks the spec against the Connector's fixed entrypoint and
   Resource Binding, selects the matching Transport, and writes task text over
   stdin.
7. The Host owns timeout, cancellation, process-group termination, output
   limits, decoding, Artifact persistence, workspace removal, and final state.

Authority, Connector, and Transport are process-local contracts. None is an
Application Message, Task field, Passport field, or Chatmail payload.

## Transport backends

### ProcessTransport

Production backend for all 0.2.1 Connectors. It preserves:

- fixed absolute executable validation;
- bounded arguments and environment;
- minimal inherited environment;
- UTF-8 stdin task delivery;
- detached process groups on macOS;
- SIGTERM followed by bounded SIGKILL escalation;
- shutdown force-kill protection;
- combined stdout/stderr byte limit and fatal UTF-8 decoding.

### FakeTransport

In-memory deterministic test backend. It verifies the Host/Connector contract
without starting a process and is not registered in production.

### LoopbackHttpTransport

Reserved interface only. Its implementation throws before network activity and
no 0.2.1 Connector selects it. Enabling loopback HTTP requires a later threat
review and an explicit version plan.

## Provider migration

```text
Codex Child Agent
  -> CodexConnector / CodexImageConnector
  -> ProcessTransport

CodeBuddy Child Agent
  -> CodeBuddyConnector
  -> ProcessTransport
```

Provider detection and login qualification remain asynchronous and fail
closed. Connector IDs remain stable for local Task state and callable readiness
projection, but executable paths, Transport kind, arguments, environment, and
workspace never enter public Passport metadata.

## Boundary enforcement

- `AgentConnectorContext` has no task text, `ExecutionAuthority`, Passport,
  Chatmail, consent, requester ID, target peer ID, or connection record.
- Codex and CodeBuddy Connector source is checked for forbidden imports from
  Passport, Chatmail, and connection modules.
- The Host writes task text only after Connector output and Transport selection
  pass local validation.
- `ExecutionAuthority` contains local Connector and Child Agent targets but no
  peer identity. It is consumed once and retained until expiry to prevent reuse.
- Callable Passport is derived from bounded readiness metadata and excludes all
  Resource Binding and Transport details.
- Collaboration Task validation continues to reject executable, command,
  Adapter/Connector, local Agent, path, environment, and workspace selection.

## Automated release evidence

- full repository suite: 466 tests passed;
- desktop TypeScript typecheck passed;
- Codex fake CLI text pipeline passed;
- Codex image runner + Artifact Store pipeline passed;
- CodeBuddy fake CLI text pipeline passed;
- timeout, explicit cancellation, full process-tree reaping, shutdown cleanup,
  output overflow, and failing-process isolation passed;
- FakeTransport, Authority expiry/input binding/single use, forbidden Connector
  imports, public projection redaction, and disabled Loopback HTTP passed.

Packaging verification:

- App: `apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`;
- DMG: `apps/desktop/release/Teti-0.2.1-arm64-macos15-adhoc-alpha.dmg`;
- DMG size: 56,207,304 bytes;
- SHA-256: `4f56a8b648c1ddef80548236455f1b3b38d1477962f6422cc0c340fb144e7187`;
- arm64 only; application minimum macOS 15.0;
- ad-hoc signature verified with strict deep validation;
- DMG checksum verified and its staged App/Applications layout validated by
  the packaging gate;
- bundled Node, Delta Chat RPC health/clean shutdown, lifecycle sidecar health,
  and bundled Codex image runner syntax checks passed;
- controlled Alpha only: not Developer ID signed and not notarized.

## Known defect retained

`KD-0.1.15-MULTI-IMAGE-DELIVERY` remains accepted for this upgrade cycle:
physical dual-Teti Tasks with two or four images can have a high incomplete
delivery rate, while one image is usually reliable. Beta 0.2.1 keeps the
fail-closed mitigation: incomplete image sets are visible, non-actionable, and
cannot execute or report completion. The defect must be re-tested and reviewed
after both Macs complete the 0.2 upgrade round.

## Physical release gates still open

- Codex text and image Tasks on two installed 0.2.1 Macs;
- CodeBuddy text Task on an installed 0.2.1 Mac with the official CLI;
- explicit cancellation and timeout on installed builds;
- Passport remains opt-in independently on both Macs;
- multi-image delivery diagnostics and post-upgrade defect review;
- App launch and DMG install validation on the target macOS matrix.
