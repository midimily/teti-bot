# Teti `0.4.1-alpha.2` Windows Runtime

## Runtime supply-chain policy

- Windows target: `x86_64-pc-windows-msvc`.
- Node: `22.22.3`, downloaded only from the official Node release URL and
  checked against the pinned SHA-256 before it enters `src-tauri/resources`.
- DeltaChat RPC: `2.54.0-dev` from chatmail/core revision
  `823b0741df82e3ec0f61285d52bf91ae19b1963e`.
- The vendored DeltaChat build is a single executable. The adjacent DLL
  allowlist is intentionally empty; packaging fails if any unlisted DLL is
  present.
- Runtime artifacts live under `.tools/` and are not source-controlled. Every
  Windows build regenerates resources from verified artifacts.

## Security and ownership

- The native Rust shell creates the LocalAppData Profile root before Runtime
  launch, removes inherited ACL access, and grants inheritable full control
  only to the current user and Local System.
- The ACL is read back and verified before the sidecar can start.
- The Node sidecar is assigned to a Windows Job Object configured with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. DeltaChat and later Runtime children
  inherit the Job.
- Clean shutdown is attempted first. The Job is terminated after the bounded
  grace period, and closing the Job handle is the final descendant kill guard.
- Windows diagnostics use the LocalAppData log directory and expose only
  bounded states (`profileSecurity`, `sidecarState`, and
  `descendantOwnership`) to the renderer—not local paths.

## Wintel build and exit gate

Run on a real Windows x64 development host with Rust, the MSVC build tools,
CMake, Perl, NASM, Git, and npm available:

```powershell
npm ci --prefix apps/desktop
npm run desktop:runtime:windows:install-node
npm run desktop:rpc:install
npm run desktop:runtime:windows:verify
npm run desktop:typecheck
npm run desktop:test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:runtime:windows:exit-gate -- --display-name "Teti Windows Alpha 2"
npm run desktop:tauri-build:windows:shell
```

The Windows-only Rust tests assert both the protected Profile ACL and that a
Job-owned Runtime descendant reaches zero active processes after termination.
The exit-gate script uses a fresh isolated Profile, performs DeltaChat JSON-RPC
health, creates a controlled identity when none exists, and reloads that same
identity from disk.

Do not mark the Wintel gate complete from a macOS cross-check. The Mac host can
compile-check the Rust Windows target, validate PE artifacts, and keep all Mac
tests/builds green, but Windows ACL semantics, native RPC execution, and Job
descendant cleanup must pass on the real Wintel host.
