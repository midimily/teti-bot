# Teti Desktop Lifecycle Bridge Alpha Plan

## Runtime Audit

- Node runtime in this environment: `v22.22.3`.
- Repository module format: ESM (`"type": "module"`).
- Package manager: npm. There is no root workspace config.
- Desktop app: Tauri v2 + Vite under `apps/desktop`.
- Existing tests use `node --experimental-strip-types`, so a Node sidecar can import existing `.ts` modules in Alpha.
- Account storage default path: `~/.teti/account.json`.
- `TetiAccountManager.createTetiAccount({ name })` already owns Chatmail provisioning, public environment profile creation, account persistence, and discovery registration.
- `FileTetiAccountStorage` rejects stored private keys, chatmail credentials, database paths, unsupported versions, and missing required identity fields.
- `RuntimeChatmailProvisioner.createIdentity(displayName)` starts the Delta Chat RPC runtime through the existing Chatmail adapter path.
- Discovery registration defaults to `https://teti-registry.seep2026.workers.dev`.
- Tauri config currently has one programmatically-created `island` window and no broad shell/process permissions.

## Selected Architecture

Use a tightly controlled Node lifecycle sidecar managed by Rust:

```text
Tauri renderer
  -> typed Tauri invoke
Rust lifecycle bridge command
  -> one managed child process over stdin/stdout JSON lines
Node lifecycle sidecar
  -> existing account lifecycle / Chatmail / storage / discovery modules
```

The sidecar is selected because the authoritative lifecycle is already Node-oriented and depends on
Node filesystem/process/runtime integration. Moving that code into the renderer would expose
secret-bearing code to the browser bundle; rewriting it in Rust would create a second account
implementation.

## Alternatives Rejected

- Browser-renderer imports of account lifecycle: rejected because Vite bundles Node-only modules and
  puts secret-bearing logic in the renderer trust zone.
- Rust reimplementation of account creation: rejected because it would duplicate Chatmail and storage
  behavior.
- Generic shell command Tauri API: rejected because it would be too broad.
- Externally reachable TCP server: rejected because the bridge should be local-only and process-owned.

## Process Ownership

- Rust owns the sidecar process.
- Exactly one sidecar is managed per desktop app process.
- The sidecar starts lazily on the first real lifecycle request or bridge health check.
- Pending requests are correlated by request ID.
- If the process exits, pending requests fail with a sanitized sidecar-unavailable error.
- Restart policy is bounded: one restart attempt for a request after an unexpected process exit.
- Teti shutdown kills the managed sidecar.

## Request Protocol

Transport: newline-delimited JSON on sidecar stdin/stdout.

Every request includes:

- `version: 1`
- `id`
- `method`
- `params`

Allowed methods:

- `lifecycle.health`
- `account.status`
- `account.load`
- `account.create`
- `discovery.register`
- `discovery.retry`

Unknown methods, unsupported protocol versions, oversized input, malformed JSON, invalid names, and
duplicate in-flight request IDs are rejected.

## Response Protocol

Every response includes:

- `version: 1`
- matching `id`
- `ok`
- `result` or `error`

Errors are sanitized DTOs:

- `code`
- `message`
- `recoverable`
- optional `retryTarget`

No stack traces, credentials, tokens, raw environment variables, or internal storage records are sent
to the renderer.

## Public DTOs

The renderer receives only public lifecycle DTOs:

- public Teti ID
- display name
- public Chatmail address
- created time
- lifecycle status
- discovery registration status
- public profile

The sidecar never sends Chatmail passwords, private keys, secret credentials, auth tokens, database
paths, or raw relay/internal responses.

## Timeout Strategy

Rust command/request timeouts:

- health: 2 seconds
- account load/status: 5 seconds
- discovery registration/retry: 15 seconds
- account creation/provisioning: 120 seconds

The sidecar does not kill an in-progress account write for ordinary UI cancellation. The frontend
prevents duplicate submission and waits for the authoritative operation boundary.

## Cancellation Strategy

No hard cancellation is used for account creation in this alpha because killing a process during a
write/provisioning boundary could create partial state. Duplicate UI submissions are already blocked
by the existing coordinator.

## Crash Recovery

- Unexpected sidecar exit rejects pending requests.
- A later request may restart the sidecar once.
- Repeated failures surface as explicit bridge-unavailable errors.
- No account is created when load/status fails temporarily.

## Development Execution Strategy

Development runs the sidecar with:

```text
node --experimental-strip-types apps/desktop/lifecycle-sidecar/main.ts
```

Rust can also honor an explicit `TETI_LIFECYCLE_SIDECAR_PATH` override for test/dev.

## Release Execution Strategy

Alpha release still uses a Node-capable sidecar script. The safest self-contained packaging strategy
is a future step: compile the sidecar into an architecture-specific executable or bundle a Node
runtime. For this milestone, release builds can compile the desktop app, but real provisioning
requires a discoverable Node runtime or explicit sidecar path. This limitation is documented rather
than hidden behind mock fallback.

## Security Boundary

- Renderer only invokes a narrow `lifecycle_request` command.
- Rust never exposes arbitrary command execution.
- Sidecar method dispatch is allowlisted.
- Stdout is reserved for protocol messages.
- Sanitized diagnostics may go to stderr.
- Protocol response size is bounded.

## Real Provisioning Test Strategy

Automated tests use fakes and isolated temp storage; they do not provision real Chatmail identities.

Before any controlled real provisioning test:

- verify the account path
- use an isolated profile/storage path
- confirm no existing real account will be overwritten
- explicitly enable real mode
- verify logs are sanitized

If an isolated profile cannot be guaranteed, real provisioning is not run and the blocker is recorded.
