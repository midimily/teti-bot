# Teti Real Provisioning Validation Alpha Result

Date: 2026-07-14

## Scope

This milestone adds the safety and validation harness required before a real first-launch Teti identity can be created from the macOS Desktop UI.

It does not claim that a real identity was created in this run. Preflight blocked real UI provisioning because the Chatmail RPC executable was not available.

## Implemented

- Added explicit profile isolation through `TETI_PROFILE_DIR`.
- Routed first-launch real account creation through profile-specific account storage and Chatmail accounts storage.
- Added destructive-operation guards for real provisioning:
  - `TETI_PROVISIONING_MODE=real`
  - `TETI_ALLOW_REAL_PROVISIONING=1`
  - absolute `TETI_PROFILE_DIR`
  - profile name starts with `teti-real-provisioning-`
  - profile lives under a temp validation root such as `/private/tmp` or `/tmp`
  - profile is outside the production `~/.teti` tree
  - no existing valid account is present
  - no unsafe incomplete creation marker is present
- Added lifecycle creation markers.
- Added sanitized validation manifest support.
- Added safe local profile create/status/preflight/clean scripts.
- Added automated tests for validation profile guards, duplicate prevention, marker safety, manifest redaction, and cleanup refusal.

## Files

- `apps/desktop/lifecycle-sidecar/profile.ts`
- `apps/desktop/lifecycle-sidecar/marker.ts`
- `apps/desktop/lifecycle-sidecar/manifest.ts`
- `apps/desktop/lifecycle-sidecar/handler.ts`
- `apps/desktop/lifecycle-sidecar/security.ts`
- `apps/desktop/src/lifecycle-bridge/protocol.ts`
- `apps/desktop/scripts/profile.ts`
- `apps/desktop/test/real-validation-profile.test.ts`
- `apps/desktop/package.json`
- `package.json`
- `docs/implementation/TETI_REAL_PROVISIONING_VALIDATION_PLAN.md`
- `docs/implementation/TETI_REAL_PROVISIONING_VALIDATION_RESULT.md`

## Profile Layout

Validation profile used:

```text
/private/tmp/teti-real-provisioning-alpha-01
```

Derived local paths:

```text
/private/tmp/teti-real-provisioning-alpha-01/account/account.json
/private/tmp/teti-real-provisioning-alpha-01/credentials/chatmail-accounts
/private/tmp/teti-real-provisioning-alpha-01/lifecycle/creation-marker.json
/private/tmp/teti-real-provisioning-alpha-01/logs
/private/tmp/teti-real-provisioning-alpha-01/diagnostics
/private/tmp/teti-real-provisioning-alpha-01/test-manifest.json
```

Production profile root remains:

```text
~/.teti
```

## Storage Audit

First-launch real provisioning now uses the explicit validation profile for:

- Teti account storage
- Chatmail accounts storage
- lifecycle marker
- validation manifest
- diagnostics/log directories

Connection and message stores are not exercised by first launch and still use their existing production-profile defaults. They must be profile-aware before two-Mac or messaging validation.

## CLI Commands

Create profile:

```bash
npm run desktop:profile:create -- --path /private/tmp/teti-real-provisioning-alpha-01
```

Status:

```bash
npm run desktop:profile:status -- --path /private/tmp/teti-real-provisioning-alpha-01
```

Preflight:

```bash
TETI_PROVISIONING_MODE=real \
TETI_ALLOW_REAL_PROVISIONING=1 \
npm run desktop:profile:preflight -- --path /private/tmp/teti-real-provisioning-alpha-01
```

Real UI launch command for a future passing preflight:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-real-provisioning-alpha-01 \
npm run desktop:real-validation
```

## Preflight Evidence

Profile creation succeeded:

```json
{
  "profileRoot": "/private/tmp/teti-real-provisioning-alpha-01",
  "accountPath": "/private/tmp/teti-real-provisioning-alpha-01/account/account.json",
  "chatmailAccountsPath": "/private/tmp/teti-real-provisioning-alpha-01/credentials/chatmail-accounts",
  "markerPath": "/private/tmp/teti-real-provisioning-alpha-01/lifecycle/creation-marker.json",
  "manifestPath": "/private/tmp/teti-real-provisioning-alpha-01/test-manifest.json",
  "isValidationProfile": true,
  "accountExists": false,
  "marker": null
}
```

Preflight failed safely:

```json
{
  "ok": false,
  "guards": {
    "realMode": true,
    "allowRealProvisioning": true,
    "profileProvided": true,
    "profileIsValidationProfile": true
  },
  "accountStatus": {
    "ok": true,
    "result": {
      "exists": false,
      "registered": false,
      "onlineStatus": "unknown"
    }
  },
  "chatmail": {
    "rpcServerPath": "deltachat-rpc-server",
    "accountsPath": "/private/tmp/teti-real-provisioning-alpha-01/credentials/chatmail-accounts",
    "rpcAvailable": false
  },
  "marker": null,
  "errors": []
}
```

Blocker:

```text
deltachat-rpc-server was not discoverable on PATH, and TETI_DELTACHAT_RPC_PATH was not configured.
```

Because preflight did not pass, the Desktop UI real provisioning run was intentionally not started.

## Real Identity Result

- Real identity created: no
- Public Teti ID: not available
- Public Chatmail address: not available
- Discovery registration: not attempted
- Restart verification: not attempted
- Ready-to-idle visual verification: not attempted
- Duplicate real identity verification through Desktop UI: not attempted
- Automated duplicate guard verification: passed

## Cleanup

No remote account or registry record was created, so remote cleanup was not applicable.

Local validation profile cleanup was performed:

```json
{
  "ok": true,
  "cleanedProfile": "/private/tmp/teti-real-provisioning-alpha-01",
  "localOnly": true,
  "remoteChatmailDeleted": false,
  "remoteDiscoveryDeleted": false
}
```

## Verification

Passed:

```bash
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
npm test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
```

Observed counts:

- Desktop tests: 37 passed
- Full JS tests: 101 passed
- Rust tests: 8 passed
- Tauri release build: passed

## Next Step

Configure a real Chatmail RPC server before attempting UI provisioning:

```bash
export TETI_DELTACHAT_RPC_PATH=/absolute/path/to/deltachat-rpc-server
```

Then repeat:

1. Create a fresh validation profile.
2. Run preflight with `TETI_PROVISIONING_MODE=real`, `TETI_ALLOW_REAL_PROVISIONING=1`, and explicit `TETI_PROFILE_DIR`.
3. Only if preflight passes, launch Desktop with `npm run desktop:real-validation`.
4. Create one Teti from the UI.
5. Verify ready state, idle collapse, app restart, duplicate prevention, manifest contents, and cleanup/expiry evidence.
