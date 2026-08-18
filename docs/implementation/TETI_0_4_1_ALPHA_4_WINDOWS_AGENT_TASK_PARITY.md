# Teti `0.4.1-alpha.4` Windows Agent and Task parity

## Implemented scope

`0.4.1-alpha.4` keeps the shared renderer, Task protocol, and localization
catalog. M4 adds the Windows-local execution boundary beneath them:

- Agent discovery selects a platform catalog. Windows resolves allowlisted
  executable names through `PATH`/`PATHEXT`, checks allowlisted absolute
  executable locations, and enumerates image names with the fixed System32
  `tasklist.exe`; command lines and executable paths never enter Passport;
- the Windows catalog contains the supported CLI/desktop identities, has no
  macOS app-bundle probes, and omits Osaurus because the platform capability
  contract marks both Osaurus transports unsupported;
- Codex qualification searches only a native `codex.exe` in controlled PATH,
  per-user, or explicit override locations, then runs the same bounded login
  probe and fixed non-interactive launch contract used by macOS;
- Task image, Workspace Snapshot, generated image, Artifact, Adapter
  executable, and detector override boundaries share one local-path policy.
  Windows accepts canonical drive-absolute paths and rejects UNC, device,
  drive-relative, control-character, duplicate-separator, and lexical
  traversal inputs before filesystem access;
- a Windows cancel first targets the complete PID tree with fixed System32
  `taskkill.exe /T`, escalates to `/F` after the Connector grace period, and
  retains the M2 app-wide kill-on-close Job Object as the final ownership
  boundary;
- Runtime startup reconciles persisted non-terminal Execution Handles to
  `interrupted`, never silently replays them, and emits a bounded recovery
  diagnostic. Explicit checkpoint restart rules remain unchanged.

## Automated evidence

The cross-platform tests cover the Windows detector catalog, localized
`tasklist` parsing, native Codex candidate/launch policy, every local path
boundary, fixed tree-cancel command, injected cancellation lifecycle,
interrupted-handle recovery, and the existing two-peer text/image protocol.

Mac evidence completed on 2026-08-19: TypeScript typecheck, localized-copy and
icon guards, 706/706 repository tests, 31/31 Mac Rust tests, the Windows x64
Rust target cross-check, production renderer build, and an ad-hoc signed and
verified `0.4.1-alpha.4` Mac application at
`apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`. No DMG was built.

Run on each development host:

```powershell
npm ci --prefix apps/desktop
npm run desktop:typecheck
npm run desktop:i18n-check
npm run desktop:icon:verify
npm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

On macOS, also keep the application bundle regression green without building
a DMG:

```bash
npm run desktop:tauri-build-app
```

Automated tests on macOS validate Windows semantics and cross-compile the Rust
shell, but they do not claim process enumeration, `taskkill`, Codex execution,
or the bidirectional exit gate on a real Wintel operating system.

## Real Mac ↔ Windows exit gate

Use two controlled accounts and isolated Profiles: one current Mac build and
one Windows x64 build. Both peers must be confirmed, both must advertise the
qualified Codex text and image capabilities, and no development Profile may
be reused.

1. On Windows, run the M2 Runtime artifact verification and exit gate, then
   build and launch `0.4.1-alpha.4`. Confirm Agent discovery shows Codex but
   does not show Osaurus settings, Passport Agent, or Compute Offer.
2. In forced English and forced Chinese once each, send Mac → Windows:
   one text Task and one PNG/JPEG image Task. Approve on Windows. Verify the
   text and copied image Artifact arrive on Mac and open from the Mac-local
   Artifact store.
3. Send the same text and image matrix Windows → Mac. Verify the Artifact is
   materialized only in the Windows-local store; no sender-local path may
   appear in relay payloads, UI errors, Passport, or diagnostics.
4. Start a long Windows Codex Task and cancel it after the process has spawned.
   Verify `codex.exe`, its Node/image runner when applicable, and every child
   disappear. The peer must converge to `canceled`, and no partial Artifact may
   be published.
5. Start another Windows Task, terminate Teti while it is running, and relaunch.
   Verify the M2 Job has zero surviving descendants, the Execution Handle is
   `interrupted`, it is not replayed, and a fresh Task can run successfully.
6. Repeat cancellation and relaunch on Mac to prove the existing process-group
   behavior did not regress. Sleep/resume each host once and run one final text
   Task in each direction.

The M4 gate passes only when all four text/image direction cases complete,
cancel/crash leaves no descendant, recovery never replays work, Osaurus is
absent by capability on Windows, and both locales have identical semantics.
