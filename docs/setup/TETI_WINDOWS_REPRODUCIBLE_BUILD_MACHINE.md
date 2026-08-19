# Teti reproducible Windows x64 build machine

This setup creates the controlled Windows build environment used for Teti's
Windows 11 x64 Runtime, native shell and installer work. The single source of
truth is `toolchains/windows-x64-build-machine.json`.

## Fixed inputs

| Input | Fixed value |
| --- | --- |
| Host | Windows 11 client x64, build 26100 or newer |
| Node/npm | `22.22.3` / `10.9.8` portable x64 archive |
| rustup | `1.29.0` x64 MSVC installer |
| Rust | `1.92.0-x86_64-pc-windows-msvc`, minimal + rustfmt |
| Cargo registry | RsProxy sparse mirror, isolated to Teti's `CARGO_HOME` |
| Visual Studio | Build Tools 2022 `17.14.39` (`17.14.37614.0`) |
| MSVC / SDK | v143 `14.44` / Windows SDK `10.0.26100.0` |
| CMake | `3.31.6`, supplied by the fixed Build Tools instance |
| Perl / NASM | Strawberry Perl `5.40.2.2` / NASM `2.16.03` |
| DeltaChat RPC | `2.54.0-dev`, chatmail/core `823b0741df82e3ec0f61285d52bf91ae19b1963e` |

Every downloaded archive or installer has a SHA-256 pin. The DeltaChat source
checkout additionally verifies the fixed `Cargo.lock` SHA-256 after the sole
platform normalization CRLF→LF, then builds with Rust `1.92.0`,
`cargo --locked`, `CARGO_INCREMENTAL=0`, HTTP multiplexing disabled for
reliable Windows downloads, and a fixed `SOURCE_DATE_EPOCH`.
The committed Cargo source replacement follows Cargo's mirror model: package
versions and `.crate` checksums still come from the fixed `Cargo.lock`. It is
written only below `C:\TetiBuildMachine\v1\cargo`; the user's global Cargo
configuration is not modified.

The Windows servicing revision is deliberately recorded in the machine
fingerprint instead of frozen forever. Security updates within a supported
Windows 11 client build are allowed; compiler, SDK and Runtime inputs are not.
Signed release files are not expected to be byte-identical because
Authenticode timestamps are intentionally fresh.

## Bootstrap a clean machine

Start from a clean Windows 11 x64 VM. Install Git for Windows, clone Teti to a
short path such as `C:\src\teti-bot`, then open an elevated Windows PowerShell
session from the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\apps\desktop\scripts\windows-build-machine.ps1 -Action Bootstrap
```

The command:

1. downloads and verifies the fixed Node, rustup, Strawberry Perl, NASM and
   Visual Studio Build Tools inputs;
2. installs portable tools under `C:\TetiBuildMachine\v1`;
3. installs the exact Build Tools instance under
   `C:\TetiBuildTools\VS2022-17.14.39` with only the committed component set;
4. installs the fixed Rust MSVC toolchain without changing the user's PATH;
5. runs `npm ci`, checks out the fixed DeltaChat source with CRLF conversion
   disabled, removes stale/untracked build inputs inside the dedicated managed
   checkout, and builds the RPC server from its locked dependency graph;
6. stages the verified Node/RPC Runtime into the repository and runs version,
   PE, provenance, JSON-RPC health and clean-shutdown checks.

No Chatmail identity is created by bootstrap or verification. A `3010` result
from the Visual Studio installer means the VM should be rebooted before using
the produced evidence.

## Enter and verify the environment

Dot-source the environment script in every interactive build shell:

```powershell
. .\apps\desktop\scripts\enter-windows-build-machine.ps1
npm run desktop:build-machine:verify
```

Verification fails closed on version, architecture, component, archive hash,
source revision, lockfile, Runtime provenance or JSON-RPC health drift. Its
machine-readable fingerprint is written to:

```text
C:\TetiBuildMachine\v1\evidence\windows-x64-build-machine.json
```

The fingerprint includes the policy hash and detected Windows, Node, npm,
rustup, Rust, Cargo, Visual Studio, MSVC, SDK, CMake, Perl, NASM, Git and
DeltaChat state.

## Rehydrate a checkout

GitHub Actions cleans ignored repository files, including `.tools/`. The
persistent build machine remains outside the checkout. Re-stage and verify the
pinned Runtime after every clean checkout with:

```powershell
& .\apps\desktop\scripts\windows-build-machine.ps1 -Action Hydrate
```

The guarded Windows 11 self-hosted workflow performs this automatically before
installing application dependencies.

## Build and release

After entering and verifying the environment:

```powershell
npm ci --prefix apps/desktop
npm test
npm run desktop:typecheck
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:runtime:windows:verify
npm run desktop:tauri-build:windows:shell
```

`npm run desktop:windows:release` remains a separate signed-release gate. The
bootstrap never imports, creates or exports a code-signing certificate.

## Codex quota network routing

The packaged Windows Runtime does not identify or depend on a particular VPN
product. Codex quota refresh uses the operating system's active configuration:

1. a transparent or TUN VPN is naturally used by the normal Windows route;
2. when a local-proxy VPN enables the current user's Windows Internet proxy,
   Teti validates and uses its loopback HTTP endpoint;
3. no VPN executable name, process, installation path, or port is hardcoded;
4. proxy variables exist only in a hidden, short-lived child process for the
   exact `https://chatgpt.com` quota request, and the bearer token is passed by
   standard input rather than command arguments, environment variables, or
   disk;
5. a stale local proxy falls back to the normal OS route, while an unavailable
   network falls back to bounded local Codex plan metadata without inventing a
   quota value.

For safety, the explicit proxy path accepts only an enabled, unauthenticated
HTTP proxy on `localhost`, `127.0.0.1`, or `::1`. Other Teti, Chatmail, and
DeltaChat traffic keeps its existing transport and proxy behavior.

## Updating a pin

Do not edit one version in isolation. A toolchain change requires:

1. a new policy ID and install root version;
2. official fixed-version URLs and independently checked SHA-256 values;
3. an updated `.vsconfig` when an MSVC/SDK component changes;
4. matching Runtime policy and automated tests;
5. a fresh clean-VM fingerprint and Windows 11 certification run.

Never replace a fixed URL with `latest`, `winget upgrade`, Chocolatey current,
or another mutable package-manager channel in the release build path.
