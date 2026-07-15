# Teti macOS Experience Compatibility Plan

## Scope

Milestone: Teti macOS Desktop Experience and Compatibility Beta.

Targets:

- macOS Sequoia 15, Apple Silicon arm64.
- macOS Tahoe 26, Apple Silicon arm64.
- Proposed minimum macOS version: 15.0.

Out of scope:

- Teti-to-Teti connection and messaging.
- Creating another real Chatmail account.
- Changing the relay away from `mail.seep.im`.
- Intel, universal binary, macOS 14, App Store signing, notarization, or installer claims.

## Current-State Audit Before Production Edits

Static audit from the current checkout before this milestone's code changes:

| Surface | Current evidence | Classification |
| --- | --- | --- |
| Tauri config | `apps/desktop/src-tauri/tauri.conf.json` had `app.windows: []` and a programmatically-created `island` window. | Native island window; no configured conventional main window. |
| Bundle | `bundle.active: false`, `bundle.icon: []`. | Release binary existed, but app bundle identity/icon were incomplete. |
| Icon | `apps/desktop/src-tauri/icons/icon.png` was the only icon artifact. | Placeholder/remnant risk. |
| Startup UI | Existing island UI used alpha/debug-like copy and a visible mock badge in mock mode. | Unfinished island UI that visually resembled an engineering shell. |
| Sidecar output | Rust bridge inherited sidecar stderr. | Debug diagnostics could leak into developer launch output. |
| Minimum macOS | No explicit Tauri bundle minimum or Cargo deployment target. | Compatibility target not pinned. |

Initial shell-problem classification:

3. The primary issue was an unfinished island UI that visually resembled a development shell.

Secondary issues:

- Bundle generation was disabled, so Finder/Dock identity could not be validated from a produced `.app`.
- Sidecar diagnostics were not routed to a product log file.

Actual screenshot capture of the pre-change app state was not available in this run. The repository had no generated `.app` bundle before the bundle settings were enabled, and macOS `screencapture` later failed in this Codex environment with `could not create image from display`.

## Application Identity Plan

Stable identity:

- Product name: `Teti`.
- Executable/internal target: `teti-desktop`.
- Bundle identifier: `im.midimily.teti.desktop`.
- Visible app name: `Teti`.
- Category: `public.app-category.productivity`.
- Version: `0.1.0`.
- Minimum macOS: `15.0`.
- Architecture claim: Apple Silicon arm64 only.

Migration risk:

- The bundle identifier should not be changed casually after real user profiles, launch services cache, or signing profiles depend on it.

## Icon Plan

Use the existing website logo only as a brand reference:

- Source reference imported into the repo: `apps/desktop/assets/teti-logo-default.png`.
- Desktop source icon: `apps/desktop/assets/icon-source.png`.
- Inspection sheet: `apps/desktop/assets/icon-inspection-sheet.png`.
- Generated Tauri/macOS outputs: `apps/desktop/src-tauri/icons/`.

Requirements:

- Preserve Teti blue palette, rounded square face, small dark eyes, and simple track.
- Verify 16x16 and 32x32 eye visibility.
- Do not overwrite website assets.
- Reproduce with `npm run desktop:icon:generate`.
- Verify with `npm run desktop:icon:verify`.

## UI Plan

Use `docs/design/TETI_FIRST_LAUNCH_DESIGN.md` as the visual source of truth.

States:

- startup/checking.
- welcome.
- naming.
- invalid-name feedback.
- provisioning.
- persistence.
- discovery registration.
- recoverable failure.
- fatal local failure.
- ready.
- idle.

Visible copy must avoid:

- IMAP, SMTP, Delta Chat RPC, DCACCOUNT, credentials, relay configuration, cryptographic keys.

Design direction:

- Compact island silhouette.
- Deep neutral island background.
- Teti blue highlights.
- Teti face as emotional anchor.
- One primary action per state.
- Reduced-motion support.

## Diagnostics Plan

User-facing UI:

- Show sanitized failure messages only.
- Do not stream raw sidecar/RPC output into the island.

Developer diagnostics:

- Log path: `~/Library/Logs/Teti/teti-desktop.log`.
- Rotation: rotate to `teti-desktop.log.1` when the active log exceeds 1 MB.
- Redaction: password/token/secret/credentials/privateKey-like values are replaced before write.

## Compatibility Plan

Tahoe 26:

- Run build diagnostics.
- Generate and verify icons.
- Typecheck, desktop tests, root tests.
- Frontend build.
- Cargo fmt/check/test.
- Tauri build.
- Inspect `.app` Info.plist, executable architecture, icon resource, and Mach-O deployment target.
- Launch built `.app` via `open`.
- Verify process list has `Teti.app/Contents/MacOS/teti-desktop` and no Node/RPC console in mock launch.

Sequoia 15:

- Run the same matrix on the second Apple Silicon Mac.
- Prefer source build path first.
- Use transferred unsigned `.app` only as a local development test artifact.
- Do not create another real Chatmail identity without separate approval.

## Test Automation Plan

Add or preserve coverage for:

- Bundle metadata.
- Icon file existence and config references.
- No Tauri default icon references.
- Explicit minimum macOS version.
- Build diagnostics fields.
- No release conventional Tauri main window.
- User copy avoids transport/credential internals.
- Log redaction.
- Existing-account idle path.
- Mock flow without network.
- Real mode remains explicit.
- No extra real account creation in compatibility automation.
