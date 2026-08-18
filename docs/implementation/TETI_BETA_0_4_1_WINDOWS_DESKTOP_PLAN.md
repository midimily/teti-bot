# Teti Beta 0.4.1 Windows Desktop Architecture and Release Plan

Status: architecture baseline for implementation.

Predecessor: `TETI_BETA_0_4_0_LOCALIZATION.md`.

## 1. Release decision

Beta 0.4.1 is the first Windows desktop release. It must extend the existing
desktop product instead of creating a Windows fork.

The application version is shared by both platforms:

- macOS: Teti 0.4.1.
- Windows: Teti 0.4.1.
- Lifecycle protocol remains version 1.
- Network protocol remains version 1.
- Profile schema remains version 2.
- Passport and Task wire schemas do not change only because a new host platform
  is added.

The Network release floor must not move to 0.4.1 until controlled interoperability
tests prove that a Windows 0.4.1 peer can collaborate with a Mac 0.4.0 peer. If a
wire-breaking change becomes necessary, Windows support moves to Beta 0.5.0
instead of hiding that break inside 0.4.1.

The repository remained at 0.4.0 during architecture work. M1 is the first
implementation slice, so all application version sources now move together to
`0.4.1-alpha.1`.

## 2. Supported platform matrix

### Beta 0.4.1 release targets

| Platform | Architecture | Support level | Product shell |
| --- | --- | --- | --- |
| macOS 15 and 26 | arm64 | Existing supported platform; no regression | Native notch-aware NSPanel |
| Windows 11 25H2 or later | x64 | New primary Windows target | Borderless top-center companion window |

Windows 11 25H2 x64 is the certification baseline. A 26H1 x64 smoke run is
required when suitable hardware or a VM is available.

### Explicitly out of scope for 0.4.1

- Windows 10 Home/Pro. Its general support ended in October 2025.
- Windows on ARM64.
- Windows 7/8.
- MSI, Microsoft Store, portable ZIP, and machine-wide installation.
- Automatic startup with Windows.
- Reproducing the physical Mac notch on Windows.
- Porting the macOS-only Osaurus Native Child implementation.
- Linux support.

These exclusions keep the first Windows release bounded around one OS family,
one CPU target, and one installer.

## 3. Current repository audit

### Already portable and shared

- The renderer uses HTML, CSS, TypeScript, Vite, and Tauri APIs.
- App Shell, First Launch, Connection, Passport, Task, Artifact, Memory, and
  release-policy Controllers consume semantic DTOs.
- Lifecycle request and response envelopes are platform-neutral JSON lines.
- Network headers and schemas already allow `windows` as a public platform.
- Environment metadata already recognizes Node's `win32` platform.
- Native image selection and save dialogs use `rfd`, which is cross-platform.
- The 0.4.0 locale resolver maps every Chinese locale, including Traditional
  Chinese variants, to the Simplified Chinese catalog and maps all other
  locales to English.
- The manual language preference is stored independently of the Teti Profile,
  so resetting a Profile does not unexpectedly reset the display language.

### Windows blockers found in the current code

| Boundary | Current coupling | Required correction |
| --- | --- | --- |
| Tauri configuration | macOS private API, `.icns`, `app`/`dmg`, and Mac resources live in the common config | Split common, macOS, and Windows Tauri configuration |
| Runtime bundle | Build rejects every host except Darwin arm64 and copies a Mach-O RPC server | Introduce a target manifest and Windows x64 artifacts |
| Runtime identity | Sidecar sends `clientPlatform: "macos"` | Resolve a typed host platform once and inject it |
| Profile and logs | Profile is `~/.teti`; Rust logs are fixed to `~/Library/Logs/Teti` | Introduce a native platform-path contract |
| File privacy | Node stores rely on POSIX `chmod(0600/0700)` | Create a protected Windows profile root with inherited user-only ACLs |
| Sidecar shutdown | Unix process groups receive TERM/KILL; non-Unix only kills the direct child | Use a Windows Job Object for the Runtime tree |
| Task cancellation | Callable transport signals POSIX process groups | Add a fixed, PID-only Windows process-tree terminator |
| Agent observation | `/bin/ps`, `plutil`, `.app`, and `/Applications` are hard-coded | Add a Windows observer and platform detector catalogs |
| Path validation | Several security checks define absolute paths as strings starting with `/` | Use `node:path.isAbsolute`, canonicalization, and platform-aware roots |
| Callable launch | Executables must begin with `/` | Accept canonical Windows drive/UNC paths under the same trust rules |
| Image Artifact paths | Image runner and attachment stores require `/...` paths | Share a canonical local-path validator |
| Native open/reveal | `/usr/bin/open` implements both actions | Add narrow ShellExecute/Explorer adapters on Windows |
| Native shell | macOS uses NSPanel, screen observers, Dock reopen, and AppKit sleep events | Add a Windows companion-window and system-event adapter |
| Styling | Font stack starts with Apple fonts | Add `"Segoe UI Variable"` and `"Segoe UI"` without forking layout |
| Packaging | Only `.app`/DMG inspection and codesign exist | Add NSIS, Authenticode, PE/runtime inventory, and upgrade tests |

The largest release gate is not the web UI. It is producing and validating a
pinned `deltachat-rpc-server.exe` and all of its required DLLs for Windows x64.
No Windows release claim is allowed until that Runtime passes the same JSON-RPC
health and clean-shutdown smoke tests as the Mac Runtime.

## 4. Target architecture

```text
Shared renderer and product behavior
  App Shell / First Launch / Passport / Connection / Task / Memory
  one typed English catalog + one typed Simplified Chinese catalog
  shared Controllers, DTOs, formatters, validation, and stable error codes
                         |
                  typed Tauri commands
                         |
Shared Rust application boundary
  command validation / lifecycle bridge / file-dialog commands
  platform path contract / platform info / stable native error codes
             |                               |
      macOS adapter                    Windows adapter
  NSPanel + AppKit events        top-center window + Win32 events
  open/reveal via LaunchServices ShellExecute/Explorer open/reveal
  POSIX process groups           Job Object/process-tree control
  Apple runtime bundle           Windows x64 runtime bundle
  codesign + DMG                 Authenticode + NSIS
             \                               /
              shared Node lifecycle sidecar
       account / Network / Passport / Task / Memory
       platform-selected Agent observer and detector catalog
```

### Non-negotiable boundary

Platform branching is allowed only in:

- `src-tauri/src/platform/**` and target-specific Rust modules.
- `lifecycle-sidecar/platform/**` and platform-selected detector catalogs.
- build, packaging, diagnostics, and platform configuration files.
- small CSS platform tokens selected with `data-platform` when rendering truly
  differs.

Platform branching is not allowed inside product Controllers, message catalogs,
Network protocol mappers, or Task state machines.

## 5. Proposed code organization

```text
apps/desktop/
  src/
    platform/
      contract.ts                 shared renderer-facing platform DTO
      tauri-api.ts                stable command/event client
    i18n/                         shared Mac/Windows catalogs and formatters
  lifecycle-sidecar/
    platform/
      index.ts                    resolve win32/darwin once
      paths.ts                    validated path DTO received from Rust
      permissions.ts              POSIX mode or Windows ACL-inheritance policy
      process-tree.ts             platform process termination
    runtime/agents/
      catalog-common.ts
      catalog-macos.ts
      catalog-windows.ts
      system-macos.ts
      system-windows.ts
  src-tauri/
    tauri.conf.json               platform-neutral metadata/build/frontend
    tauri.macos.conf.json         private API, Mac resources/icons/bundles
    tauri.windows.conf.json       Windows resources/icons/NSIS/WebView2
    src/platform/
      mod.rs                      HostPlatform trait/dispatch
      macos.rs                    existing NSPanel/path/open/reveal/events
      windows.rs                  companion/path/open/reveal/events/Job Object
    icons/icon.icns
    icons/icon.ico
  scripts/
    runtime-target.ts             typed artifact manifest by OS/architecture
    bundle-runtime.ts             common bundler driven by the manifest
    package-macos-adhoc.ts
    package-windows-nsis.ts
    build-diagnostics-macos.ts
    build-diagnostics-windows.ts
```

Tauri supports a common config merged with `tauri.macos.conf.json` or
`tauri.windows.conf.json`. The common config must stop containing platform-only
bundle targets, icons, private APIs, or resource filenames.

## 6. Platform contract

Rust is the authority for platform and native directories. The renderer and
sidecar must not infer security-sensitive behavior from `navigator.userAgent`.

The native platform DTO should contain only bounded public data:

```ts
type DesktopPlatform = "macos" | "windows";

interface DesktopPlatformInfo {
  platform: DesktopPlatform;
  architecture: "arm64" | "x64";
  shell: "notch-panel" | "top-center-companion";
  supportsDockReopen: boolean;
  supportsNativeSleepEvents: boolean;
  supportsRevealInFileManager: boolean;
}
```

The sidecar receives validated values through fixed environment variables set by
Rust:

- `TETI_DESKTOP_PLATFORM=macos|windows`
- `TETI_PROFILE_DIR=<absolute validated root>`
- `TETI_DESKTOP_LOG_DIR=<absolute validated root>`
- `TETI_DELTACHAT_RPC_PATH=<bundled platform executable>`

The sidecar validates these values again before use. User input can never select
the platform or bundled executable.

## 7. Profile, path, and file-security design

### Profile roots

- macOS keeps `~/.teti` exactly as-is to avoid migration risk.
- Windows uses Tauri's per-user local app-data directory with a `profile`
  child, conceptually `%LOCALAPPDATA%/<Teti app id>/profile`.
- Tests always use an explicit temporary `TETI_PROFILE_DIR`.

Rust resolves the root and passes it to Node. This removes `homedir()/.teti`
assumptions from Runtime services while preserving the Mac location.

### Windows ACL policy

Before the sidecar starts, Rust creates the Windows Profile root and applies a
non-inheriting ACL that grants full control only to:

- the current user;
- `SYSTEM`.

Node-created children inherit that ACL. POSIX mode calls move behind a shared
`tightenPrivatePath()` helper: real `chmod` on macOS, ACL-inheritance assertion
on Windows. A successful Windows test may not equate `chmod(0600)` with privacy.

### Path validation

Every local path boundary must use platform-aware primitives:

- `isAbsolute()` instead of `startsWith("/")`;
- canonical/real paths before trust decisions;
- `relative(root, candidate)` containment checks that reject `..` and absolute
  relative results;
- rejection of NULs, device namespaces, alternate data streams where relevant,
  symlinks, junctions, and unexpected reparse points;
- extension checks after canonicalization.

This migration covers Callable Adapter entrypoints, Task images, Artifact paths,
Workspace roots, Agent overrides, and validation Profile roots.

## 8. Runtime and process architecture

### Runtime target manifest

The build must select a closed artifact manifest:

| Target | Node | DeltaChat RPC | Auxiliary files |
| --- | --- | --- | --- |
| `darwin-arm64` | `runtime/node` | `runtime/deltachat-rpc-server` | none unless explicitly listed |
| `windows-x64` | `runtime/node.exe` | `runtime/deltachat-rpc-server.exe` | explicitly hashed DLL allowlist |

Each manifest pins:

- source path;
- target filename;
- expected architecture and executable format;
- expected version;
- SHA-256;
- required adjacent DLLs;
- smoke command.

Builds run natively on their target OS. Tauri documents cross-compiling Windows
installers from macOS/Linux as a caveated last resort; 0.4.1 therefore uses a
real Windows x64 builder or Windows CI.

### Process ownership

- Rust remains the owner of the Node lifecycle sidecar.
- macOS keeps the current process-group shutdown.
- Windows creates a Job Object with kill-on-close semantics before the sidecar
  can start its RPC or Agent descendants.
- Sidecar shutdown first closes stdin and waits for graceful exit, then uses the
  platform terminator.
- Task cancellation uses a separate fixed Windows process-tree operation with a
  validated numeric PID; no arbitrary shell command is accepted.
- Shutdown, cancellation, timeout, and app reset tests must prove that Node,
  RPC, and Agent descendants do not survive.

## 9. Windows shell and native behavior

### Companion window

Windows uses the existing shared Island DOM but presents it as a Windows
top-center companion:

- borderless and transparent;
- always on top;
- hidden from the taskbar;
- centered on the active monitor work area;
- DPI-aware at 100%, 125%, 150%, and 200%;
- 10 logical pixels below the work-area top for expanded modes;
- no notch inset and no claim of physical-notch integration.

The shared `IslandMode` sizes remain the default. Windows-specific size changes
are allowed only when an actual WebView2 layout test proves they are necessary.

### Focus and lifecycle

- `RunEvent::Reopen` remains Mac-only.
- Windows activation uses the companion window and optional notification-area
  entry only if usability testing shows the always-on-top idle surface is
  insufficient. A tray feature is not assumed in 0.4.1 scope.
- Windows sleep/resume signals are emitted through a narrow Win32 power-event
  adapter. Until that adapter is validated, Presence must fail conservatively
  rather than claiming a Mac event source.
- Monitor changes reposition the companion using Tauri monitor geometry and
  logical DPI conversion.

### Native image actions

- Selection and Save As continue to use `rfd` with localized titles supplied by
  the shared catalog.
- Open uses the Windows registered image application.
- Reveal selects the exact file in Explorer.
- The Rust command continues to validate that the source is a canonical file
  under the private Artifact root before invoking either operation.

## 10. Agent and Callable Adapter strategy

Agent support is capability-based, not a copy of the Mac detector list.

### Required for Windows 0.4.1

- PATH and explicit-path discovery for Windows executables.
- safe support for `.exe` and an explicitly qualified Windows launcher strategy;
  `.cmd` files must never be passed through an unbounded shell string.
- Codex installation, version, and callable qualification on the chosen Windows
  installation path.
- Windows process-name observation when it can be implemented without localized
  output parsing; otherwise runtime state is `unknown`, not `not running`.
- platform-aware execution environment (`PATH`, `USERPROFILE`, temp directory)
  without injecting a fake Unix `HOME`.

### Optional or unavailable in 0.4.1

- CodeBuddy is enabled only after a real Windows binary and version probe pass
  the same qualification boundary.
- Osaurus Native Child reports `unsupported_on_platform` and its configuration
  controls are omitted on Windows.
- macOS `.app` metadata and bundle-signature probes never run on Windows.

Passport sharing continues to expose semantic availability. It does not store
localized explanations or Mac filesystem paths.

## 11. Shared internationalization design

### One application catalog

Mac and Windows use the existing catalog files:

- `src/i18n/locales/en.ts`
- `src/i18n/locales/zh-hans.ts`

There is no `en-windows.ts`, `zh-windows.ts`, or copied Windows UI tree.
Platform-specific terms, when unavoidable, are typed leaves inside the same
catalog. Examples are Finder versus File Explorer and Dock versus taskbar.

### Locale behavior on both platforms

- default preference: `auto`;
- primary OS language beginning with `zh`, including `zh-Hant`, resolves to
  `zh-Hans`;
- every other language resolves to English;
- manual choices remain `auto`, `zh-Hans`, and `en`;
- `html[lang]`, dates, numbers, plurals, native dialog titles, errors, and
  accessibility labels use the resolved App locale;
- unknown native/Runtime errors map to the same safe localized generic errors.

The existing WebView local-storage key remains stable so an app upgrade does not
reset the user's choice.

### Windows installer localization

The NSIS installer is a separate native localization boundary. It includes
English and Simplified Chinese, chooses from the OS language by default, and
does not create an installer-only application preference.

A zh-CN and zh-TW installation test is required. If NSIS does not map zh-TW to
the Simplified Chinese resource when only English and Simplified Chinese are
included, a small reviewed NSIS language mapping is added. Installer text must
not be copied back into the application catalogs.

### Cross-engine visual tests

The same mock states run in WKWebView and WebView2 for both locales. Windows must
also test:

- Segoe UI and Microsoft YaHei fallback;
- English control widths;
- Chinese line height;
- native select rendering;
- scrollbars and focus rings;
- reduced motion;
- 1366x768 and 1920x1080 displays at common DPI scales.

## 12. Tauri configuration and Windows installer

### Configuration split

`tauri.conf.json` keeps product name, identifier, version, frontend build, CSP,
common commands, and common resources only.

`tauri.macos.conf.json` owns:

- `macOSPrivateApi`;
- app and DMG targets;
- `.icns` and Mac PNG icons;
- macOS 15 minimum;
- Mac runtime resource names.

`tauri.windows.conf.json` owns:

- NSIS as the only 0.4.1 installer target;
- `icon.ico`;
- Windows x64 runtime resources;
- per-user installation without administrator privilege;
- English and Simplified Chinese installer resources;
- WebView2 installation mode.

### WebView2 decision

Use Evergreen WebView2 with the embedded bootstrapper for the controlled Beta.
Windows 11 normally has the Evergreen Runtime, while the installer can recover
when it is missing. Do not use `skip`. Do not carry a 180 MB fixed Runtime in
the normal Beta installer. An offline-installer variant is deferred until an
offline distribution requirement exists.

### Signing and artifact

Expected artifact:

```text
Teti_0.4.1_x64-setup.exe
```

Release candidates require Authenticode signatures on the application binary,
bundled native executables, and final installer where applicable. The signing
certificate/provider decision is an external release dependency. An unsigned
artifact may be used only for isolated development and must never be described
as the controlled Beta release.

NSIS is preferred over MSI for 0.4.1 because it supports a single localized
per-user setup executable without requiring the MSI/WiX distribution path. MSI
and Microsoft Store packaging can be evaluated after the first Windows Runtime
has stabilized.

## 13. Milestones and prerelease versions

### M0 — Architecture freeze (`0.4.1-alpha.0`, 2–3 engineering days)

- Approve this scope and target matrix.
- Verify that the pinned DeltaChat revision can produce a Windows x64 RPC
  executable and identify every required DLL.
- Acquire a Windows 11 25H2 x64 development/CI machine.
- Choose the Windows signing route.
- Freeze shared versus platform-specific module ownership.

Exit gate: RPC feasibility, build host, and signing dependencies have owners.

### M1 — Cross-platform build skeleton (`0.4.1-alpha.1`, 3–5 days)

- Split Tauri configuration.
- Add `.ico` generation/verification.
- Add typed platform info and platform paths.
- Compile the Rust shell on macOS and Windows.
- Launch the shared renderer in the Windows companion window.
- Keep every Mac test and `.app` build green.

Exit gate: Windows opens the localized mock shell without a lifecycle Runtime.

#### M1 implementation record (2026-08-18)

Implemented in the shared source tree:

- common, macOS, and Windows Tauri configuration ownership is split;
- Windows NSIS/WebView2 metadata and a verified multi-size `.ico` are present;
- Rust returns a bounded typed platform DTO and owns validated Profile/log paths;
- the shared renderer validates the DTO before App startup and exposes platform
  state only through document data attributes;
- Windows selects the existing localized mock lifecycle even if a caller asks
  for real provisioning, and the Rust bridge also refuses Lifecycle requests;
- the existing non-Mac top-center companion window hosts the same renderer;
- macOS keeps `~/.teti`, `~/Library/Logs/Teti`, the NSPanel path, Runtime bundle,
  asset scope, `.app`/DMG ownership, and macOS 15 minimum unchanged;
- SemVer prerelease comparison supports `0.4.1-alpha.1` without weakening the
  stable Network release-floor contract.

Automated evidence completed on the Apple Silicon development Mac:

- TypeScript typecheck and localized-copy guard;
- 477 desktop tests;
- macOS Rust/Tauri release compilation and ad-hoc signed `.app` bundle;
- `x86_64-pc-windows-msvc` Rust shell cross-check through Tauri/WebView2;
- icon generation and ICO/ICNS verification.

The remaining exit-gate evidence requires the real Wintel validation host. On
that machine, from the repository root:

```powershell
npm ci --prefix apps/desktop
rustup target add x86_64-pc-windows-msvc
npm run desktop:typecheck
npm run desktop:icon:verify
node --experimental-strip-types --test apps/desktop/test/windows-foundation.test.ts apps/desktop/test/i18n.test.ts apps/desktop/test/desktop-startup.test.ts
npm run desktop:tauri-build:windows:shell
& .\apps\desktop\src-tauri\target\release\teti-desktop.exe
```

Acceptance requires the companion window to open in Simplified Chinese for all
Chinese Windows language variants and in English otherwise; the in-App language
selector must override both directions. Task Manager must show no bundled Node
or DeltaChat Runtime child process. This real WebView2 launch result cannot be
substituted by the macOS cross-check.

### M2 — Profile and Runtime bootstrap (`0.4.1-alpha.2`, 6–9 days)

- Bundle `node.exe`, `deltachat-rpc-server.exe`, and allowlisted DLLs.
- Apply and test the protected Windows Profile ACL.
- Remove hard-coded `macos` Network identity fields.
- Add Windows logs and Runtime diagnostics.
- Add Job Object ownership and clean shutdown.
- Pass account load/create and JSON-RPC health in an isolated Profile.

Exit gate: First Launch can create/load a controlled Windows identity and no
Runtime descendant survives app exit.

#### M2 implementation record (2026-08-18)

Implemented in `0.4.1-alpha.2`:

- pinned Windows Node and DeltaChat artifact policy, SHA-256/provenance checks,
  PE x64 validation, and an explicit empty DLL allowlist for the vendored
  single-file RPC build;
- Windows Runtime resources in the target Tauri overlay and fail-closed
  packaging when either executable or provenance is absent;
- LocalAppData Profile creation followed by a protected user/System-only ACL
  that is read back before Runtime launch;
- platform-derived Network ClientInstance/Identity fields instead of literal
  `macos` values;
- LocalAppData logs, Runtime bootstrap events, bounded typed diagnostics, and
  platform-neutral RPC errors;
- sidecar ownership through a kill-on-close Windows Job Object, with a
  Windows-only test that waits for a real descendant and proves the active Job
  process count returns to zero;
- an isolated Wintel exit-gate command covering RPC health, account create or
  load, and reload of the same controlled identity.

Mac evidence completed: official Node `22.22.3` `node.exe` downloaded and hash
verified, all 694 TypeScript tests passed, 27 Mac Rust tests passed, the Windows
Rust target including all test sources cross-compiled, localized-copy and icon
guards passed, and an ad-hoc signed `0.4.1-alpha.2` Mac `.app` was produced.

The Windows RPC executable and the final exit gate remain intentionally
unclaimed on macOS. Run the Wintel procedure in
`TETI_0_4_1_ALPHA_2_WINDOWS_RUNTIME.md`; it builds the pinned RPC with MSVC,
executes the Windows-only ACL/Job tests, creates or loads an isolated identity,
and verifies JSON-RPC health on the real operating system.

### M3 — Native shell and file operations (`0.4.1-alpha.3`, 4–6 days)

- DPI/multi-monitor companion positioning.
- focus, hide/show, sleep/resume, and restart behavior.
- image picker, Save As, open, and reveal.
- platform-aware Asset scope and Artifact containment.
- reset of the exact local Windows Profile.

Exit gate: native operations use stable error codes and pass both locales.

#### M3 implementation record (2026-08-19)

Implemented in `0.4.1-alpha.3`:

- physical-pixel, per-monitor-DPI positioning against the Windows work area,
  including negative coordinates, taskbar insets, display/DPI/settings change
  coalescing, and wake-time repositioning;
- explicit input-mode focus, native hide/show, deduplicated Win32 sleep/resume
  events, and Runtime shutdown before application restart;
- parented image picker and Save As dialogs plus cross-platform native open and
  reveal behavior;
- target-specific Asset protocol scopes limited to stored input and Artifact
  images, canonical Artifact containment, Windows drive-path support, and
  symlink/junction escape rejection in the attachment store;
- exact resolved Profile reset with linked/reparse-point rejection and bounded
  retry for Windows sharing violations;
- stable native error objects and safe English/Simplified Chinese mappings.

Mac evidence completed: TypeScript typecheck, localized-copy and icon guards,
700 repository tests, 31 Mac Rust tests, Windows Rust target cross-check,
production renderer build, and an ad-hoc signed `0.4.1-alpha.3` Mac `.app`.

The real Wintel exit gate remains open. Follow
`TETI_0_4_1_ALPHA_3_WINDOWS_NATIVE_SHELL.md` to validate mixed-DPI monitors,
Win32 sleep/resume, Explorer/dialog integration, junction behavior, exact
Profile reset, and both locale directions on the packaged Windows process.

### M4 — Agent and Task execution parity (`0.4.1-alpha.4`, 6–10 days)

- Windows Agent observer and detector catalog.
- Codex qualification and callable launch.
- platform path validation throughout Task, Workspace, image, and Artifact
  boundaries.
- Windows task cancellation and crash recovery.
- capability-based Osaurus omission.

Exit gate: text and image Task execution works in both Mac-to-Windows and
Windows-to-Mac directions.

#### M4 implementation record (2026-08-19)

Implemented in `0.4.1-alpha.4`:

- a platform-selected Windows Agent observer and detector catalog using fixed
  local process enumeration, PATH/PATHEXT executable discovery, and private
  detector evidence;
- native `codex.exe` qualification and the shared bounded callable/image
  launch contracts;
- one Windows-aware absolute-local-path policy across Task, Workspace, image,
  Artifact, executable, and detector override boundaries;
- whole-tree Windows cancellation with graceful/forced escalation, plus
  startup reconciliation of persisted interrupted executions;
- capability-driven omission of Osaurus observation, qualification,
  transports, settings dependencies, Passport Agents, and Compute Offers on
  Windows.

Mac automation covers the cross-platform policy and the existing abstract
two-peer text/image flows. Typecheck, localization and icon guards, 706
repository tests, 31 Mac Rust tests, the Windows x64 Rust cross-check,
production renderer, and an ad-hoc signed `0.4.1-alpha.4` Mac `.app` passed.
No DMG was built. The real Wintel process and Mac↔Windows exit gate remain
deliberately unclaimed until the matrix in
`TETI_0_4_1_ALPHA_4_WINDOWS_AGENT_TASK_PARITY.md` is run on both hosts.

### M5 — Shared UI/i18n hardening (`0.4.1-beta.1`, 3–5 days)

- Add Segoe UI/Microsoft YaHei font fallback.
- Complete WebView2 layout and accessibility checks.
- Verify automatic and forced locale selection.
- Verify English, zh-CN, zh-TW, and non-Chinese OS locale behavior.
- Add Windows-specific safe errors only where a semantic code requires them.

Exit gate: no duplicated Windows catalog and no hard-coded visible copy.

#### M5 implementation record (2026-08-19)

Implemented in `0.4.1-beta.1`:

- the shared Windows Segoe UI/Microsoft YaHei font stack plus WebView2 layout,
  transparent-backdrop, long-copy, scrollbar, forced-colors, focus, and
  reduced-motion hardening;
- labelled/busy Passport and connection surfaces, toolbar `aria-controls`,
  real disabled connection transitions, Task headings/live status, and safe
  alert semantics;
- an explicit automatic/forced locale matrix for English, zh-CN, zh-TW, and
  non-Chinese OS locales, plus document language metadata;
- removal of Passport/Codex Usage fallback UI copy and neutral “this device”
  English Profile-reset wording shared by macOS and Windows;
- a stricter visible-copy and catalog-inventory guard. Windows has no catalog
  fork and receives only the existing stable semantic native error codes.

The typed checks and local 600×360 Windows-mode renderer smoke pass in English
and Simplified Chinese with no horizontal overflow and keyboard-visible
language focus. Typecheck, localized-copy and icon guards, 711 repository
tests, 31 Mac Rust tests, the Windows x64 Rust cross-check, production
renderer, and an ad-hoc signed `0.4.1-beta.1` Mac `.app` passed; no DMG was
built. The real WebView2/Narrator/mixed-DPI exit gate remains open
until the Wintel matrix in
`TETI_0_4_1_BETA_1_SHARED_UI_I18N.md` is completed; Mac automation does not
claim that platform-specific evidence.

### M6 — Installer, upgrade, and signing (`0.4.1-beta.2`, 4–7 days)

- Build localized per-user NSIS installer on Windows.
- Handle missing WebView2 via the embedded Evergreen bootstrapper.
- Sign and inventory all PE artifacts.
- Test clean install, uninstall, repair, and 0.4.1 prerelease upgrade.
- Prove that upgrades preserve Profile and language preference.

Exit gate: signed setup executable passes clean-VM installation and Runtime
smoke tests.

#### M6 implementation record (2026-08-19)

Implemented in `0.4.1-beta.2`:

- localized per-user English/Simplified Chinese NSIS with LZMA packaging and
  an embedded silent WebView2 Evergreen bootstrapper;
- fail-closed SHA-256 Authenticode signing and trusted timestamp verification
  for staged Runtime PEs, the app, generated uninstaller, and setup;
- deterministic JSON/SHA-256 release inventory tied to pinned Node and
  DeltaChat source provenance;
- native Profile-backed locale preference with beta.1 localStorage migration;
- clean and upgrade VM gates covering installation, missing WebView2, Runtime
  health/descendant cleanup, repair, uninstall, prerelease upgrade, and
  byte-identical Profile/language preservation.

Typecheck, localized-copy and icon guards, 719 repository tests, 32 Mac Rust
tests, the Windows x64 Rust cross-check, the production renderer, Windows
overlay parse check, and an ad-hoc signed `0.4.1-beta.2` Mac `.app` pass; no DMG
was built. The source implementation is complete, but the physical exit gate
remains open until a Windows signing certificate and clean Wintel VM produce
both signed release inventory and the two evidence files described in
`TETI_0_4_1_BETA_2_WINDOWS_INSTALLER.md`. No signed Windows setup or clean-VM
result is claimed from the Mac host.

### M7 — Interoperability release candidate (`0.4.1`, 4–6 days)

- Mac 0.4.0 ↔ Windows 0.4.1 tests in both directions.
- Mac 0.4.1 ↔ Windows 0.4.1 tests in both directions.
- Two-locale visual and collaboration matrix.
- Windows 11 25H2 x64 certification and 26H1 smoke where available.
- Mac 15/26 regression and `.app`/DMG packaging verification.
- Produce hashes, manifests, known limitations, and rollback instructions.

Exit gate: controlled Beta release approval.

Estimated implementation effort is 32–51 engineering days plus signing/account
setup and hands-on device QA. Failure to obtain a viable Windows RPC binary or
its redistribution inventory adds a separate dependency track and blocks the
schedule rather than reducing security or feature claims.

## 14. Test and release matrix

### Automated on every change

- shared TypeScript unit and characterization tests on macOS and Windows;
- i18n hard-coded-copy guard;
- TypeScript typecheck;
- Rust format/check/test on both targets;
- platform config schema and version consistency;
- target artifact manifest and hash validation;
- Profile path, junction/reparse-point, containment, and ACL tests;
- Runtime spawn, timeout, cancellation, and descendant cleanup;
- stable native/sidecar error-code mapping;
- English and Simplified Chinese catalog parity.

### Controlled integration

| Sender | Receiver | Required flows |
| --- | --- | --- |
| Mac 0.4.0 | Windows 0.4.1 | connect, accept/reject, text Task, image, Artifact |
| Windows 0.4.1 | Mac 0.4.0 | same flows in reverse |
| Mac 0.4.1 | Windows 0.4.1 | same flows plus long task, delegation, Memory |
| Windows 0.4.1 | Mac 0.4.1 | same flows in reverse |

Each row runs once with a Chinese UI and once with an English UI. Transport
payloads and stored controller state must remain locale-independent.

### Windows clean-VM checks

- Windows 11 25H2 x64, standard user, 100% and 150% DPI;
- WebView2 present and deliberately absent;
- install without administrator rights;
- app launch, first launch, restart, reset, and uninstall;
- multi-monitor repositioning and sleep/wake;
- profile ACL and no secret-bearing renderer/installer logs;
- SmartScreen/signature presentation recorded;
- no orphan Node, RPC, or Agent process after exit;
- installer locale under en-US, zh-CN, and zh-TW.

### Mac non-regression

- current 472+ Desktop tests remain green;
- macOS private panel behavior remains target-gated;
- `~/.teti` remains the Mac Profile location;
- Apple Silicon runtime inventory and minimum macOS remain unchanged;
- Chinese/English automatic and forced locale behavior remains unchanged;
- `.app`, signing, and DMG scripts continue to work independently of Windows
  packaging.

## 15. Release gates and risk register

| Risk | Severity | Release gate or mitigation |
| --- | --- | --- |
| No redistributable Windows RPC binary | Blocker | Build from pinned source on Windows; record license, DLLs, hashes, version, and smoke output |
| POSIX absolute-path assumptions admit/reject the wrong path | Critical | Central validator plus drive, UNC, junction, ADS, and containment tests |
| Orphan Runtime or Agent processes | Critical | Job Object/process-tree tests across normal exit, crash, timeout, cancel, reset, and uninstall |
| Windows Profile files readable by other users | Critical | Explicit root ACL and effective-access verification |
| Unsigned installer blocked or distrusted | High | Authenticode release gate; unsigned builds are development-only |
| WebView2 missing or too old | High | Evergreen bootstrapper and clean-VM test; never use `skip` |
| Transparent/always-on-top window behaves poorly at DPI or multi-monitor | High | WebView2 device matrix; degrade to normal top-center companion, never fake a notch |
| Agent launch through `.cmd` enables shell injection | High | Fixed launcher adapter and argument tests; no concatenated shell command |
| Mac regressions from common refactor | High | Both OS CI lanes and unchanged Mac packaging gates on every milestone |
| Installer zh-TW falls back to English | Medium | Explicit zh-TW VM test and reviewed NSIS locale mapping if needed |
| Antivirus flags bundled Node/RPC | Medium | Signed binaries, closed inventory, stable build inputs, and clean-VM scanning |

## 16. Definition of done

Beta 0.4.1 supports Windows only when all of the following are true:

- the same source tree builds Mac arm64 and Windows x64 artifacts;
- the same renderer, Controllers, DTOs, and locale catalogs run on both;
- Windows uses a native per-user Profile root protected by ACLs;
- the bundled Node and RPC Runtime is pinned, inventoried, signed, and healthy;
- First Launch, Connection, Passport, Task, Artifact, Memory, language selection,
  and local reset are usable on Windows;
- Codex can be detected, qualified, invoked, cancelled, and cleaned up safely;
- Mac and Windows peers interoperate without a wire-schema fork;
- no visible text is stored in Controllers or returned by Runtime state;
- NSIS installation works in English and Simplified Chinese;
- the Windows setup artifact is signed and verified;
- Mac behavior, build, signing, and packaging remain independently green.

## 17. External references

- Tauri platform-specific configuration:
  <https://v2.tauri.app/reference/config/>
- Tauri Windows installer, NSIS/MSI, WebView2 modes, and installer i18n:
  <https://v2.tauri.app/distribute/windows-installer/>
- Tauri Windows build prerequisites:
  <https://v2.tauri.app/start/prerequisites/>
- Tauri Windows code signing:
  <https://v2.tauri.app/distribute/sign/windows/>
- Tauri GitHub build pipelines:
  <https://v2.tauri.app/distribute/pipelines/github/>
- Microsoft WebView2 Runtime distribution:
  <https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution>
- Microsoft Windows 11 release lifecycle:
  <https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information>
- Microsoft Windows 10 lifecycle:
  <https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro>
