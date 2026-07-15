# Teti macOS Compatibility Matrix

Status values: PASS, FAIL, BLOCKED, NOT APPLICABLE, NOT TESTED.

Current run date: 2026-07-15.

| Test case | macOS 15 Sequoia | macOS 26 Tahoe |
| --- | --- | --- |
| Exact OS version recorded | NOT TESTED | PASS: macOS 26.5.2 build 25F84 |
| Apple Silicon arm64 host | NOT TESTED | PASS: build diagnostics reported arm64 |
| Source bootstrap | NOT TESTED | PASS: existing checkout dependencies present |
| Dependency install | NOT TESTED | NOT TESTED: no install run during this pass |
| RPC install/build | NOT TESTED | PASS: repo-local RPC verified at 2.54.0-dev |
| Frontend build | NOT TESTED | PASS: `npm run desktop:build` |
| Desktop typecheck | NOT TESTED | PASS: `npm run desktop:typecheck` |
| Desktop tests | NOT TESTED | PASS: 42/42 |
| Root tests | NOT TESTED | PASS: 117/117 |
| Cargo fmt check | NOT TESTED | PASS |
| Cargo check | NOT TESTED | PASS |
| Cargo test | NOT TESTED | PASS: 9/9 Rust tests |
| Tauri build | NOT TESTED | PASS: generated `Teti.app` |
| `.app` bundle exists | NOT TESTED | PASS: `apps/desktop/src-tauri/target/release/bundle/macos/Teti.app` |
| `.app` launch | NOT TESTED | PASS: launched via `open` |
| No visible Terminal from `.app` launch | NOT TESTED | PASS: process list showed app process only; screenshot capture unavailable |
| No unwanted configured main window | NOT TESTED | PASS: `app.windows: []`; only programmatic island window |
| Dock icon resource bundled | NOT TESTED | PASS: `Contents/Resources/icon.icns` |
| Finder icon resource bundled | NOT TESTED | PASS: `CFBundleIconFile=icon.icns` |
| Cmd-Tab icon | NOT TESTED | NOT TESTED: screenshot/display capture unavailable |
| Force Quit icon | NOT TESTED | NOT TESTED |
| About panel icon | NOT TESTED | NOT TESTED |
| Dark appearance | NOT TESTED | NOT TESTED |
| Light appearance | NOT TESTED | NOT TESTED |
| Small Dock icon clarity | NOT TESTED | PASS: generated 16x16/32x32 assets verified programmatically |
| Large Dock icon clarity | NOT TESTED | PASS: source/inspection sheet generated |
| Icon after clean rebuild | NOT TESTED | PASS: Tauri rebuild bundled generated icon |
| Icon after copying `.app` | NOT TESTED | NOT TESTED |
| No Tauri placeholder icon remains in config | NOT TESTED | PASS: config references generated Teti assets |
| Island position | NOT TESTED | NOT TESTED: visual screenshot unavailable |
| Transparency | NOT TESTED | NOT TESTED |
| Borderless behavior | NOT TESTED | PASS: native config uses `decorations(false)` |
| Always-on-top | NOT TESTED | PASS: native config uses `always_on_top(true)` |
| Click handling | NOT TESTED | NOT TESTED |
| Input focus | NOT TESTED | PASS: covered by render code; no manual IME run |
| Chinese input method | NOT TESTED | NOT TESTED |
| Escape behavior | NOT TESTED | NOT TESTED |
| Return behavior | NOT TESTED | PASS: submit handler covered by code path; no manual UI screenshot |
| Mission Control | NOT TESTED | NOT TESTED |
| Spaces | NOT TESTED | NOT TESTED |
| Full-screen overlap | NOT TESTED | NOT TESTED |
| Menu bar auto-hide | NOT TESTED | NOT TESTED |
| Display scaling | NOT TESTED | NOT TESTED |
| Reduced motion CSS | NOT TESTED | PASS: CSS media query present; copy test passes |
| Increased contrast | NOT TESTED | NOT TESTED |
| Missing account mock flow | NOT TESTED | PASS: desktop tests cover mock onboarding without network |
| Existing account idle | NOT TESTED | PASS: desktop tests cover existing-account idle path |
| Real preflight | NOT TESTED | NOT TESTED in this pass |
| Account load | NOT TESTED | PASS: bridge and state-machine tests |
| Restart duplicate prevention | NOT TESTED | PASS: tests cover repeated init existing account |
| Sidecar shutdown | NOT TESTED | PASS: Rust bridge drop kills managed sidecar; not manually observed |
| RPC shutdown | NOT TESTED | PASS: `desktop:rpc:verify` reported clean shutdown |
| Sleep/wake | NOT TESTED | NOT TESTED |
| Lock/unlock | NOT TESTED | NOT TESTED |
| Built-in display | NOT TESTED | NOT TESTED |
| Physical notch display | NOT TESTED | NOT TESTED |
| External display | NOT TESTED | NOT TESTED |
| Disconnect external display | NOT TESTED | NOT TESTED |
| Reconnect external display | NOT TESTED | NOT TESTED |
| Change primary display | NOT TESTED | NOT TESTED |
| Change scaling | NOT TESTED | NOT TESTED |

## Sequoia 15 Source-Build Path

Run on the second Apple Silicon Mac:

```sh
npm --prefix apps/desktop install
npm run desktop:build-diagnostics
npm run desktop:icon:generate
npm run desktop:icon:verify
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
npm run desktop:rpc:verify --
open apps/desktop/src-tauri/target/release/bundle/macos/Teti.app
```

Do not run `desktop:profile:create` against a real empty profile without separate approval to create another external Chatmail identity.

## Unsigned Bundle Notes

The Tahoe build produced an unsigned development `.app` at:

`apps/desktop/src-tauri/target/release/bundle/macos/Teti.app`

It is suitable only for local development compatibility testing. It is not a production installer, is not notarized, and is not presented as Mac App Store-ready.

Current limitation: the release `.app` is not fully self-contained for real account creation because the Node-capable lifecycle sidecar still depends on the development checkout/runtime strategy documented in previous milestones. Mock launch and bundle identity validation are usable from the produced `.app`.
