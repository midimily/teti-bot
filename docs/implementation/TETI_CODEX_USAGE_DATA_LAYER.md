# Teti Codex usage data layer

## Scope

This beta foundation retrieves the Codex/agentic plan value and weekly usage
window reported by the current Mac's Codex login. It implements background
fetching, parsing, in-memory state, refresh scheduling, and tests. The follow-on
UI and consented peer-sharing layer is documented in
`TETI_AI_STATUS_SHARING.md`.

The request is a metadata `GET` and does not invoke a model or submit a prompt,
so it does not consume OpenAI inference tokens. The endpoint is an internal
ChatGPT Web backend rather than a stable public OpenAI API:

`https://chatgpt.com/backend-api/wham/usage`

Its URL and payload compatibility logic are isolated so a future provider can
replace them.

## Process and security boundary

Teti already places local account files, network access, and credential-bearing
operations in its bundled Node lifecycle sidecar. The Codex provider follows
that boundary:

1. The native Tauri process starts the lifecycle sidecar during native desktop
   initialization.
2. Sidecar startup starts `CodexUsageService`, which performs one immediate
   refresh and schedules another 10 minutes after every completed attempt.
3. Each provider refresh re-reads `<codexHome>/auth.json` and extracts only
   `tokens.access_token` and optional `tokens.account_id`.
4. The access token is used only to build that request's Authorization header.
   It is not stored in the service, snapshot, logs, error messages, protocol
   result, renderer, telemetry, or persistent cache.
5. Only a sanitized `CodexUsageState` can cross the bounded lifecycle protocol
   through `usage.get` or `usage.refresh`. The desktop status controller uses
   these bounded methods; peer sharing uses a separate minimized projection.

The default Codex home is `path.join(os.homedir(), ".codex")`. Tests inject a
different location or reader. A non-standard packaged installation can set
`TETI_CODEX_HOME` for the sidecar without hard-coding a username.

## macOS access assessment

The current Tauri app is not configured with the App Sandbox entitlement, and
its ad-hoc signing script does not add one. A dot-directory directly under the
user home directory is not a macOS TCC-protected category such as Desktop,
Documents, Contacts, Photos, or Accessibility. In the current packaging model,
reading `~/.codex/auth.json` should therefore neither be blocked by App Sandbox
nor display a macOS consent alert.

This conclusion must be revisited if Teti later enables App Sandbox or ships
through a distribution channel that requires it. A sandboxed build normally
cannot read arbitrary `~/.codex` files. This implementation deliberately does
not disable sandboxing, add broad entitlements, show a file picker, or request
Full Disk Access. It reports a distinct permission error instead.

## Data semantics

`planTypeRaw` is the value reported by the usage endpoint. It is not independent
billing verification, so every snapshot has `membershipVerified: false`.
No local JWT decoding or string guessing is used. Teti currently has no
confirmed display-name mapping, so `planDisplayName` remains `null` while the
raw value is preserved, including unknown future values.

Weekly selection is duration-based rather than position-based:

- collect valid primary and secondary buckets from either supported field form;
- prefer a window within one hour of 604,800 seconds and mark it `exact`;
- otherwise choose the longest window of at least one day and mark it
  `inferred`;
- return `weekly: null` when no window is reliable, rather than presenting a
  short window as weekly usage.

Remaining percentage uses `remaining_percent` first, then
`100 - used_percent`, validates finite JSON numbers, and clamps to 0–100. It
never estimates quota from tokens, messages, or price.

Reset parsing accepts the documented absolute field aliases, Unix seconds,
Unix milliseconds, ISO timestamps, and relative-second aliases. Relative values
are based on the response's `observedAt`.

## Failure and refresh behavior

Authentication failures distinguish missing file, permission denial, other
read failure, malformed JSON, and missing access token. Network failures
distinguish timeout, unreachable network, 401, 403, 429, 5xx, other HTTP status,
invalid JSON, and unsupported payload shape. Public messages are constant and
never include request options, headers, raw exceptions, or response bodies.

The service coalesces simultaneous refreshes into one promise. A successful
snapshot is cached only in memory. A later failure returns the previous snapshot
as `stale`; a first failure returns `unavailable`. Neither path fabricates zero
remaining quota. `stop()` cancels the timer, and the default timer is unreferenced
so it cannot keep the sidecar alive.

## Verification boundary

Automated tests use injected auth readers, fake HTTP responses, and a fake
scheduler. They never access the developer's real `~/.codex/auth.json` and never
contact ChatGPT. They cover payload compatibility, plan semantics, reset forms,
error classification, secret non-disclosure, stale caching, immediate and
10-minute refresh behavior, stop/idempotence, and concurrent refresh coalescing.

No live diagnostic is run automatically. A real-account check remains a
separate, explicitly authorized validation because the endpoint is internal and
the local authentication file is sensitive.
