# Teti First Launch Alpha Audit

## Current Architecture

The repository currently has a real account and Chatmail lifecycle layer, but the desktop app is only a placeholder.

Desktop app:

- `apps/desktop/README.md` says this package will contain the Tauri desktop client, macOS notch UI, and local Teti runtime.
- No `tauri.conf.json`, Rust Tauri entry point, frontend entry point, notch-window code, onboarding component, Teti face component, track animation, or design-token implementation currently exists in this repo.
- No conventional main window is currently created because there is no Tauri app implementation yet.

Account lifecycle:

- `TetiAccountManager.createTetiAccount()` is the authoritative creation path.
- `loadTetiAccount()` reads local account storage and validates the stored record.
- `ChatmailProvisioner.createIdentity(displayName)` owns automatic Chatmail identity creation.
- `FileTetiAccountStorage` persists local Teti metadata to `~/.teti/account.json`.
- Storage validation rejects private keys, passwords, Chatmail credentials, database paths, and unsupported account versions.
- Discovery registration happens after local account persistence in `TetiAccountManager.createTetiAccount()`.
- `getTetiStatus()` can detect local-account existence and whether discovery registration is visible.
- There is no heartbeat scheduling layer in the first-launch path.

## Lifecycle Sequence

Authoritative create sequence in `TetiAccountManager.createTetiAccount()`:

1. Load existing account.
2. If an account already exists, return it without creating another Chatmail identity.
3. Resolve display name from `displayName` or `name`.
4. Use `ChatmailProvisioner.createIdentity(displayName)` when automatic provisioning is active.
5. Scan environment and build public profile.
6. Build `TetiAccount`.
7. Persist account through `TetiAccountStorage.save()`.
8. Register public discovery identity through `DiscoveryClient.registerIdentity()`.
9. Return account.

Important persistence boundary:

- If discovery registration fails after `storage.save()`, a local account may already exist even though `createTetiAccount()` rejects.
- First-launch orchestration must reload the account after creation failure before deciding whether retry should create another identity.

## Reuse Candidates

Reuse directly:

- `TetiAccountManager.createTetiAccount()`
- `TetiAccountManager.loadTetiAccount()`
- `TetiAccountManager.getTetiStatus()`
- `ChatmailProvisioner.createIdentity(displayName)` through the account manager
- `FileTetiAccountStorage` validation and privacy guarantees
- `RegistryDiscoveryClient.registerIdentity()`
- `toDiscoveryRegistrationPayload()`

Add in desktop layer:

- First-launch state machine.
- First-run detection coordinator.
- Sanitized frontend error model.
- Notch window controller interface.
- Minimal view-model mapping for the eventual Tauri UI.

## Conflicting Or Duplicate Flows

No existing desktop onboarding flow was found.

The main lifecycle risk is not duplicate UI; it is duplicate identity creation after a partial success. Since account persistence happens before discovery registration, a discovery failure must be handled as a persisted-account-with-registration-retry path, not as a reason to call `createTetiAccount()` again.

## Risks

- No native Tauri/notch implementation exists in this repository, so full macOS manual verification cannot be completed until that layer is added.
- Real Chatmail provisioning may require `deltachat-rpc-server` availability and network access.
- Discovery registration can fail after local account persistence.
- There is no current max display-name length rule in the account model.
- There is no current UI component or Teti character asset in `apps/desktop`.
- Existing unrelated working-tree changes in core/chatmail files should not be modified by this phase.

## Proposed Files To Change

- `apps/desktop/src/first-launch/state-machine.ts`
- `apps/desktop/src/first-launch/coordinator.ts`
- `apps/desktop/src/first-launch/notch-window.ts`
- `apps/desktop/src/first-launch/view-model.ts`
- `apps/desktop/src/first-launch/index.ts`
- `apps/desktop/test/first-launch.test.ts`
- `apps/desktop/README.md`
- `docs/implementation/TETI_FIRST_LAUNCH_ALPHA_RESULT.md`
- `package.json` test script, if needed, to include desktop tests

## Proposed Files Not To Change

- Existing `core/account/*` lifecycle implementation.
- Existing `integrations/chatmail/*` provisioning and RPC implementation.
- Existing discovery registry client behavior.
- Stitch project data.
- Website logo source asset.
- Unrelated connection/messaging changes already present in the working tree.
