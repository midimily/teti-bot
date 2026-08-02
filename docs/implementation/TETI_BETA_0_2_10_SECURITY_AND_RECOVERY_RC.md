# Teti Beta 0.2.10 — Security and Recovery RC

Status: implementation and automated RC gate complete; physical dual-Mac and
real-provider sign-off remain release operations

Application version: `0.2.10`

## Scope freeze

This release adds no user-facing capability. It keeps Application Envelope v2,
collaboration epoch 2, Task v6, Passport schema 4, the 0.2.9 deterministic
Delegation Plan and every existing Connector/Transport boundary. The production
Release Policy minimum remains `0.2.8`; raising it is a separate operator action.

The release work is limited to adversarial verification, recovery regression,
one checkpoint-integrity correction, version metadata, documentation and signed
ad-hoc build artifacts.

## Checkpoint integrity correction

0.2.9 copied explicit checkpoints into a private Teti directory but did not
compare their bytes again before resume. 0.2.10 closes that gap:

- the Workspace source is resolved and must remain beneath its Snapshot root;
- checkpoint bytes are copied to a private temporary file, hashed with SHA-256,
  then atomically renamed into the private checkpoint path;
- the digest is stored in local Execution Handle store schema 2 with the Task,
  captured epoch and private reference;
- resume resolves the file beneath the private root and recomputes the digest;
- a missing integrity record, missing file, path escape or digest mismatch
  clears the checkpoint reference and resume capability, then returns
  `EXECUTION_CHECKPOINT_INTEGRITY_FAILED`;
- schema-1 Execution Handle stores migrate without manufacturing a digest, so
  an old unattested checkpoint is not trusted.

Checkpoint records and paths remain receiver-local. The public
`ExecutionHandle`, Task, Passport and Chatmail contracts are unchanged.

## Concentrated gate

Run the release gate from the repository root:

```sh
npm run test:security-recovery-rc
```

The suite contains 155 behavioral tests and covers the following matrix.

| Required area | Automated evidence | RC result |
| --- | --- | --- |
| Codex / CodeBuddy migration | fixed CLI entrypoints, login qualification, JSONL bounds, process cleanup, text/image Artifact filtering | Pass |
| Osaurus Runtime / Native | distinct origins, fixed routes, local provider-default recording, Runtime Insights blocker, Native accepted-risk visibility, configuration digest re-audit | Pass with documented provider-native side-effect risk |
| Workspace path escape | abstract remote requests, relative-path validation, symlink rejection and private Snapshots | Pass |
| Workspace competing writes | optimistic exact revision commit and stale Snapshot rejection | Pass |
| Memory pollution / overreach | default-off durable write, explicit local authorization, bounded injection, Workspace/Child isolation, deletion and expiry | Pass |
| Long-task replay | orphaned side-effecting execution becomes interrupted and cannot resume or auto-run | Pass |
| Checkpoint tampering | digest mismatch quarantines resume; explicit valid checkpoint advances epoch | Pass |
| Localhost port impersonation | exact 127.0.0.1, listener PID, connected socket owner, bundle/team/code identity and redirect rejection | Pass |
| Local-model compute DoS | concurrency one, queue bound eight, overflow rejection, queued cancellation, output and deadline bounds | Pass |
| Cancel / resume race | current epoch wins; stale completion and late Artifact cannot overwrite it | Pass |
| Malicious Artifact | strict fields, size/image/digest bounds, private ingestion and path/URL rejection | Pass |
| Two-Mac disconnect / disorder | two in-memory Teti runtimes exercise offline queueing, idempotency, retry, early Artifact and monotonic status | Pass (simulated) |
| Host delegation overreach | depth one, four-Child ceiling, per-step budget, Workspace subset, remote access deny, target re-resolution and no fallback | Pass |

The first sandboxed invocation can report `listen EPERM` because macOS loopback
binding is denied by that sandbox. This is an environment restriction, not a
product failure. The authoritative RC run must permit temporary `127.0.0.1`
listeners; that run completed 155/155.

## Full regression and build gates

Before distributing an RC package, also require:

1. `npm test` with all repository tests passing;
2. `npm run desktop:typecheck`;
3. `npm run desktop:rust-check`;
4. `npm run desktop:build`;
5. `npm run desktop:package:mac:adhoc`;
6. bundle version/build timestamp inspection, arm64-only Mach-O inventory,
   minimum macOS 15.0, deep ad-hoc signature verification, mounted-DMG
   inspection, runtime smoke and SHA-256 verification.

## Residual release work

Automation does not replace these physical checks:

- two real Macs running the exact 0.2.10 build across disconnect, reconnect and
  deliberately reordered/delayed Task traffic;
- real Codex text/image and CodeBuddy text execution using the user's own local
  authenticated sessions;
- real Osaurus Runtime execution after Insights request-body retention is
  disabled, plus Native execution after the user-visible local-owner risk is
  accepted; both require a signature-trusted installed Osaurus app;
- memory-pressure observation during model cold start and cancellation;
- the accepted multi-image delivery defect review using one, two and four
  attachments. Incomplete images must still block approval and execution.

Until those checks are signed, 0.2.10 is an RC build, not proof that the physical
dual-Mac matrix or current third-party Osaurus blockers have passed.

## Post-RC integration corrections

The native desktop bridge now exposes every method already present in the
TypeScript lifecycle protocol, including Release Policy, long-horizon Task
control, Delegation, Memory and Osaurus Native settings. A cross-layer test
prevents the Rust allowlist from silently dropping a later protocol method.

Osaurus Native qualification no longer requires the local owner to turn off
Tools, provider Memory or Autonomous Exec. Their actual enabled/disabled states
are captured in the local execution specification and re-audited by digest;
they remain provider-managed residual risk. Direct Host Workspace mounting is
still rejected. The Native transport no longer supplies tool overrides.

Runtime identity matching accepts the provider's lowercase `osaurus.app`
bundle spelling while retaining canonical install-root, listener PID,
connected-socket and valid-signature requirements. Trust failures now preserve
specific local diagnostics instead of collapsing every cause into
`OSAURUS_RUNTIME_UNTRUSTED`. A locally modified or invalidly signed Osaurus app
remains blocked and must be replaced with a valid official installation; Teti
does not weaken code-signature verification.

Native qualification treats the reviewed official Insights request-body ring
as a documented local-owner residual risk instead of a security-qualification
failure. The Connector becomes callable with
`OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED` visible in Settings and diagnostics.
An unknown retention policy remains fail-closed, and the Runtime Facade's
strict `OSAURUS_INSIGHTS_BODY_RETENTION` blocker is unchanged.
