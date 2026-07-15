# Teti First Launch Alpha Result

## Files Changed

Added:

- `docs/implementation/TETI_FIRST_LAUNCH_ALPHA_AUDIT.md`
- `docs/implementation/TETI_FIRST_LAUNCH_ALPHA_RESULT.md`
- `apps/desktop/src/first-launch/state-machine.ts`
- `apps/desktop/src/first-launch/coordinator.ts`
- `apps/desktop/src/first-launch/notch-window.ts`
- `apps/desktop/src/first-launch/view-model.ts`
- `apps/desktop/src/first-launch/index.ts`
- `apps/desktop/test/first-launch.test.ts`

Updated:

- `apps/desktop/README.md`
- `package.json`

Existing unrelated working-tree changes in core/chatmail scripts and docs were not modified.

## Architecture Implemented

This phase implements the testable desktop first-launch orchestration layer.

Implemented pieces:

- `FirstLaunchStateMachine`: the single authoritative state model for first-launch state.
- `FirstLaunchCoordinator`: owns startup detection, name submission, lifecycle calls, duplicate-submit prevention, discovery retry, account verification, and ready-to-idle collapse.
- `NotchWindowController`: an interface between lifecycle state and the future native notch/island window.
- `MemoryNotchWindowController`: test implementation for expand/collapse behavior.
- `toFirstLaunchViewModel()`: compact UI view-model for the eventual notch panel renderer.

Not implemented in this phase:

- Native Tauri/Rust macOS notch window shell.
- Final Teti character renderer.
- Final visual polish or pixel-perfect motion.
- Real manual launch of Teti Desktop, because no Tauri app exists in this repo yet.

## State Transition Table

| From | Trigger | To |
| --- | --- | --- |
| `booting` | `initialize()` starts | `checking_existing_account` |
| `checking_existing_account` | valid account loaded | `idle` |
| `checking_existing_account` | no account | `welcome` |
| `checking_existing_account` | load error | `recoverable_error` or `fatal_error` |
| `welcome` | user starts naming | `naming` |
| `naming` | valid submit | `creating_identity` |
| `naming` | empty/invalid name | `recoverable_error` |
| `creating_identity` | lifecycle phase changes | `creating_identity` |
| `creating_identity` | account created and verified | `ready` |
| `creating_identity` | no persisted account after failure | `recoverable_error` or `fatal_error` |
| `creating_identity` | persisted account after failure | `recoverable_error` with `discovery_registration_failure` |
| `recoverable_error` | retry discovery | `registering_discovery` |
| `registering_discovery` | registration succeeds and account verifies | `ready` |
| `registering_discovery` | registration fails | `recoverable_error` |
| `ready` | auto-collapse or Done | `idle` |

## Authoritative Account Creation Call Path

The desktop first-launch coordinator calls only:

```ts
accountLifecycle.createTetiAccount({ name })
```

In production this should be backed by `TetiAccountManager.createTetiAccount()`.

The coordinator does not directly create Chatmail accounts, generate credentials, configure relay settings, or write account storage. Those responsibilities remain in the existing account lifecycle and Chatmail provisioner.

## Persistence Boundary

The existing account manager persists local Teti account metadata before discovery registration. This means discovery registration can fail after a local account exists.

The coordinator handles this by:

1. catching creation failure;
2. calling `loadTetiAccount()`;
3. if an account exists, classifying the failure as `discovery_registration_failure`;
4. preserving the loaded account in state;
5. retrying discovery independently instead of creating another Chatmail identity.

This is the main duplicate-identity prevention behavior added in this phase.

## Discovery Retry Behavior

`retryDiscoveryRegistration()`:

- requires a persisted account from state or `loadTetiAccount()`;
- calls `DiscoveryClient.registerIdentity(toDiscoveryRegistrationPayload(account))`;
- verifies the account can still be loaded;
- transitions to `ready` on success;
- stays in `recoverable_error` on failure;
- never calls `createTetiAccount()`.

This means a discovery outage after local persistence does not create a second identity.

## Duplicate Identity Prevention Strategy

- Existing account detection calls `loadTetiAccount()` before onboarding.
- Existing account skips onboarding and collapses to idle.
- Duplicate submit is blocked while creation is in flight.
- Creation failure is followed by a local account reload.
- If reload succeeds, future retry is discovery-only.
- Repeated initialization with an existing account performs zero creation calls.

## Errors Implemented

Implemented error categories:

- `invalid_name`
- `temporary_account_load_failure`
- `corrupt_account`
- `chatmail_provisioning_failure`
- `local_persistence_failure`
- `discovery_registration_failure`
- `loaded_account_verification_failure`
- `unrecoverable_internal_state`

Frontend-facing errors are sanitized through `sanitizeError()`. It redacts secret-like `password=`, `token=`, `secret=`, and private-key strings and truncates long messages.

## Tests Run

Command:

```sh
npm test
```

Result:

- 74 tests passed.
- 0 failed.

New focused tests cover:

- no account enters onboarding;
- valid account skips onboarding;
- invalid name is rejected;
- duplicate submit is blocked;
- provisioning success persists and reloads account;
- provisioning failure can retry;
- persistence failure never reaches ready;
- discovery failure does not create a second identity;
- repeated initialization does not create duplicate identities;
- ready transitions into idle;
- secret-like error text is sanitized.

Not run:

- formatter: no formatter script/config exists in this repo.
- frontend type checks: no frontend package or typecheck script exists in `apps/desktop`.
- Rust formatting/tests: no Tauri/Rust project exists in this repo.
- relevant Tauri tests: no Tauri test target exists in this repo.
- real Chatmail destructive/provisioning run: not run to avoid creating real accounts during automated verification.

## Manual macOS Verification Results

Manual macOS Teti Desktop verification was not completed in this phase.

Reason:

- `apps/desktop` currently contains no Tauri application, no `tauri.conf.json`, no Rust app entry point, no frontend entry point, and no native notch/island window implementation.

Verified through audit:

- There is no conventional desktop main window in the repo because the desktop app is not yet implemented.
- The new first-launch layer exposes a `NotchWindowController` interface for the future native notch window.

Manual verification still needed once the Tauri shell exists:

- built-in MacBook display with physical notch;
- external monitor;
- moving Teti between displays;
- disconnecting/reconnecting external displays;
- no scroll requirement in expanded panel;
- collapse to idle after real account creation.

## Unresolved Risks

- Real Tauri native notch window is still missing.
- Real Teti character and track renderer are still missing from this repo.
- `TetiAccountManager.createTetiAccount()` does not expose granular provisioning events, so UI progress phases are currently semantic rather than event-perfect.
- Discovery registration retry required desktop orchestration to call `DiscoveryClient.registerIdentity()` with the existing `toDiscoveryRegistrationPayload()` helper.
- If future account validation adds a maximum name length, first-launch UI must consume that rule instead of defining its own.
- Real Chatmail provisioning may require local `deltachat-rpc-server` and network access.

## Exact Recommended Next Phase

Build the native desktop shell and connect it to this orchestration layer:

1. Add the actual Tauri app structure under `apps/desktop`.
2. Implement a native macOS notch/island window that satisfies `NotchWindowController`.
3. Render the view-model from `toFirstLaunchViewModel()` inside the notch panel.
4. Wire production dependencies:
   - `new TetiAccountManager()`
   - `new RegistryDiscoveryClient()`
   - real notch window controller
5. Add the current Teti character renderer with square face, small eyes, and restrained track motion.
6. Run real macOS manual verification on built-in and external displays.
7. Only after that, refine visual polish and animation.
