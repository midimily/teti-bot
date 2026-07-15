# Teti Desktop

Placeholder for the Tauri desktop client, macOS notch UI, and local Teti runtime.

## First Launch Alpha

The current implementation adds the testable first-launch orchestration layer under
`apps/desktop/src/first-launch`.

It includes:

- an explicit first-launch state machine
- first-run account detection through the existing account lifecycle
- real account creation orchestration through `TetiAccountManager.createTetiAccount()`
- discovery-registration retry behavior after a persisted local account
- duplicate-submit prevention
- sanitized frontend error mapping
- a `NotchWindowController` interface for the future native Tauri notch window
- a compact view-model for the first-launch notch UI

The repository still does not contain the native Tauri/Rust notch window shell or final Teti
character renderer. Those pieces should consume this orchestration layer instead of duplicating
account lifecycle decisions in UI components.

## Desktop Shell Alpha

`apps/desktop` now contains a Tauri v2 + Vite desktop shell for the first-launch flow. It opens a
single borderless transparent island window, renders the First Launch Alpha view model, and talks to
native window commands through `TauriNotchWindowController`.

Useful commands from the repository root:

- `npm run desktop:dev`
- `npm run desktop:build`
- `npm run desktop:typecheck`
- `npm run desktop:test`
- `npm run desktop:rust-check`
- `npm run desktop:rust-fmt`
- `npm run desktop:tauri-build`

Provisioning defaults to mock mode:

```sh
TETI_PROVISIONING_MODE=mock npm run desktop:dev
```

Mock scenarios:

- `TETI_MOCK_PROVISIONING_SCENARIO=success`
- `TETI_MOCK_PROVISIONING_SCENARIO=delayed_success`
- `TETI_MOCK_PROVISIONING_SCENARIO=provisioning_failure`
- `TETI_MOCK_PROVISIONING_SCENARIO=discovery_failure`
- `TETI_MOCK_PROVISIONING_SCENARIO=persistence_failure`

Real mode is explicit:

```sh
TETI_PROVISIONING_MODE=real npm run desktop:dev
```

Real mode must use the lifecycle bridge. If the bridge is unavailable, the app reports an explicit
sanitized error and does not fall back to mock success.

## Lifecycle Bridge Alpha

Real mode now calls a trusted local lifecycle bridge:

```text
renderer -> Tauri lifecycle_request command -> Rust-managed Node sidecar -> existing Teti lifecycle
```

The sidecar protocol is newline-delimited JSON over stdin/stdout. Stdout is reserved for protocol
responses; sanitized diagnostics may go to stderr.

Useful non-destructive smoke check:

```sh
printf '%s\n' '{"version":1,"id":"health","method":"lifecycle.health","params":{}}' \
  | node --experimental-strip-types apps/desktop/lifecycle-sidecar/main.ts
```

Real desktop mode:

```sh
TETI_PROVISIONING_MODE=real npm run desktop:dev
```

Alpha packaging note: the release binary can be built, and the Rust bridge can resolve the source
sidecar in this development checkout. A self-contained distributed app still needs a bundled Node
runtime or compiled sidecar binary.
