# Teti Desktop New Mac Source Setup

This guide is for a clean Apple Silicon Mac that will build Teti Desktop from source and optionally create one real Teti account through `mail.seep.im`.

Real mode creates an external Chatmail identity. Do not run real mode unless you intend to create one new account.

## Supported Environment

- Mac: Apple Silicon (`arm64`)
- macOS: validated on macOS 26.5.2; newer Apple Silicon macOS should work if Tauri v2 and Rust build normally
- Node: validated with the local Codex Node runtime; use current LTS or newer
- npm: required
- Rust/Cargo: validated with `rustc 1.92.0` and `cargo 1.92.0`
- Xcode command-line tools: required
- Tauri CLI: installed through `apps/desktop` dev dependencies
- Python: not required for the selected source-build path

## Clone And Install

```bash
git clone <teti-bot-repository-url>
cd teti-bot
npm --prefix apps/desktop install
```

## Delta Chat RPC Installation

Teti Desktop talks to Chatmail Core through `deltachat-rpc-server`.

Install the pinned official Chatmail Core build into the repository-local development path:

```bash
npm run desktop:rpc:install
```

Expected path:

```text
.tools/deltachat-rpc-server/aarch64-apple-darwin/deltachat-rpc-server
```

Verify:

```bash
npm run desktop:rpc:verify
```

Expected evidence:

- version `2.54.0-dev`
- architecture `arm64`
- JSON-RPC `get_system_info` health succeeds
- clean process shutdown

The `.tools/` directory is local development state and must not be committed.

## Desktop Build Checks

```bash
npm run desktop:typecheck
npm run desktop:test
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:tauri-build
```

Or run the non-destructive bootstrap:

```bash
npm run desktop:bootstrap:mac
```

The bootstrap may build the local RPC binary and run checks, but it does not enable real provisioning or create a Chatmail account.

## Mock Initialization

Mock mode creates no real Chatmail account:

```bash
npm run desktop:tauri-dev
```

## Real Initialization

Create an isolated profile:

```bash
npm run desktop:profile:create -- --path /private/tmp/teti-mail-seep-real-alpha-02
```

Run non-destructive preflight:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \
TETI_DELTACHAT_RPC_PATH="$(node --experimental-strip-types apps/desktop/scripts/rpc.ts path)" \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
TETI_PROVISIONING_MODE=real \
TETI_ALLOW_REAL_PROVISIONING=1 \
npm run desktop:profile:preflight -- --path /private/tmp/teti-mail-seep-real-alpha-02
```

Only after preflight passes and you explicitly approve creating one real external account:

```bash
TETI_PROFILE_DIR=/private/tmp/teti-mail-seep-real-alpha-02 \
TETI_DELTACHAT_RPC_PATH="$(node --experimental-strip-types apps/desktop/scripts/rpc.ts path)" \
TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im \
npm run desktop:real-validation
```

Expected success evidence:

- address ends in `@mail.seep.im`
- account is persisted under the selected profile
- ready state appears
- island collapses to idle
- restart skips onboarding
- same public Teti ID and Chatmail address load after restart
- duplicate creation is blocked

## Troubleshooting

RPC binary missing:

```bash
npm run desktop:rpc:install
npm run desktop:rpc:verify
```

Wrong architecture:

- Rebuild on Apple Silicon with `npm run desktop:rpc:install`.
- Do not use an x86_64 binary under Rosetta for validation unless explicitly documented.

RPC health failure:

- Confirm `TETI_DELTACHAT_RPC_PATH` points to the repo-local binary.
- Confirm the selected profile accounts directory is writable.

Relay DNS or TLS failure:

- Re-run preflight outside restricted network environments.
- Confirm `TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im`.

Address suffix mismatch:

- Treat provisioning as failed.
- Do not persist or register any address outside `@mail.seep.im`.

Profile already contains an account:

- Do not create another identity in the same profile.
- Use a new isolated profile only when intentionally creating a separate real account.

Incomplete marker:

- Inspect `<profile>/lifecycle/creation-marker.json`.
- Do not retry blindly if the marker is in `provisioning`, `persisting`, or `registering_discovery`.

Sidecar startup failure:

- Run `npm run desktop:typecheck`.
- Run `npm run desktop:test`.
- Check that `apps/desktop/lifecycle-sidecar/main.ts` exists in the source checkout.

Tauri build dependency failure:

- Verify Xcode command-line tools with `xcode-select -p`.
- Verify Rust with `rustc --version` and `cargo --version`.
- Reinstall desktop dependencies with `npm --prefix apps/desktop install`.

Real mode not explicitly authorized:

- Set `TETI_PROVISIONING_MODE=real`.
- Set `TETI_ALLOW_REAL_PROVISIONING=1`.
- Set explicit `TETI_PROFILE_DIR`.
- Set `TETI_CHATMAIL_RELAY_DOMAIN=mail.seep.im`.
