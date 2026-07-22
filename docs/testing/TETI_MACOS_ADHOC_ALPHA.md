# Teti macOS ad-hoc Alpha packaging

The frozen Teti Desktop Bundle Identifier is:

```text
bot.teti.app
```

The previous `im.midimily.teti.desktop` value was used by macOS for WebKit, Application Support, cache, preferences, saved-state, and container locations. Teti account, connection, Chatmail, lifecycle, and settings data use the independent `~/.teti` profile root. Packaging under the new identifier therefore does not migrate, delete, or recreate a Teti or Chatmail identity.

## Build

Run on an Apple Silicon Mac with the repository dependencies and pinned Chatmail RPC runtime already installed:

```bash
npm run desktop:package:mac:adhoc
```

The command intentionally produces an arm64, macOS 15.0+, ad-hoc-signed, non-notarized controlled Alpha under:

```text
apps/desktop/release/
```

It builds only the App bundle first, signs the two embedded runtimes before signing the outer App, creates a simple DMG with an `/Applications` link, mounts the DMG for verification, and writes SHA-256, README, and JSON manifest artifacts. It does not use Developer ID credentials or contact Apple's notarization service.

The Tauri configuration advertises both `app` and `dmg` bundle capabilities. The controlled Alpha command overrides the build to `--bundles app` and creates the DMG only after custom inner-to-outer ad-hoc signing, preventing a DMG from capturing a pre-signing App.

## Trust boundary

This package is not a formal macOS release. Its manifest must always report:

```json
{
  "releaseChannel": "alpha",
  "distribution": "adhoc",
  "notarized": false,
  "developerIdSigned": false,
  "gatekeeperTrusted": false
}
```

Do not disable Gatekeeper or remove quarantine attributes. A tester should use System Settings > Privacy & Security > Open Anyway after the expected first-launch block.

## Second-Mac checklist

Use an Apple Silicon Mac running macOS 15 or later, preferably a fresh local macOS user:

1. Transfer the DMG using AirDrop, cloud storage, or HTTPS.
2. Verify the SHA-256 against the supplied `.sha256` file.
3. Open the DMG and drag Teti to Applications.
4. Launch Teti and confirm Gatekeeper blocks the unnotarized build.
5. Open System Settings > Privacy & Security and choose Open Anyway for Teti.
6. Authorize with the local password if requested, then launch again.
7. Verify the first-launch or existing-account UI appropriate for that Mac.
8. Verify the embedded Node and Chatmail runtime start without a global Node installation or repository checkout.
9. Quit and relaunch Teti, then restart the Mac and test once more.
10. Confirm an existing Teti profile is retained and no duplicate identity is created.
11. Record relevant Console or crash logs.

Never use `xattr -dr com.apple.quarantine` or `sudo spctl --master-disable` as part of this validation.
