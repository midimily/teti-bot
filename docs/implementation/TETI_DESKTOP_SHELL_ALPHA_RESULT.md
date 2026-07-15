# Teti Desktop Shell Alpha Result

## Summary

Implemented the first runnable macOS desktop shell under `apps/desktop` using Tauri v2, Vite, and
framework-free TypeScript.

The shell connects the existing First Launch Alpha state machine/coordinator to a real native Tauri
window bridge. Default provisioning is mock-only and safe for development. Real provisioning remains
explicit and does not fall back to mock behavior.

## Added

- Tauri v2 app scaffold under `apps/desktop/src-tauri`.
- Vite + TypeScript frontend under `apps/desktop/src`.
- Single native island window labelled `island`.
- Transparent, borderless, always-on-top, top-center native window configuration.
- Native commands:
  - `set_island_mode`
  - `position_island`
  - `show_island`
  - `hide_island`
  - `current_monitor_info`
- Frontend bridge:
  - `TauriInvoker`
  - `TauriNotchWindowController`
  - view-model to window-mode mapping
- First-launch UI renderer for welcome, naming, processing, error, ready, and idle states.
- Mock provisioning modes:
  - `success`
  - `delayed_success`
  - `provisioning_failure`
  - `discovery_failure`
  - `persistence_failure`
- Desktop package scripts and root forwarding scripts.
- Desktop shell automated tests.
- Rust positioning and sizing tests.
- Tauri app icon placeholder required by Tauri build tooling.

## Real Provisioning Boundary

`TETI_PROVISIONING_MODE=real` is explicit only.

The browser-hosted Tauri frontend cannot directly import the repository's authoritative Node-backed
account lifecycle because that path uses Node filesystem/process APIs and Chatmail runtime adapters.
For this alpha, real mode intentionally throws inside the browser runtime with:

```text
Real provisioning requires the Node-backed Teti account lifecycle bridge. Do not fall back to mock mode.
```

The non-browser adapter still points to the authoritative lifecycle module for future bridge/sidecar
work. The app never silently substitutes mock provisioning when real mode is requested.

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

- Desktop TypeScript tests: 18 passed.
- Full repository Node tests: 82 passed.
- Rust tests: 3 passed.
- Tauri release binary built at:
  `apps/desktop/src-tauri/target/release/teti-desktop`

Notes:

- `cargo check` initially required network access to download Tauri/Rust crates.
- Frontend verification required installing `apps/desktop` npm dependencies.
- `desktop:tauri-build` builds the Tauri binary; interactive visual QA was not run in this pass.

## Follow-Up Recommendations

- Add a Node-capable Tauri command, sidecar, or local service for real account lifecycle execution.
- Replace the placeholder `src-tauri/icons/icon.png` with the final Teti app icon.
- Add screenshot-based manual QA for the native island window on notched and non-notched Mac displays.
- Add restart persistence QA for mock account storage in the packaged app.
