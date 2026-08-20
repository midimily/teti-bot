# Teti Cross-platform CI

Teti uses two complementary GitHub Actions workflows.

## Hosted pull-request gate

`.github/workflows/cross-platform-ci.yml` runs on every pull request and every
push to `main`:

- `windows-2025`, x64, for the continuously available hosted Windows lane;
- `macos-15`, Apple Silicon arm64, for the supported Mac lane.

GitHub's x64 hosted Windows runner is Windows Server 2025, not Windows 11. This
lane catches Windows path, process, TypeScript, renderer and native-shell
regressions, but it must not be cited as Windows 11 certification.

Both jobs assert their actual Node platform and architecture before running:

1. `npm ci --prefix apps/desktop`;
2. desktop type-check, localization guard and icon guard;
3. the full repository test suite;
4. the renderer build;
5. Rust format, all-target check and tests with Rust `1.92.0` and `Cargo.lock`.

The real Profile ACL round-trip is intentionally excluded from the hosted
Windows Server lane because its filesystem security environment is not the
supported Windows 11 client environment. Its parser and native code still
compile here; the OS integration test runs in the exact certification lane.

Recommended required checks for branch protection are:

- `Windows x64 hosted compatibility`;
- `macOS 15 arm64`.

## Exact Windows 11 x64 certification

GitHub does not provide a standard hosted Windows 11 x64 runner. The exact lane
therefore uses a self-hosted runner in
`.github/workflows/windows-11-x64-certification.yml`.

Provision a clean Windows 11 x64 machine with:

- the current GitHub Actions runner;
- the default labels `self-hosted`, `windows`, and `x64`;
- the custom label `teti-windows-11`;
- the pinned build environment from
  `docs/setup/TETI_WINDOWS_REPRODUCIBLE_BUILD_MACHINE.md`.

The workflow verifies the Windows client product type, the `Windows 11`
caption, 64-bit OS state and Node `win32/x64` before accepting evidence. It
then rehydrates `.tools/` from the persistent build-machine root and rejects
Node, Rust, MSVC, SDK, auxiliary-tool or DeltaChat provenance drift.

The exact lane also runs the ignored-by-default
`real_windows_profile_acl_round_trips_as_protected` integration test against
the actual Windows 11 filesystem security model.

To activate automatic certification on every push to `main`, create the
repository Actions variable:

```text
TETI_WINDOWS_11_CI_ENABLED=true
```

Until that variable and runner are present, pushes skip the exact lane instead
of waiting forever. A maintainer can still start it explicitly with
`workflow_dispatch` after the runner is online.

Do not enable this self-hosted workflow for untrusted fork pull requests. It is
intentionally limited to `main` pushes and maintainer-triggered dispatches.
