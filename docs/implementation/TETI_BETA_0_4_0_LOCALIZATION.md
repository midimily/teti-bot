# Teti Beta 0.4.0 Localization

Application version target: `0.4.0`

Status: M1–M6 are implemented. Beta 0.4.0 now provides a complete English and
Simplified Chinese presentation path across the current macOS visible UI,
including Tasks, Runtime progress mapping, and native Task image dialogs.

## Scope freeze

Beta 0.4.0 establishes the shared presentation baseline that the later Windows
client will inherit. The release remains a macOS product release and does not
add a Windows build, installer, or Windows-specific window behavior.

Included locales:

- `zh-Hans`: used for every primary Chinese system locale, including Simplified
  and Traditional Chinese preferences;
- `en`: used for every non-Chinese or unavailable system locale.

The default `auto` preference follows the first entry in the operating system's
preferred-language list. Settings also offers explicit `zh-Hans` and `en`
overrides. The display preference is local to the Desktop WebView, contains no
account or protocol data, and reloads the UI immediately after a change. An
invalid or unavailable preference store fails closed to automatic detection.

## Architecture boundary

Localization is a Desktop presentation concern:

- application, Task, Passport, Network, lifecycle IPC, and Store schema
  versions do not change;
- protocol values, diagnostic codes, log events, provider names, Teti IDs,
  user input, Peer content, Agent output, and existing Artifact bodies are not
  translated;
- UI labels, Teti-owned presentation statuses, accessibility labels, native
  dialog copy, dates, numbers, and pluralized units are localization targets;
- unknown or unsupported locales always fall back to English.

`DesktopI18n` is created once at startup and explicitly injected into
`DesktopAppOptions`. It is not a global singleton, so tests, browser previews,
future windows, and a future user override can supply an isolated locale.

The catalog is a TypeScript contract. Every locale must satisfy the same
`AppMessages` shape at compile time. Feature namespaces are added to that
contract as the corresponding visible UI is migrated; M1 starts with shared
actions, fallback states, and pluralized units rather than duplicating
unmigrated feature copy.

## M1 completion criteria

- `AppLocale` accepts only `zh-Hans` and `en`.
- All `zh-*` primary preferences resolve to `zh-Hans`.
- All other, missing, or invalid primary preferences resolve to `en`.
- English and Simplified Chinese catalogs satisfy one strong type.
- Date, date-time, number, plural-category, and plural-message formatters use
  the selected locale through `Intl`.
- Desktop startup injects `DesktopI18n` into the App.
- Startup sets the root document's `lang` and `dir` attributes before creating
  the App.
- Resolver, catalog, formatter, and startup injection behavior is covered by
  automated tests.
- Settings exposes Automatic detection, Chinese, and English in that order;
  forced preferences take precedence over the operating-system locale.

## M2 completion criteria

- Display Name validation returns a stable reason (`empty`, `too_long`, or
  `control_character`) instead of translated copy.
- First Launch state stores an error kind, recoverability, and a diagnostic
  code; name validation failures also store their validation reason.
- Connection, Passport, Task, and Memory controller snapshots store typed
  semantic codes instead of Chinese UI messages.
- Presentation adapters preserve the current UI behavior while keeping copy
  out of controller and domain state.
- Unknown Task, Memory, Connection, and First Launch errors map to safe generic
  states and never display raw backend messages.
- User-facing native profile and Task-image Tauri commands reject with
  serializable stable error codes.
- Automated tests cover semantic mapping, structured native error codes, and
  the unknown-error non-disclosure boundary.

## M3 completion criteria

- App Shell, First Launch, and the local update blocker render exclusively from
  the injected `DesktopI18n` catalog for Teti-owned copy.
- Toolbar accessibility labels and the Teti.bot brand-link label follow the
  selected locale while the protected brand wordmark remains English.
- Connection input, status messages, connection rows, compatibility and
  reachability states, remote Passport summaries, and expanded peer details
  derive localized copy from semantic state.
- First Launch actions use stable action kinds rather than comparing translated
  labels.
- Chinese and English tests cover First Launch, Shell catalogs, the update
  blocker, toolbar and brand copy, Connection messages, connection cards, and
  remote Passport presentation.
- All application version sources identify the release as `0.4.0`.

## M4 completion criteria

- The local AI Passport summary, resource sections, Agent state, capabilities,
  Codex quota presentation, and accessibility copy use the injected locale.
- Settings localizes the Teti and Network identity states, Passport sharing,
  Agent discovery and path controls, version/build information, and the local
  Profile reset confirmation flow.
- Network environment, protocol/service version, presence modes, and stable
  Network diagnostics are rendered from semantic state rather than stored UI
  messages.
- Osaurus Native Child keeps a locale-independent readiness state and reason
  code; the selected catalog supplies status, policy, actions, and safe errors.
- Child Memory settings and the Task-detail Memory subsection localize scope,
  authorization, record provenance, expiry dates, export/delete actions, and
  stable Memory error codes.
- Chinese and English automated tests cover local Passport, Codex Usage, Agent
  state, Settings/reset, Network environment and presence, Osaurus, and Child
  Memory.

## M5 completion criteria

- Task Inbox, Composer, Detail, authorization, execution, Artifact, image,
  ongoing collaboration, and explicit Delegation surfaces use the injected
  typed catalog.
- Receiver-local Runtime progress messages are never rendered directly. Stable
  execution state, long-horizon phase, stage index, and bounded unit counts map
  to local presentation copy.
- Unknown execution, Task, or long-horizon values fail closed to safe generic
  localized states.
- Task timestamps, image counts, stage and step numbers, audit counts, and
  singular/plural event labels use the locale-aware formatters.
- Task image selection and Artifact actions preserve local-only paths while
  passing localized native dialog titles and filter labels into Tauri.
- Chinese and English tests cover Task copy, status/progress mapping, dates,
  counts, plurals, native dialogs, and safe errors.

## M6 completion criteria and validation

- Native image selection and save commands accept catalog copy, validate it,
  and return stable failure codes; Rust contains no localized UI constants.
- English Task controls wrap and resize inside the production `600 × 360`
  Task window without horizontal overflow or clipped buttons.
- `check:localized-copy` rejects Han-script copy in the migrated primary
  presentation and native-command surfaces.
- `visual-mocks.html` exposes Inbox, Composer, and Detail states for isolated
  `en` and `zh-Hans` visual regression checks.
- All six Mock combinations were rendered at `600 × 360`; Inbox, Composer,
  Detail, authorization, delegation, Artifact, and scroll behavior were
  visually checked with no horizontal overflow or control clipping.
- A shared semantic collaboration record is rendered in both locales without
  protocol mutation. The full Desktop suite also exercises two local Teti
  runtimes independently of UI locale; this is the automated dual-Mac contract
  check, not a substitute for a physical two-device installation smoke test.
- Root package, Desktop package, Cargo package, Cargo lock, and Tauri metadata
  are aligned at `0.4.0`.
- The arm64 macOS 15 ad-hoc Beta package, checksum, release manifest, and
  runtime smoke verification are produced by `package:mac:adhoc`.
