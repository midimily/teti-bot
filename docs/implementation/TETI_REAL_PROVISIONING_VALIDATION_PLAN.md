# Teti Real Provisioning Validation Alpha Plan

## Storage And Configuration Audit

Current local storage paths:

- Teti account: `~/.teti/account.json` from `core/account/storage.ts`.
- Teti connection store: `~/.teti/connections.json` from `core/connection/storage.ts`.
- Teti application messages: `~/.teti/messages.json` from `core/application/manager.ts`.
- Chatmail accounts: `~/.teti/chatmail-accounts` from `integrations/chatmail/runtime-config.ts`.
- Chatmail RPC server path: `TETI_DELTACHAT_RPC_PATH` or `deltachat-rpc-server`.
- Chatmail accounts override: `TETI_CHATMAIL_ACCOUNTS_PATH`.
- Discovery registry: `https://teti-registry.seep2026.workers.dev` by default.

For this milestone, the first-launch real provisioning path writes only:

- Teti account storage
- Chatmail accounts storage
- lifecycle validation marker/manifest files

Connection/message stores are not exercised by first launch, but they remain production-profile
paths today and must be profile-aware before two-Mac or messaging validation.

## HOME-Based Isolation Risk

Changing `HOME` currently redirects account storage and default Chatmail accounts, but relying only
on `HOME` is not explicit enough for destructive real validation. A future module could read a
different env var or an OS application-data directory. This phase adds a single explicit
`TETI_PROFILE_DIR` resolver in the lifecycle sidecar.

## Selected Isolated Profile Design

Profile root:

```text
<TETI_PROFILE_DIR>/
  account/account.json
  credentials/chatmail-accounts/
  lifecycle/creation-marker.json
  logs/
  diagnostics/
  test-manifest.json
```

The sidecar derives both account storage and Chatmail accounts from the same normalized absolute
profile root.

## Safety Guards

Real account creation requires:

- `TETI_PROVISIONING_MODE=real`
- `TETI_ALLOW_REAL_PROVISIONING=1`
- absolute `TETI_PROFILE_DIR`
- profile path not equal to production `~/.teti`
- profile path not inside production `~/.teti`
- profile path under a recognized validation root such as `/private/tmp` or `/tmp`
- profile basename starts with `teti-real-provisioning-`
- no valid account already exists
- no unsafe incomplete marker exists
- valid display name
- request enters through the allowlisted lifecycle protocol

If an account exists, creation is rejected without calling Chatmail provisioning.

## Creation Markers

Marker path:

```text
<TETI_PROFILE_DIR>/lifecycle/creation-marker.json
```

Marker stages:

- `not_started`
- `provisioning`
- `identity_created`
- `persisting`
- `persisted`
- `registering_discovery`
- `complete`
- `failed_recoverable`
- `failed_fatal`

This marker contains no secrets and is not a second account database. Existing account storage is
authoritative on restart.

## Preflight

Preflight verifies:

- sidecar script is runnable
- `lifecycle.health` succeeds
- profile path is safe
- destructive authorization flag is enabled
- account status is missing
- marker is absent or complete
- Chatmail RPC binary path is configured or discoverable by `PATH`
- discovery registry is configured by current defaults

Preflight does not create identity.

## Real Test Sequence

1. Create a fresh validation profile.
2. Run preflight with real mode and explicit authorization.
3. Launch Desktop in real validation mode.
4. Enter `Teti Alpha 01`.
5. Submit once.
6. Verify ready state and idle collapse.
7. Exit app and verify sidecar exits.
8. Relaunch with same profile.
9. Verify onboarding is skipped.
10. Verify loaded public Teti ID/address match.
11. Attempt duplicate creation through safe tooling and verify it is blocked.

## Remote Cleanup And Expiry

The current registry client has a delete endpoint, but no authenticated remote cleanup design is
established for validation identities. This milestone does not add a new public delete capability.

If a remote discovery record is created, record public ID and timestamp, stop heartbeat, and document
expected expiry behavior. Do not claim remote deletion unless a safe authenticated delete path is
actually used.

## Evidence

Write sanitized manifest:

```text
<TETI_PROFILE_DIR>/test-manifest.json
```

The manifest records public ID/address, profile path, creation timestamp, discovery status, protocol
version, restart equality result, duplicate prevention result, cleanup status, and remote expiry
expectation. It must not include credentials, tokens, private keys, stack traces, raw account
serialization, or raw Chatmail responses.
