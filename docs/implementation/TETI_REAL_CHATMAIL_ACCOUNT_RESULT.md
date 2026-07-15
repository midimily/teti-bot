# Teti Real Chatmail Account Result

Date: 2026-07-14

## Summary

One real Teti identity was created through the actual Teti Desktop first-launch UI using the self-hosted Chatmail relay `mail.seep.im`.

The resulting public Chatmail address is:

```text
bz0nwanxu@mail.seep.im
```

The resulting public Teti ID is:

```text
teti_bz0nwanxu
```

No second real identity was created. Restart loaded the same public identity, onboarding was skipped, duplicate creation was blocked, and all child processes shut down cleanly.

## RPC Server

- Source: official Chatmail Core repository.
- Source remote: `https://github.com/chatmail/core`.
- Source revision: `823b0741df82e3ec0f61285d52bf91ae19b1963e`.
- Installation/build method used for this run: existing local release build from the official source checkout.
- Development binary path used for this run: `/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server`.
- Version: `2.54.0-dev`.
- Architecture: `arm64`.
- File output: `Mach-O 64-bit executable arm64`.
- Executable permission: present.

Repository-local bootstrap path now exists for future Macs:

```text
.tools/deltachat-rpc-server/aarch64-apple-darwin/deltachat-rpc-server
```

After the real account was created, the repository-local RPC install path was also built and verified from the pinned official source revision. Future source-based validation no longer depends on the absolute development path above.

## Relay

- Relay domain: `mail.seep.im`.
- Account configuration source: `dcaccount:mail.seep.im`.
- Expected address suffix: `@mail.seep.im`.
- Explicit env guard: `TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im`.
- Final address suffix: passed.
- Non-`mail.seep.im` relay configuration is rejected for real validation.
- Address outside `@mail.seep.im` is rejected before local account persistence and discovery registration.

## Profile

Validation profile:

```text
/private/tmp/teti-mail-seep-real-alpha-01
```

Manifest:

```text
/private/tmp/teti-mail-seep-real-alpha-01/test-manifest.json
```

Marker:

```json
{
  "stage": "complete",
  "publicTetiId": "teti_bz0nwanxu",
  "publicAddress": "bz0nwanxu@mail.seep.im"
}
```

The profile is retained for follow-up validation. It contains a real local Delta Chat account database and must not be committed.

## Preflight

Command:

```bash
TETI_DELTACHAT_RPC_PATH=/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
TETI_PROVISIONING_MODE=real \
TETI_ALLOW_REAL_PROVISIONING=1 \
npm run desktop:profile:preflight -- --path /private/tmp/teti-mail-seep-real-alpha-01
```

Result before creation: PASS.

Evidence:

```json
{
  "ok": true,
  "chatmailRuntime": {
    "exists": true,
    "executable": true,
    "version": "2.54.0-dev",
    "architecture": "arm64",
    "appleSiliconCompatible": true,
    "accountsPathWritable": true,
    "jsonRpcHealth": true,
    "cleanShutdown": true
  },
  "relay": {
    "ok": true,
    "config": {
      "relayDomain": "mail.seep.im",
      "accountQr": "dcaccount:mail.seep.im",
      "expectedAddressSuffix": "@mail.seep.im",
      "explicitRelayDomain": true
    }
  },
  "relayNetwork": {
    "dns": {
      "ok": true,
      "addresses": ["64.176.43.239"]
    },
    "tls": {
      "ok": true,
      "authorized": true,
      "protocol": "TLSv1.3",
      "validTo": "Sep  5 15:21:56 2026 GMT"
    },
    "https": {
      "ok": true,
      "statusCode": 403,
      "contentType": "text/html"
    },
    "accountCreationEndpointChecked": false
  },
  "errors": []
}
```

Preflight used non-destructive JSON-RPC `get_system_info` and did not create an account.

## UI Creation

Launch command:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-01 \
TETI_DELTACHAT_RPC_PATH=/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
npm run desktop:real-validation
```

Display name entered through the actual Teti Desktop first-launch UI:

```text
Teti Seep Alpha 01
```

Observed call path:

```text
Teti Desktop renderer
-> First Launch Coordinator
-> Tauri lifecycle_request
-> Rust managed lifecycle sidecar
-> Node lifecycle sidecar
-> TetiAccountManager.createTetiAccount({ name })
-> RuntimeChatmailProvisioner
-> deltachat-rpc-server
-> dcaccount:mail.seep.im
```

Creation marker timestamps:

- started: `2026-07-14T10:26:43.320Z`
- completed: `2026-07-14T10:26:47.049Z`

## Persistence And Discovery

- Real Chatmail account created: yes.
- Address: `bz0nwanxu@mail.seep.im`.
- Address suffix check: passed.
- Local Teti account persisted: yes.
- Delta Chat state persisted in profile-specific storage: yes.
- Chatmail account directory count: one account directory.
- Discovery registration: succeeded.
- `account.status` after restart returned `registered: true`.
- Renderer DTO contained public account fields only.

## Restart Validation

After creation, Teti Desktop was stopped with Ctrl-C from the dev process.

Shutdown result:

- Tauri dev process exited.
- Teti Desktop process exited.
- Node lifecycle sidecar exited.
- No `deltachat-rpc-server` process remained.
- No matching `teti-desktop`, `lifecycle-sidecar`, `tauri`, or `vite` process remained.

Restart command used the same profile and runtime configuration.

Restart result:

- Account loaded from `/private/tmp/teti-mail-seep-real-alpha-01/account/account.json`.
- Public Teti ID matched: `teti_bz0nwanxu`.
- Public Chatmail address matched: `bz0nwanxu@mail.seep.im`.
- Creation marker remained unchanged.
- Chatmail account directory count remained one.
- No second Chatmail account was created.
- Onboarding was skipped by existing-account load path.

## Duplicate Protection

Safe duplicate request:

```json
{
  "version": 1,
  "id": "duplicate-create",
  "ok": false,
  "error": {
    "code": "ACCOUNT_ALREADY_EXISTS",
    "message": "A Teti account already exists in this validation profile.",
    "recoverable": true
  }
}
```

After duplicate validation:

- creation marker remained `complete`;
- public Teti ID remained `teti_bz0nwanxu`;
- public address remained `bz0nwanxu@mail.seep.im`;
- Chatmail account directory count remained one;
- no provisioning started.

## Secret Audit

Checked sanitized public files:

- `account/account.json`
- `test-manifest.json`
- `lifecycle/creation-marker.json`

No `password`, `token`, `credential`, `secret`, `stack`, or raw `dcaccount` payload was found in those files.

The profile does contain the real Delta Chat account database under `credentials/chatmail-accounts`; that directory was not printed or committed.

## Code Changes

- Added `integrations/chatmail/relay-config.ts`.
- Added `integrations/chatmail/relay-diagnostics.ts`.
- Added `integrations/chatmail/runtime-diagnostics.ts`.
- Added `integrations/chatmail/runtime-config.test.ts`.
- Added `integrations/chatmail/runtime-diagnostics.test.ts`.
- Added `integrations/chatmail/relay-config.test.ts`.
- Added `apps/desktop/scripts/rpc.ts`.
- Added `apps/desktop/scripts/bootstrap-mac.ts`.
- Added final address suffix validation in `TetiAccountManager`.
- Strengthened real-validation preflight with RPC and relay diagnostics.
- Added deterministic repo-local RPC path resolution.
- Added `.tools/` to `.gitignore`.

## Tests

Passed:

```bash
npm run desktop:test
npm run desktop:typecheck
npm run desktop:build
npm test
npm run desktop:rpc:verify
npm run desktop:bootstrap:mac
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
```

Observed final counts:

- Desktop tests: 37 passed.
- Full JS tests: 112 passed.
- Rust tests: 8 passed.
- Tauri release build: passed.
- Repository-local RPC verify: passed.
- Bootstrap script: passed and did not create a real account.

Additional targeted tests after new-Mac script work:

- Runtime/relay/account targeted tests: 25 passed.
- `desktop:rpc:verify` with the approved current-Mac binary: passed.
- Repository-local real preflight for `/private/tmp/teti-mail-seep-real-alpha-03`: passed without `TETI_DELTACHAT_RPC_PATH`, then the temporary profile was cleaned.

## Release Bundling Status

Current release build classification: source-build usable, development-only for runtime dependencies.

The Tauri app does not yet bundle:

- Node lifecycle sidecar as a standalone executable;
- `deltachat-rpc-server` as a Tauri sidecar/resource.

Production distribution still needs sidecar/resource packaging, executable permission preservation, code signing, notarization, license notes, and runtime resolution without developer environment variables.

## Known Limitations

- The real profile is retained locally and contains real account state.
- No remote deletion flow was used for Chatmail or discovery.
- Tauri release build is not self-contained.
- Visual ready/collapse was inferred from successful coordinator completion and persisted account/marker state; no screenshot automation was added in this phase.

## Next Milestone

Run the new-Mac source setup on a second Apple Silicon Mac without creating a second identity until preflight passes and a new explicit approval is given.
