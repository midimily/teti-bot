# Teti `0.4.1-beta.2` Windows installer, upgrade, and signing

## Outcome

`0.4.1-beta.2` owns a localized, per-user NSIS release pipeline. The pipeline
embeds the Microsoft WebView2 Evergreen bootstrapper, requires SHA-256
Authenticode signing with an RFC 3161 HTTPS timestamp, verifies every shipped
PE, and emits a machine-readable manifest plus `SHA256SUMS`.

The installer deliberately owns only application files below its per-user
installation directory. The stable `bot.teti.app` AppLocalData root, protected
Profile, WebView state, and language preference are not uninstaller-owned.
Changing the identifier in this milestone is prohibited because it would
silently fork upgrade state.

## Implemented release boundary

- NSIS `currentUser` install mode; no machine-wide install fallback.
- Built-in NSIS `English` and `SimpChinese` installer resources, selected from
  the Windows UI language without adding a renderer catalog fork.
- `embedBootstrapper` with silent Evergreen installation when WebView2 is
  absent. The bootstrapper still requires network access to Microsoft's
  Evergreen service on the clean VM.
- LZMA setup, localized install/uninstall surfaces, Start Menu ownership, and
  explicit no-delete installer hooks.
- Release-mode signing for staged `node.exe`,
  `deltachat-rpc-server.exe`, every allowlisted Runtime DLL, the Rust
  application executable, generated uninstaller, and final setup executable.
- Fail-closed signer thumbprint, PE/x64, Authenticode status, and trusted
  timestamp verification.
- A JSON release manifest containing source Runtime pins, artifact role, size,
  SHA-256, signer, timestamp certificate, install mode, locale set, WebView2
  mode, and stable state paths.
- Native language preference persistence at
  `Profile/preferences/locale.json`. Existing beta.1 localStorage preferences
  migrate on first beta.2 launch; WebView localStorage remains a compatibility
  mirror.

Development builds may skip Authenticode. The `windows:release` command always
sets release signing mode itself and cannot produce an unsigned release.

## Windows release build

Use a real Windows x64 build host with Node 22, the Rust MSVC toolchain, the
Windows SDK, the pinned Teti Runtime inputs, and a code-signing certificate in
the current user's certificate store. Set:

```powershell
$env:TETI_WINDOWS_CERTIFICATE_SHA1 = "<40-hex certificate thumbprint>"
$env:TETI_WINDOWS_SIGNTOOL_PATH = "C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64\signtool.exe"
$env:TETI_WINDOWS_TIMESTAMP_URL = "https://<rfc3161 timestamp service>"
npm run desktop:windows:release
```

The command builds NSIS, signs and re-verifies all release PEs, then writes:

- `dist/windows/teti-0.4.1-beta.2-windows-x64-manifest.json`
- `dist/windows/teti-0.4.1-beta.2-windows-x64-SHA256SUMS.txt`

`npm run desktop:windows:inventory` re-verifies an existing signed build and
regenerates the inventory. Missing certificate configuration, a non-HTTPS
timestamp service, a missing timestamp, an unexpected signer, a non-x64 PE,
or more than one setup executable fails the command.

## Clean-VM gates

Run the scenarios on separate restored VM snapshots or separate clean Windows
users. Both scripts refuse a pre-existing Teti installation or AppLocalData
root.

### A. Current release, missing WebView2, repair, and uninstall

```powershell
npm run desktop:windows:installer-smoke -- `
  -Scenario Clean `
  -CurrentInstaller "C:\release\Teti_0.4.1-beta.2_x64-setup.exe" `
  -RequireMissingWebView2 `
  -EvidencePath "C:\evidence\teti-m6-clean.json"
```

This gate proves the setup signature, per-user HKCU registration and
LocalAppData install, WebView2 bootstrap from an absent state, installed PE
inventory, Node + DeltaChat JSON-RPC Runtime health, Job Object descendant
cleanup, same-version repair, uninstall, and Profile/language preservation.

### B. Signed prerelease upgrade

```powershell
npm run desktop:windows:installer-smoke -- `
  -Scenario Upgrade `
  -PreviousInstaller "C:\release\Teti_0.4.1-beta.1_x64-setup.exe" `
  -CurrentInstaller "C:\release\Teti_0.4.1-beta.2_x64-setup.exe" `
  -EvidencePath "C:\evidence\teti-m6-upgrade.json"
```

This gate installs the previous signed prerelease, starts its Runtime, writes
bounded Profile and forced `zh-Hans` preference sentinels, upgrades in place,
starts beta.2, repeats repair, uninstalls, and verifies byte-identical state at
every boundary.

## Release approval

M6 implementation is complete in source and cross-platform automated checks:
719 repository tests, 32 Rust tests, typecheck, localization/icon guards,
Windows x64 Rust cross-check, Windows overlay parse, production renderer, and
the ad-hoc signed beta.2 Mac `.app` pass. No DMG was built.

The milestone exit gate is not complete until the release certificate is
available and both evidence files are produced by real clean Wintel VM runs.
Mac cross-compilation cannot establish Windows Authenticode trust, NSIS
execution, missing-WebView2 recovery, UAC behavior, registry ownership, or
Runtime process survival on Windows, so it must not be cited as that evidence.
