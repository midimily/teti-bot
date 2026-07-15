# Teti Desktop Shell Alpha Plan

## Repository Findings

- Package manager: npm. No root lockfile is present.
- Workspace structure: no npm workspace configuration exists. `apps/desktop` is currently a standalone placeholder directory.
- TypeScript configuration: no root `tsconfig.json` exists.
- Frontend conventions: no existing frontend framework in this repository.
- Build scripts: root `package.json` currently contains `test` only, plus first-launch tests added in the prior phase.
- Module format: root package uses `"type": "module"`.
- Linting/formatting: no ESLint, Prettier, or rustfmt config is present.
- Node requirements: tests run with Node's built-in `--experimental-strip-types` TypeScript support.
- Tauri dependencies: no existing Tauri files or dependencies were found.
- Structural reference: no other application in the monorepo can serve as a Tauri reference.

## Selected Frontend Stack

- Vite
- TypeScript
- Framework-free DOM rendering
- No React, Vue, Svelte, or component framework

This keeps the island UI small and avoids adding a large app-framework convention to a repo that does not have one.

## Selected Tauri Version

- Tauri v2
- npm package: `@tauri-apps/cli` v2
- frontend bridge package: `@tauri-apps/api` v2
- Rust crate: `tauri = "2"`

Exact patch versions are intentionally left to the package manager resolver in this alpha because the repository has no lockfile yet.

## Selected Directory Structure

```text
apps/desktop/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    main.ts
    app.ts
    styles.css
    platform/
      tauri-api.ts
      tauri-notch-window.ts
    provisioning/
      modes.ts
      mock-lifecycle.ts
      real-lifecycle.ts
    first-launch/
      existing first-launch core
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/default.json
    src/
      main.rs
      lib.rs
      window.rs
```

## Rust And TypeScript Responsibility Boundary

Rust / Tauri:

- app lifecycle
- single island window creation
- transparent, borderless, always-on-top configuration
- top-center monitor positioning
- expand/collapse/show/hide commands
- monitor info command
- native command argument validation

TypeScript:

- first-launch state machine
- `FirstLaunchCoordinator`
- rendering and user input
- provisioning mode selection
- view-model projection
- deciding when the island requests expand/collapse

Rust must not implement a second first-launch state machine.

## Window Lifecycle Model

- The app creates one window labelled `island`.
- Initial mode is compact idle/checking.
- Frontend calls `expand_island` and `collapse_island` through a typed adapter implementing `NotchWindowController`.
- One native window is reused for idle, onboarding, processing, error, and ready states.
- Physical notch avoidance is isolated in `src-tauri/src/window.rs` so it can be improved later.

## First-Launch Integration Model

- Frontend bootstrap creates:
  - provisioning lifecycle adapter
  - Tauri notch-window adapter
  - `FirstLaunchCoordinator`
- UI sends intent to the coordinator.
- Coordinator remains the lifecycle owner.
- Renderer observes coordinator snapshots through `toFirstLaunchViewModel()`.

## Development Provisioning Modes

Mock mode:

- `TETI_PROVISIONING_MODE=mock`
- Default for desktop shell development.
- Simulates success/failure/delay without creating real Chatmail accounts.
- Supports failure env flags for shell testing.

Real mode:

- `TETI_PROVISIONING_MODE=real`
- Explicit only.
- Must use the authoritative `createTetiAccount({ name })` path.
- This alpha includes the TypeScript adapter for that path, but the packaged browser runtime still needs a Node-capable bridge or sidecar before real provisioning can execute inside the Tauri app.
- No automatic fallback from real to mock success.

## Proposed Scripts

Root scripts:

- `desktop:dev`
- `desktop:build`
- `desktop:typecheck`
- `desktop:test`
- `desktop:rust-check`
- `desktop:rust-fmt`
- `desktop:tauri-build`

Desktop package scripts:

- `dev`
- `build`
- `preview`
- `typecheck`

## Test Strategy

Automated tests:

- preserve root `npm test`
- add desktop shell tests for:
  - provisioning mode selection
  - mock mode lifecycle
  - real mode does not silently use mock success
  - Tauri notch-window adapter calls expected commands
  - view-model to window mode mapping

Rust tests:

- add pure tests for top-center positioning and mode sizing.
- do not unit-test macOS native APIs.

Manual:

- run the Tauri app on macOS when dependencies are installed.
- verify no large main window, compact island, mock onboarding, ready collapse, restart behavior, and display positioning.
