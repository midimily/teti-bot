# Teti `0.4.1-alpha.3` Windows native shell

## Implemented scope

`0.4.1-alpha.3` keeps one renderer and adds the Windows-native shell and file
boundary required by M3:

- the companion is centered in the selected monitor work area using physical
  pixels and that monitor's scale factor, including negative monitor
  coordinates and taskbars placed at the top;
- `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, and `WM_SETTINGCHANGE` coalesce into a
  bounded resize/reposition pass;
- input modes explicitly request focus, while idle/processing modes do not;
- Windows power broadcasts emit the same semantic sleep/wake events used by
  macOS, and duplicate resume broadcasts are collapsed;
- restart first shuts down the owned Runtime and its Job before relaunching;
- image selection and Save As use parented native dialogs, while open and
  reveal use the cross-platform native opener;
- the Asset protocol exposes only stored `input` and `artifact` image trees.
  Artifact documents and the remainder of the Profile are outside scope;
- Windows drive-letter paths are accepted by the attachment store, UNC and
  drive-relative paths are rejected, and real-path containment blocks a
  symlink or junction from redirecting a write outside the store;
- open, reveal, and Save As accept only canonical image files below the exact
  active Profile's Artifact image root;
- local reset accepts only the Profile path resolved from the current app,
  rejects linked/reparse-point roots, retries bounded Windows sharing
  violations after Runtime shutdown, and preserves sibling LocalAppData data;
- native failures cross the renderer boundary as stable `{ code }` objects.
  English and Simplified Chinese map those codes to safe catalog messages.

## Automated evidence completed on macOS

- TypeScript typecheck;
- localized-copy and icon verification;
- 700/700 repository tests, including both catalogs, Windows path rules,
  attachment junction containment, and stable native error mapping;
- 31/31 Mac Rust tests;
- `x86_64-pc-windows-msvc` Rust shell cross-check, including Windows-only
  message, ACL, Job Object, and file-operation sources;
- production renderer build;
- ad-hoc signed and verified Mac `.app` at
  `apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`.

This evidence does not claim the real Windows exit gate. Per-monitor DPI,
Win32 power broadcasts, Explorer integration, native dialogs, reparse-point
semantics, restart, and Profile deletion must still run on the Wintel host.

## Real Wintel exit gate

Run from a Windows x64 development checkout after completing the M2 Runtime
artifact procedure:

```powershell
npm ci --prefix apps/desktop
npm run desktop:typecheck
npm run desktop:i18n-check
npm run desktop:icon:verify
npm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:runtime:windows:verify
npm run desktop:runtime:windows:exit-gate -- --display-name "Teti Windows Alpha 3"
npm run desktop:tauri-build:windows:shell
& .\apps\desktop\src-tauri\target\release\teti-desktop.exe
```

Use an isolated Windows user or test VM and verify all of the following in
both automatic Chinese and forced English, then automatic English and forced
Chinese:

1. Move the companion between at least two monitors with different scaling
   (for example 100% and 150%/200%), including a monitor left of the primary.
   It must remain centered inside the active work area after DPI, resolution,
   taskbar-position, dock/undock, and resume changes.
2. Open an input surface and confirm focus, hide/show it, sleep and resume the
   machine, then restart Teti. Presence must recover and no pre-restart Runtime
   descendant may survive.
3. Pick PNG/JPEG images from a local drive. Cancel must be a no-op. Open and
   reveal a result, Save As to a path containing spaces and non-ASCII text, and
   confirm overwrite/cancel behavior follows the native dialog.
4. Attempt a non-Artifact path, unsupported extension, missing file, and an
   attachment subdirectory redirected through a junction. Each operation must
   fail safely without revealing the path; no file may be read or written
   outside the allowed tree.
5. From Settings, reset the local Profile. Only
   `%LOCALAPPDATA%\bot.teti.app\profile` may be removed; the sibling `logs`
   directory and an external sentinel file must remain. A junction at the
   Profile root must be rejected. Teti must restart into First Launch.

The gate passes only when the packaged Windows process completes this matrix
with stable codes and the same semantic outcome in both locales.
