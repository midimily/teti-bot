# Teti macOS Experience Compatibility Result

Date: 2026-07-15.

## Summary

This pass completed the local Tahoe side of the Teti macOS Desktop Experience and Compatibility Beta foundation:

- Created a desktop-specific Teti macOS icon system.
- Enabled `.app` bundling with Teti product identity.
- Set explicit macOS 15.0 deployment targets in Tauri and Cargo.
- Reworked the first-launch island visual shell away from debug/alpha styling.
- Removed visible mock/debug badge from the user UI.
- Routed sidecar stderr to a sanitized local log file.
- Added metadata/icon/deployment/copy tests.
- Built and inspected `Teti.app` on macOS Tahoe 26.

The Sequoia 15 machine has not yet been run in this Codex session, so Sequoia results remain NOT TESTED.

## Initial Shell Classification

The current “shell interface” problem was classified as:

3. an unfinished island UI that visually resembled a development shell.

Secondary issues:

- bundle generation was disabled;
- Tauri icon configuration was empty;
- sidecar stderr was inherited instead of routed to a product log;
- minimum macOS deployment target was not explicit.

No conventional Tauri main window was configured: `app.windows` was already empty, and the app uses a programmatic `island` WebView window.

## Screenshots And Visual Evidence

Generated visual assets:

- Source icon: `apps/desktop/assets/icon-source.png`.
- Size inspection sheet: `apps/desktop/assets/icon-inspection-sheet.png`.

Runtime screenshot capture:

- Attempted with `screencapture -x docs/implementation/teti-tahoe-app-launch-after.png`.
- Result: blocked/unavailable in this Codex desktop environment with `could not create image from display`.

Because screenshot capture failed, runtime visible-surface evidence is limited to bundle inspection and process-list verification in this run.

## Icon Result

Source:

- Imported logo source: `apps/desktop/assets/teti-logo-default.png`.
- `apps/desktop/assets/icon-source.png` at 1024x1024.

Generated:

- `apps/desktop/src-tauri/icons/32x32.png`
- `apps/desktop/src-tauri/icons/128x128.png`
- `apps/desktop/src-tauri/icons/128x128@2x.png`
- `apps/desktop/src-tauri/icons/icon.png`
- `apps/desktop/src-tauri/icons/icon.icns`
- `apps/desktop/src-tauri/icons/Teti.iconset/*`

Verification:

- `npm run desktop:icon:generate`: PASS.
- `npm run desktop:icon:verify`: PASS.
- 16x16 and 32x32 dark eye visibility is checked programmatically.

Note:

- On this Tahoe 26 environment, `iconutil` reported `Invalid Iconset` even for a control iconset generated from the website logo with `sips`.
- The generator therefore writes a valid ICNS PNG container fallback when `iconutil` fails.
- `file` identifies the bundled resource as `Mac OS X icon`.

## Application Identity

Final identity:

- Product name: `Teti`.
- Visible app name: `Teti`.
- Executable: `teti-desktop`.
- Bundle identifier: `im.midimily.teti.desktop`.
- Version: `0.1.0`.
- Category: `public.app-category.productivity`.
- Copyright: `Copyright © 2026 Teti`.
- Icon file: `icon.icns`.

Bundle inspection from `Teti.app/Contents/Info.plist`:

- `CFBundleDisplayName`: `Teti`.
- `CFBundleExecutable`: `teti-desktop`.
- `CFBundleIdentifier`: `im.midimily.teti.desktop`.
- `CFBundleIconFile`: `icon.icns`.
- `LSMinimumSystemVersion`: `15.0`.

## Deployment Target

Supported Beta target:

- macOS 15.0 or later.
- Apple Silicon arm64.

Not claimed:

- macOS 14 or earlier.
- Intel Macs.
- Universal binaries.
- Mac App Store distribution.

Consistency checks:

- Tauri config: `bundle.macOS.minimumSystemVersion = "15.0"`.
- Cargo config: `MACOSX_DEPLOYMENT_TARGET = "15.0"`.
- Built app binary: Mach-O `LC_BUILD_VERSION minos 15.0`.
- Built app architecture: arm64.

RPC binary inspection:

- Version: `2.54.0-dev`.
- Architecture: arm64.
- Current binary `LC_BUILD_VERSION minos`: 11.0.
- Tahoe execution: PASS via `npm run desktop:rpc:verify -- --profile /tmp/teti-rpc-compat-profile`.
- Sequoia execution: NOT TESTED.

## Startup And Window Behavior

Built `.app`:

- Path: `apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`.
- Launch command tested on Tahoe: `open apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`.
- Result: app process launched.
- Process evidence: `/Contents/MacOS/teti-desktop` was running.
- No Node lifecycle sidecar or `deltachat-rpc-server` process appeared during the default mock launch.

Static native window behavior:

- no configured conventional `app.windows` entry;
- programmatic window label: `island`;
- borderless: yes;
- transparent: yes;
- always-on-top: yes;
- skip taskbar: false, so Dock/app switcher presence remains available.

## Logging Behavior

Native bridge sidecar stderr now routes to:

- `~/Library/Logs/Teti/teti-desktop.log`.

Rotation:

- active log rotates to `teti-desktop.log.1` after 1 MB.

Redaction:

- password, token, secret, credentials, and privateKey-like values are redacted before log write.

Tests:

- Rust redaction unit test: PASS.
- frontend/sidecar redaction tests: PASS.

## UI Changes

First-launch island:

- Removed visible mock scenario badge.
- Replaced internal/technical copy with user-facing phases:
  - “Waking up”
  - “Creating my identity”
  - “Securing my place on this Mac”
  - “Connecting”
  - “Ready”
- Added tests that visible copy avoids transport and credential internals.
- Rebuilt CSS tokens for Teti blue, text, focus, processing, success, warning, error, radius, spacing, duration, and easing.
- Preserved square Teti face, small eyes, track, compact island, and reduced-motion support.

Idle UI:

- Existing-account startup still maps to collapsed idle presence.
- Tests cover existing-account idle path and duplicate-prevention behavior.

## Tahoe 26 Result

Machine:

- macOS 26.5.2.
- Build 25F84.
- Apple Silicon arm64.
- Xcode 26.5 build 17F42.
- SDK 26.5.

Passed:

- icon generation;
- icon verification;
- desktop typecheck;
- desktop tests;
- root tests;
- frontend build;
- cargo fmt check;
- cargo check;
- cargo test;
- Tauri build;
- app bundle metadata inspection;
- app launch via `open`;
- process-list launch sanity check;
- RPC verify and clean shutdown.

Blocked or not tested:

- runtime screenshots, because `screencapture` failed in this environment;
- Dock/Cmd-Tab/Force Quit/About panel visual icon screenshots;
- Mission Control, Spaces, external display, sleep/wake, lock/unlock;
- Chinese input method manual test.

## Sequoia 15 Result

Status: NOT TESTED in this run.

Required next run on the second Apple Silicon Mac:

- execute the source-build path in `docs/testing/TETI_MACOS_COMPATIBILITY_MATRIX.md`;
- inspect built `.app` bundle metadata;
- verify RPC execution on macOS 15;
- launch mock `.app`;
- verify icon in Finder/Dock/Cmd-Tab;
- do not create a second real Chatmail identity without separate approval.

## Compatibility Matrix

Full matrix:

- `docs/testing/TETI_MACOS_COMPATIBILITY_MATRIX.md`.

Summary:

- Tahoe 26: core build, icon, app bundle, deployment target, mock launch, and RPC checks passed.
- Sequoia 15: pending.

## Version-Specific Branches

No macOS-version-specific runtime branches were added.

If a Sequoia/Tahoe difference is later demonstrated, it should be centralized in the native platform/window layer and documented with:

- affected versions;
- observed behavior;
- fallback;
- test coverage;
- removal condition.

## Distribution Classification

Current `.app` classification:

- unsigned development test bundle;
- not notarized;
- not an installer;
- not Mac App Store-ready;
- not self-contained for transferred real-account creation.

Known packaging limitation:

- Real lifecycle sidecar execution still depends on the current development checkout/runtime strategy.
- The produced `.app` is sufficient for local bundle identity, icon, mock launch, and native shell validation, but not yet a standalone distributable real-account app.

## Verification Commands

Passed:

```sh
npm run desktop:icon:generate
npm run desktop:icon:verify
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build-diagnostics
npm run desktop:build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
npm run desktop:rpc:verify -- --profile /tmp/teti-rpc-compat-profile
npm test
```

Additional Tahoe inspection:

```sh
plutil -p apps/desktop/src-tauri/target/release/bundle/macos/Teti.app/Contents/Info.plist
file apps/desktop/src-tauri/target/release/bundle/macos/Teti.app/Contents/MacOS/teti-desktop
file apps/desktop/src-tauri/target/release/bundle/macos/Teti.app/Contents/Resources/icon.icns
otool -l apps/desktop/src-tauri/target/release/bundle/macos/Teti.app/Contents/MacOS/teti-desktop
open apps/desktop/src-tauri/target/release/bundle/macos/Teti.app
```

## Next Milestone

Complete the Sequoia 15 compatibility run and then package the lifecycle sidecar/runtime so a copied unsigned `.app` can run real non-destructive preflight without depending on the source checkout.
