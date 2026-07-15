# Teti New Mac Source Reproducibility Result

Date: 2026-07-14

## Classification

`REPRODUCIBLE_WITH_DOCUMENTED_EXTERNAL_RPC_BUILD`

Reason:

- Teti Desktop source, tests, Tauri build, profile tooling, and real-validation preflight are source-driven.
- `deltachat-rpc-server` is not committed or bundled.
- A new Mac must build the pinned official Chatmail Core RPC server into the repository-local `.tools/` path.
- The current Tauri release build is not self-contained and still relies on the developer environment for Node/Tauri execution and RPC path resolution.

## Source Dependencies

- Teti repository source.
- `apps/desktop/package.json` and `apps/desktop/package-lock.json`.
- Tauri Rust project under `apps/desktop/src-tauri`.
- Node lifecycle sidecar source under `apps/desktop/lifecycle-sidecar`.
- Chatmail integration source under `integrations/chatmail`.

## External Dependencies

- Apple Silicon Mac.
- macOS with Xcode command-line tools.
- Node and npm.
- Rust and Cargo.
- Tauri CLI from `apps/desktop` dev dependencies.
- Network access to:
  - `https://github.com/chatmail/core`
  - npm registry for desktop dependencies
  - Cargo registry and git dependencies
  - `mail.seep.im` for real preflight and real account creation.

## Pinned RPC

- Source: `https://github.com/chatmail/core`.
- Revision: `823b0741df82e3ec0f61285d52bf91ae19b1963e`.
- Version: `2.54.0-dev`.
- Target: `aarch64-apple-darwin`.
- Repository-local path:

```text
.tools/deltachat-rpc-server/aarch64-apple-darwin/deltachat-rpc-server
```

Commands:

```bash
npm run desktop:rpc:install
npm run desktop:rpc:verify
```

## Bootstrap Command

```bash
npm run desktop:bootstrap:mac
```

The bootstrap checks the Apple Silicon toolchain, installs/verifies the pinned repo-local RPC binary if missing, runs desktop/Rust checks, and prints next manual preflight/launch commands. It does not create a Chatmail account.

## Mock Launch

```bash
npm run desktop:tauri-dev
```

This creates no real Chatmail account.

## Real Preflight

```bash
npm run desktop:profile:create -- --path /private/tmp/teti-mail-seep-real-alpha-02

TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \
TETI_DELTACHAT_RPC_PATH="$(node --experimental-strip-types apps/desktop/scripts/rpc.ts path)" \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
TETI_PROVISIONING_MODE=real \
TETI_ALLOW_REAL_PROVISIONING=1 \
npm run desktop:profile:preflight -- --path /private/tmp/teti-mail-seep-real-alpha-02
```

This preflight is non-destructive and does not create an account.

## Real UI Launch

Only after explicit approval to create one new real identity:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \
TETI_DELTACHAT_RPC_PATH="$(node --experimental-strip-types apps/desktop/scripts/rpc.ts path)" \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
npm run desktop:real-validation
```

## Absolute Path Dependence

Removed from documented setup:

```text
/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server
```

Current resolution order:

1. explicit `TETI_DELTACHAT_RPC_PATH`;
2. repository-local `.tools/deltachat-rpc-server/aarch64-apple-darwin/deltachat-rpc-server`;
3. explicit failure through `deltachat-rpc-server` command lookup if neither is present.

The runtime does not silently search arbitrary system directories and does not download binaries at startup.

## Current-Mac Verification

Completed:

- `npm run desktop:rpc:path` prints the repo-local target path.
- `npm run desktop:rpc:install` completed against the pinned official `chatmail/core` revision and installed the arm64 binary into `.tools/`.
- `npm run desktop:rpc:verify` passed using the repository-local RPC path without `TETI_DELTACHAT_RPC_PATH`.
- Runtime/relay/account targeted tests passed: 25 tests.
- Full JS tests passed after the real-account work: 112 tests.
- Desktop typecheck passed.
- Desktop tests passed: 37 tests.
- Desktop build passed.
- Rust check/test passed.
- Tauri release build passed.
- `npm run desktop:bootstrap:mac` passed end-to-end and did not create a real account.
- Real preflight passed with `mail.seep.im`.
- Repository-local real preflight passed for `/private/tmp/teti-mail-seep-real-alpha-03` without `TETI_DELTACHAT_RPC_PATH`, then the temporary profile was cleaned.
- One real UI account creation succeeded.

Not completed:

- A clean clone was not created because the current worktree contains required uncommitted implementation files.
- No second real account was created, by design.

Files that must be committed or transferred before a clean Mac can reproduce from source:

- `integrations/chatmail/relay-config.ts`
- `integrations/chatmail/relay-diagnostics.ts`
- `integrations/chatmail/runtime-diagnostics.ts`
- `integrations/chatmail/runtime-config.ts`
- `integrations/chatmail/provisioner.ts`
- `core/account/manager.ts`
- `apps/desktop/lifecycle-sidecar/profile.ts`
- `apps/desktop/scripts/profile.ts`
- `apps/desktop/scripts/rpc.ts`
- `apps/desktop/scripts/bootstrap-mac.ts`
- relevant tests under `integrations/chatmail`, `core/account`, and `apps/desktop/test`
- root and desktop `package.json`
- `.gitignore`
- setup and implementation docs.

## Tauri Release Classification

`source-build usable`

Not self-contained yet:

- Node lifecycle sidecar is TypeScript source run by the development Node runtime.
- `deltachat-rpc-server` is not bundled into the Tauri app.
- Release binary cannot create accounts without an external RPC path or repo-local tool path.
- Code signing and notarization are not configured.

Production-distributable status requires:

- bundled or compiled lifecycle sidecar;
- bundled arm64 or universal `deltachat-rpc-server`;
- executable permission preservation;
- Tauri resource/sidecar path resolution;
- signing and notarization;
- license and upgrade policy.

## New-Mac Setup Guide

Guide:

```text
docs/setup/TETI_DESKTOP_NEW_MAC_SOURCE_SETUP.md
```

It includes:

- supported environment;
- clone/install commands;
- RPC install/verify commands;
- desktop build commands;
- mock launch;
- real preflight;
- real UI launch with warning;
- troubleshooting.

## Limitations

- `.tools/` is ignored and local-only.
- The current real validation profile under `/private/tmp/teti-mail-seep-real-alpha-01` contains real account state and must not be copied as source.
- A second Mac should create a different isolated profile and a separate explicit approval before creating another identity.
- The current release build is not a zero-dependency installer.

## Next Step For Second Mac

On the second Apple Silicon Mac:

1. Clone the repository after these changes are committed or transferred.
2. Run `npm --prefix apps/desktop install`.
3. Run `npm run desktop:bootstrap:mac`.
4. Create a fresh isolated profile.
5. Run real preflight.
6. Stop before real UI creation until explicit approval is given for exactly one new identity.
