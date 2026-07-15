# Teti Real Chatmail Account Plan

Date: 2026-07-14

## Objective

Create one controlled real Teti account through the actual macOS Desktop first-launch UI, using the self-hosted Chatmail relay `mail.seep.im`, inside an isolated validation profile.

The account must end with `@mail.seep.im`. The implementation must not fall back to mock provisioning, must not use a public default relay, and must not expose credentials to the renderer.

## Phase 1 Machine Findings

- macOS architecture: `arm64`.
- macOS version: `macOS 26.5.2`, build `25F84`.
- Python: `Python 3.14.2`.
- pip: `pip 25.3` from Homebrew Python 3.14.
- Rust: `rustc 1.92.0 (ded5c06cf 2025-12-08)`.
- Cargo: `cargo 1.92.0 (344c4567c 2025-10-21)`.
- `PATH` does not currently resolve `deltachat-rpc-server`.
- Delta Chat Desktop application bundle search did not find a bundled `deltachat-rpc-server`.
- The Teti repository does not currently contain a project-local `.tools`, `vendor`, `bin`, or sidecar RPC server binary.
- Existing Tauri config does not bundle sidecars or resources; `bundle.active` is currently `false`.

## Existing RPC Server Candidate

Found:

```text
/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server
```

Validation:

```text
--version: 2.54.0-dev
file: Mach-O 64-bit executable arm64
permissions: -rwxr-xr-x
source remote: https://github.com/chatmail/core
source revision: 823b0741df82e3ec0f61285d52bf91ae19b1963e
license file present: /Users/macstudio/Documents/AICoRun/core/LICENSE
```

This is not an unrelated application-bundle binary. It is a local build from the official Chatmail Core repository. For this development validation, it can be used as the trusted executable if runtime health checks pass.

Release bundling remains separate and must not be claimed complete until sidecar packaging, signing, and redistribution licensing are resolved.

## Existing Teti Runtime Findings

Current runtime resolution:

- `integrations/chatmail/runtime-config.ts` resolves RPC path from `TETI_DELTACHAT_RPC_PATH`, falling back to `deltachat-rpc-server`.
- Chatmail accounts path resolves from explicit runtime input, then `TETI_CHATMAIL_ACCOUNTS_PATH`, then `~/.teti/chatmail-accounts`.
- Desktop validation profile already overrides account storage and Chatmail accounts storage under `TETI_PROFILE_DIR`.

Current process launch:

- `StdioJsonRpcTransport.spawn()` starts the RPC binary with stdio JSON-RPC.
- It passes `DC_ACCOUNTS_PATH` to isolate the Delta Chat account manager directory.
- It terminates the child process on `close()` with `SIGTERM`, then `SIGKILL` after 2 seconds.

Current account creation:

- `TetiAccountManager.createTetiAccount({ name })`
- `RuntimeChatmailProvisioner.createIdentity(displayName)`
- `RpcChatmailProvisioner.createIdentity(displayName)`
- `add_account`
- `set_config(displayname)`
- `add_transport_from_qr(accountId, accountQr)`
- `start_io`
- `get_account_info`
- `make_vcard`
- local account persistence
- discovery registration

Current relay behavior:

- `DEFAULT_CHATMAIL_ACCOUNT_QR` is `dcaccount:mail.seep.im`.
- This is already pointed at the intended relay, but real-validation mode does not yet require an explicit relay environment setting.

## Required Changes

1. Add explicit relay configuration for real validation:
   - `TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im`
   - derive/validate `dcaccount:mail.seep.im`
   - reject any non-`mail.seep.im` relay for this validation flow.
2. Add public address suffix validation:
   - require resulting Chatmail address to end in `@mail.seep.im`
   - fail before account persistence and discovery registration if the suffix is wrong.
3. Strengthen preflight:
   - executable exists
   - executable is executable
   - executable version is readable
   - executable architecture is Apple Silicon compatible
   - JSON-RPC `get_system_info` succeeds without creating an account
   - isolated accounts directory is writable
   - relay domain is exactly `mail.seep.im`
   - account does not already exist
   - marker does not indicate an active/incomplete operation.
4. Add tests:
   - RPC path diagnostics
   - relay domain validation
   - wrong relay rejection
   - wrong address suffix blocks persistence/discovery
   - preflight health does not create an account
   - existing account still blocks duplicate creation.
5. Create `docs/implementation/TETI_REAL_CHATMAIL_ACCOUNT_RESULT.md` with sanitized evidence.

## Development Runtime Strategy

Use an explicit local environment path for development validation:

```bash
export TETI_DELTACHAT_RPC_PATH=/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server
export TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im
```

Do not hardcode this user-specific absolute path in production source code.

The validation profile should be:

```text
/private/tmp/teti-mail-seep-real-alpha-01
```

Recommended launch:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-01 \
TETI_DELTACHAT_RPC_PATH=/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
npm run desktop:real-validation
```

## Relay Verification Plan

Non-destructive checks first:

- DNS resolution for `mail.seep.im`.
- TLS certificate and HTTPS reachability.
- Determine whether account provisioning is represented by `dcaccount:mail.seep.im`, an HTTPS `/new` endpoint, or another relay-provided account configuration mechanism.
- Do not call an endpoint that creates an account during generic preflight.

The actual account creation should happen exactly once through Desktop UI.

## Release Bundling Plan

Development validation can rely on `TETI_DELTACHAT_RPC_PATH`.

Release bundling is not complete until:

- a version-pinned arm64 RPC binary is included as a Tauri sidecar or packaged resource;
- executable permissions survive packaging;
- code-signing and notarization are verified;
- license/redistribution notes are included;
- runtime path resolution can find the bundled binary without `TETI_DELTACHAT_RPC_PATH`.

This phase may document release bundling status without claiming the release app is self-contained.
