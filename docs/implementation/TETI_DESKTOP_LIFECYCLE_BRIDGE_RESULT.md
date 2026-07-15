# Teti Desktop Lifecycle Bridge Alpha Result

## Summary

Implemented a trusted local lifecycle bridge for Teti Desktop real mode.

The renderer now talks to a narrow Tauri command. Rust owns a single Node-capable sidecar process and
communicates over newline-delimited JSON on stdin/stdout. The sidecar reuses the authoritative
existing Teti account lifecycle, including Chatmail provisioning, storage, and discovery
registration.

Real mode no longer falls back to mock behavior.

## Final Architecture

```text
Tauri renderer
  -> LifecycleBridgeClient
  -> lifecycle_request Tauri command
  -> Rust LifecycleBridge process manager
  -> Node sidecar JSON-line protocol
  -> createTetiAccount/loadTetiAccount/getTetiStatus/RegistryDiscoveryClient
```

## Sidecar Strategy

Selected strategy: Node sidecar script run with:

```sh
node --experimental-strip-types apps/desktop/lifecycle-sidecar/main.ts
```

Reason: the existing account lifecycle is Node-based and already owns Chatmail provisioning,
filesystem storage, environment scanning, and discovery registration.

Rejected:

- browser bundling of account lifecycle
- Rust account lifecycle rewrite
- generic shell/process command
- externally reachable TCP service

## Files Created

- `apps/desktop/src/lifecycle-bridge/protocol.ts`
- `apps/desktop/lifecycle-sidecar/main.ts`
- `apps/desktop/lifecycle-sidecar/handler.ts`
- `apps/desktop/lifecycle-sidecar/security.ts`
- `apps/desktop/src/provisioning/bridge-lifecycle.ts`
- `apps/desktop/src-tauri/src/lifecycle_bridge.rs`
- `apps/desktop/test/lifecycle-sidecar.test.ts`
- `docs/implementation/TETI_DESKTOP_LIFECYCLE_BRIDGE_PLAN.md`
- `docs/implementation/TETI_DESKTOP_LIFECYCLE_BRIDGE_RESULT.md`

## Files Modified

- `apps/desktop/src/app.ts`
- `apps/desktop/src/provisioning/index.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/tsconfig.json`
- `apps/desktop/README.md`
- `apps/desktop/test/desktop-shell.test.ts`

Removed obsolete browser-rejecting real adapter:

- `apps/desktop/src/provisioning/real-lifecycle.ts`

## Protocol

Request:

```json
{
  "version": 1,
  "id": "request-id",
  "method": "account.create",
  "params": {
    "name": "My Teti"
  }
}
```

Response:

```json
{
  "version": 1,
  "id": "request-id",
  "ok": true,
  "result": {}
}
```

Allowed methods:

- `lifecycle.health`
- `account.status`
- `account.load`
- `account.create`
- `discovery.register`
- `discovery.retry`

Rejected:

- unknown methods
- unsupported protocol versions
- malformed JSON
- oversized requests/responses
- invalid request IDs
- invalid names
- duplicate in-flight sidecar request IDs

## Public DTOs

Renderer-facing account DTOs include only:

- `id`
- `address`
- `displayName`
- `chatmailAccountId`
- optional public key/fingerprint
- `publicProfile`
- `createdAt`

The renderer does not receive Chatmail passwords, private keys, credentials, tokens, database paths,
raw environment variables, stack traces, or raw relay payloads.

## Security Boundary

- Renderer has one narrow lifecycle command path.
- Rust does not expose arbitrary shell execution.
- Rust owns exactly one sidecar process.
- Sidecar dispatch is allowlisted.
- Stdout is protocol-only.
- Sidecar diagnostics go to stderr.
- Errors are sanitized before crossing the renderer boundary.

## Timeout Values

- health: 2 seconds
- account status/load: 5 seconds
- account creation/provisioning: 120 seconds
- discovery register/retry: 15 seconds

Account creation is not force-cancelled in this alpha because killing the sidecar during provisioning
or persistence can create partial state. Duplicate UI submission remains blocked by the existing
coordinator.

## Retry Behavior

- Sidecar process is started lazily.
- If the process has exited, Rust drops the old handle and starts a new sidecar on the next request.
- Pending requests fail with `SIDECAR_UNAVAILABLE` when the stdout reader disconnects.
- Discovery retry uses the existing persisted account and does not create another identity.

## Mock Versus Real Mode

Mock mode:

- remains default
- does not invoke the lifecycle bridge
- is used by normal UI tests and development

Real mode:

- requires explicit `TETI_PROVISIONING_MODE=real`
- performs bridge health before returning a lifecycle adapter
- calls `account.load`, `account.status`, `account.create`, and `discovery.retry` through Tauri
- never silently returns mock success

## Commands

Development:

```sh
npm run desktop:dev
```

Real mode:

```sh
TETI_PROVISIONING_MODE=real npm run desktop:dev
```

Sidecar health smoke:

```sh
printf '%s\n' '{"version":1,"id":"health","method":"lifecycle.health","params":{}}' \
  | node --experimental-strip-types apps/desktop/lifecycle-sidecar/main.ts
```

Tauri release build:

```sh
npm run desktop:tauri-build
```

## Verification

Passed:

```sh
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
npm test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
```

Results:

- Desktop tests: 28 passed.
- Full root tests: 92 passed.
- Rust tests: 8 passed.
- Tauri release binary built at `apps/desktop/src-tauri/target/release/teti-desktop`.

Non-destructive sidecar smoke checks:

- `lifecycle.health` returned `ok: true`.
- `account.status` under isolated `HOME=/private/tmp/teti-bridge-alpha-home` returned:
  `exists: false`, `registered: false`, `onlineStatus: "unknown"`.

## Real Provisioning Test

Not run.

Safety blocker: a full real provisioning test would create a real Chatmail identity and attempt
discovery registration. The task did not provide an explicit disposable Chatmail/profile cleanup
strategy, and running it against the default `~/.teti/account.json` could overwrite or conflict with
an existing real identity.

Created isolated test profile location:

```text
/private/tmp/teti-bridge-alpha-home
```

No real Chatmail address was created in this pass.

Discovery registration was not exercised against the live registry in this pass.

Restart verification for a real created account was not run because real provisioning was blocked for
the reason above. Automated and smoke coverage verify the bridge load/status paths without creating a
duplicate identity.

## Known Limitations

- Release binary currently depends on a discoverable Node runtime and this development checkout's
  sidecar/source files. A distributed app needs a bundled Node runtime or compiled sidecar binary.
- Rust request handling is serialized through one managed sidecar process in this alpha.
- No hard cancellation for account creation.
- Real provisioning still needs a controlled disposable profile test with explicit cleanup.

## Recommended Next Phase

Package the lifecycle sidecar as a self-contained, architecture-specific executable or bundled Node
runtime resource, then run the controlled real provisioning/restart test against an isolated profile
with explicit cleanup tooling.
