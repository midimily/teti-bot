# Teti `0.4.1-beta.2` Windows real-machine evidence

Date: 2026-08-19
Host: Windows 11 x64-compatible build `26200`, AMD64
Repository: `C:\MidiMily\teti-bot`

This record separates evidence produced automatically on the current physical
Windows host from manual, cross-host, signed-release, and clean-VM gates that
have not been performed. The legacy Windows product-name API reports
`Windows 10 Home`; the build-machine policy identifies Windows 11 by the
authoritative build number and requires build `26100` or newer.

## Reproducible build machine

`C:\TetiBuildMachine\v1\evidence\windows-x64-build-machine.json` reports
`ok: true` for policy `teti-windows-x64-build-machine-v1`.

- policy SHA-256:
  `aa34182f52f3f437eac6b9d718372459c12322a3a9abeb6ca32dccbfe7a8151c`;
- Node `22.22.3`, npm `10.9.8`;
- Rust `1.92.0` MSVC, Cargo `1.92.0`, rustup `1.29.0`;
- Visual Studio Build Tools `17.14.37614.0`, MSVC `14.44.35207`, Windows SDK
  `10.0.26100.0`;
- CMake `3.31.6-msvc6`, Strawberry Perl `5.40.2`, NASM `2.16.03`;
- DeltaChat RPC `2.54.0-dev` at revision
  `823b0741df82e3ec0f61285d52bf91ae19b1963e`;
- normalized pinned `Cargo.lock` SHA-256:
  `06731fa656d45e7222cbae80f6fb18fcae0b25584a9e8df6c7aa6e5d8d9e3e63`;
- RPC SHA-256:
  `511d385d7e2501703cdf1d08576582219089dbfda1956b6e4649978c53ab2782`;
- repository Runtime, PE x64 checks, JSON-RPC health, and clean RPC shutdown all
  passed.

The dedicated Cargo home uses the pinned repository configuration and does
not modify the user's global Cargo configuration.

## Automated checks on Windows

- TypeScript typecheck: passed.
- Localized visible-copy and two-catalog guard: passed.
- Windows/macOS icon inventory: passed.
- Repository Node tests: `740` total, `727` passed, `13` intentionally skipped,
  `0` failed.
- Rust format check: passed.
- Native Rust tests: `30/30` passed, including the real protected Windows ACL
  round trip and real Job Object descendant termination test.
- Patch whitespace validation: passed.

The shared macOS path-policy unit test now uses a native absolute fixture on
Windows. The real macOS literal remains asserted when the same source is run
on macOS.

## M2 Runtime exit gate

Status: **passed on this Windows host**.

The isolated exit gate used the staged x64 Runtime and a fresh temporary
Profile. It created a controlled identity named `TetiWin26`, reloaded the same
identity from disk, completed JSON-RPC health, and reported:

```json
{
  "ok": true,
  "created": true,
  "accountReloaded": true,
  "jsonRpcHealth": true,
  "rpcVersion": "2.54.0-dev",
  "runtimeTarget": "x86_64-pc-windows-msvc"
}
```

No account address, account identifier, credential, or raw diagnostic is
retained in this record.

## Windows build artifacts

The release-optimized shell and an unsigned development NSIS installer were
built successfully with the bundled Runtime and embedded WebView2 Evergreen
bootstrapper configuration.

| Artifact | Size | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `apps/desktop/src-tauri/target/release/teti-desktop.exe` | 10,215,936 | `826518d370cf6b546174e84c5566cdc62122c475801d73eaaa856ad5bf5c5b81` | Not signed |
| `apps/desktop/src-tauri/target/release/bundle/nsis/Teti_0.4.1-beta.2_x64-setup.exe` | 34,302,377 | `d984f451eda799c2f2f7b8915e3b6d4cc3b35772a7cc949fb57cd50a6d5ce0c8` | Not signed |
| bundled `node.exe` | 86,969,160 | `780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b` | Valid upstream signature |
| bundled `deltachat-rpc-server.exe` | 24,195,584 | `511d385d7e2501703cdf1d08576582219089dbfda1956b6e4649978c53ab2782` | Not signed |

Development builds explicitly pass Tauri's `--no-sign`. The signed release
command injects the absolute signing script through the Tauri CLI `--config`
overlay and remains fail-closed on certificate, timestamp, signer, PE, or
inventory drift.

The first local executable exposed a Windows console because the Rust entry
point did not select the GUI subsystem. The rebuilt release entry point uses
`windows_subsystem = "windows"` only for non-debug Windows builds. MSVC
`dumpbin /headers` confirms machine `8664 (x64)` and subsystem `2 (Windows
GUI)`; debug builds retain their console diagnostics.

### Windows launch visibility remediation

Repeated launches of the first GUI-subsystem build created five responsive
Windows whose idle geometry was only `135 x 37` physical pixels at the active
DPI. This was the macOS notch-panel idle presentation being reused by the
Windows top-center companion, rather than a process crash.

The Windows launch path now reveals the full connection panel for an existing
account, ignores startup focus-loss noise for three seconds, and keeps the
macOS existing-account collapse behaviour unchanged. The Windows target also
pins `tauri-plugin-single-instance` `2.4.3`; a second launch shows and focuses
the existing `island` window and emits the existing activation event instead
of creating another application process.

The old running executable locked the normal Cargo target, so the remediation
candidate was built in an isolated target directory:

| Artifact | Size | SHA-256 | Authenticode |
| --- | ---: | --- | --- |
| `apps/desktop/src-tauri/target-ui-fix/release/teti-desktop.exe` | 9,976,832 | `58f1e34877eb2fe4dc9126a5ebc2656f54c2073f905c72e834d2c74c0a709d53` | Not signed |
| `apps/desktop/src-tauri/target-ui-fix/release/bundle/nsis/Teti_0.4.1-beta.2_x64-setup.exe` | 34,256,365 | `6cf542770b1017e941fc5a27e21b708384ee1cfd31cb25f0e02f4587d0785c34` | Not signed |

After all old processes exited normally, the same remediation was rebuilt into
the canonical `target/release` paths. Those promoted artifacts and hashes are
the primary entries in the Windows build-artifact table above.

For this candidate, the seven Windows native-shell tests, TypeScript typecheck,
locked Cargo check, Rust format check, and all native Rust tests passed for the
candidate; the promoted final build later passed the expanded `30/30` suite.
MSVC again reports machine `8664 (x64)` and subsystem `2 (Windows GUI)`.
The final GUI launch probe completed on the physical host. The packaged app
starts without a console, exposes a native Windows notification-area icon and
localized Show/Quit menu, and exits through the menu after orderly lifecycle
shutdown. Passport discovered the runnable Codex Desktop binary and refreshed
live quota data through the current Windows user proxy.

The network implementation is VPN-vendor-neutral. TUN/transparent VPNs remain
part of the normal Windows route; local-proxy VPNs are detected from the
enabled current-user loopback HTTP proxy, with no product, process, path, or
port matching. Only the Codex quota request receives the scoped proxy. A stale
proxy falls back to the normal OS route, and network failure preserves only
bounded local plan metadata without fabricating quota data.

Both collapsed and expanded island presentations retain the Mac geometry of
square top corners and rounded bottom corners. Native window clipping removes
the pale rectangular pixels outside the bottom arcs; a 474-pixel background
comparison on the physical host found zero changed outside-corner pixels.

## M3–M6 evidence boundary

| Milestone | Evidence completed here | Evidence still required |
| --- | --- | --- |
| M2 | Fixed Runtime provenance, real ACL/Job tests, RPC health, controlled identity create/reload, release shell | None for the documented M2 Wintel automation gate |
| M3 | Native Rust path, DPI geometry, ACL/Job, and shell tests; real Windows executable built and launched by the operator | Complete the documented two-locale mixed-DPI, sleep/resume, native dialog/Explorer, junction, and exact Profile-reset matrix |
| M4 | Windows detector/path/cancellation/recovery policies passed in the full Windows Node suite | A controlled Mac peer is required for Mac-to-Windows and Windows-to-Mac text/image Tasks, cancellation, crash recovery, and sleep/resume |
| M5 | Typecheck, visible-copy/catalog guard, locale contracts, shared UI tests, and real WebView2 launch artifact | Complete the OS-locale, 100–200% mixed-DPI, keyboard, Narrator, High Contrast, Reduce Motion, and stable-error manual matrix |
| M6 | Localized per-user NSIS development installer built with embedded WebView2 bootstrapper | A release certificate, trusted timestamp service, signed beta.1 predecessor, and restored clean VM snapshots are required for signed inventory plus `teti-m6-clean.json` and `teti-m6-upgrade.json` |

This machine is not claimed to be a restored clean VM. The unsigned installer
is suitable for local functional testing but is not a release-approval
artifact and may trigger Windows SmartScreen's unknown-publisher warning.
