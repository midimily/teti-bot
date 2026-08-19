# Teti macOS ad-hoc Beta packaging

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

The command intentionally produces an arm64, macOS 15.0+, ad-hoc-signed, non-notarized Beta under:

```text
apps/desktop/release/
```

It builds only the App bundle first, signs the two embedded runtimes before signing the outer App, creates a simple DMG with an `/Applications` link, mounts the DMG for verification, and writes SHA-256, README, and JSON manifest artifacts. It does not use Developer ID credentials or contact Apple's notarization service.

The Tauri configuration advertises both `app` and `dmg` bundle capabilities. The controlled Alpha command overrides the build to `--bundles app` and creates the DMG only after custom inner-to-outer ad-hoc signing, preventing a DMG from capturing a pre-signing App.

## Trust boundary

This package is not a formal macOS release. Its manifest must always report:

```json
{
    "releaseChannel": "beta",
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

Never use `xattr -dr com.apple.quarantine` or `sudo spctl --master-disable` as part of this validation. Official Beta artifacts are published at <https://github.com/midimily/teti-bot/releases>; do not install repackaged copies from unofficial mirrors.

## Mac Studio GitHub Release upload exception

This development Mac has a host-specific fallback for large GitHub Release
uploads. Use it only after the normal `gh release upload` path repeatedly fails
with long-connection TLS errors such as `bad record MAC`, `unexpected EOF`, or a
broken pipe.

On this Mac, verify the hardware mapping before every use:

```bash
/usr/sbin/networksetup -listallhardwareports
/sbin/ifconfig en1
```

The expected mapping is `Hardware Port: Wi-Fi` to `Device: en1`, and `en1` must
report `status: active`. Do not assume the device name will remain stable after
network hardware or macOS configuration changes.

For the affected asset upload process only, pass the physical Wi-Fi interface to
the system curl client:

```text
/usr/bin/curl \
  --config <temporary-0600-github-auth-config> \
  --interface en1 \
  --http1.1 \
  --request POST \
  --header "Content-Type: application/x-apple-diskimage" \
  --data-binary @<absolute-dmg-path> \
  "https://uploads.github.com/repos/midimily/teti-bot/releases/<release-id>/assets?name=<asset-name>"
```

The wrapper invoking curl must obtain the token from `gh auth token`, write it
only to a newly created temporary config file with mode `0600`, avoid printing
the token, and remove the config in a `finally` cleanup. Before retrying, query
the release assets and stop if the same asset name already exists. Never delete
or replace a remote asset without explicit approval.

This exception binds one process to `en1`; it must not disable `utun4`, alter the
default route, disconnect a VPN, or make any other system network change. It is
specific to `uploads.github.com`. Do not use it as a general GitHub download
override because `release-assets.githubusercontent.com` may not be reachable on
the same bound path.

After upload, require all of the following evidence from GitHub before declaring
success:

- asset state is `uploaded`;
- remote byte size equals the local file size;
- remote `sha256` digest equals the local digest;
- the release remains a prerelease and targets the intended commit.

Validation on 2026-08-19 confirmed that Wi-Fi still maps to active `en1` and
that `https://uploads.github.com` completes TLS and returns HTTP `302` through
that interface. The `v0.4.1-beta.2` DMG itself finished uploading through the
rate-limited HTTP/1.1 retry immediately before the fallback was applied, so the
release record must not claim that `en1` was required for that particular asset.
