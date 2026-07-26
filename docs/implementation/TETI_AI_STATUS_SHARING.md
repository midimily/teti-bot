# Teti AI status UI and sharing protocol

> Historical Resource/observed-Agent adapter. Beta 0.1.10 supersedes its
> outgoing schema and fixed dual-send behavior with Callable Passport schema 3
> and passive peer negotiation; see
> [`TETI_BETA_0_1_10_CALLABLE_PASSPORT.md`](TETI_BETA_0_1_10_CALLABLE_PASSPORT.md).
> Desktop
> presentation and settings consume the Passport domain described in
> `docs/TETI_BETA_MVP_1_0_PASSPORT_DOMAIN_INTEGRATION.md`. Phase 5 keeps
> `teti.ai.status.sync` but adds schema v2 Agent data; the complete current
> contract is in
> [`TETI_PASSPORT_PHASE_5_SHARING.md`](TETI_PASSPORT_PHASE_5_SHARING.md).

## Product behavior

The desktop toolbar's former run-status entry now opens **AI 工具状态**. The
Codex mark communicates only an exact recognized plan value:

- Free: grey
- Plus: blue
- Pro: purple
- unknown plan, signed out, unavailable, and stale: explicit non-membership
  states rather than silently falling back to Free

The panel shows the weekly remaining percentage as both a bounded progress line
and a value, with reset time in the compact `M/D HH:mm 重置` form. Inferred
weekly windows are labelled as estimates, and stale data is visibly marked.

The former interface-animation setting is removed. macOS's
`prefers-reduced-motion` preference remains authoritative. The same toolbar
position now opens **设置**, whose toggle is **Passport 分享**.
Both toolbar entries use dedicated blue image assets with matching sizing and
interaction treatment. Collapsing the island clears any open toolbar panel, and
clicking elsewhere inside the expanded island closes it. Activating Teti from
the macOS Dock reopens the expanded connection island. Native panel mode changes
are ordered and coalesced, and the idle resize is committed without a separate
AppKit frame animation so WebKit cannot leave the previous blue surface visible
during collapse.

Sharing consent updates optimistically while persistence completes. Repeated
changes remain interactive and use latest-intent-wins persistence; stale reads
or responses cannot overwrite the current selection. The Rust lifecycle bridge
routes concurrent sidecar responses by request ID, so a network-bound connection
poll never blocks the local setting request. Peer broadcasts are coalesced and
continue in the serialized background queue, so delivery cannot delay the switch
or create one network send for every rapid click.

## Consent and privacy boundary

Passport sharing is off by default. The lifecycle sidecar owns the setting and
persists it in the active Teti profile with mode `0600`; the renderer cannot
write the file directly. Turning sharing on sends status only to peers with a
`Confirmed` connection. Turning it off sends an empty revocation payload.

Resource rows contain only:

- a provider-neutral tool ID;
- normalized plan key and an explicit `membershipVerified` boolean;
- bounded quota period, rounded remaining percentage, reset/window metadata,
  and exact/inferred identification;
- ready/stale/unavailable state and timestamps.

Schema v2 also contains the complete sanitized Agent Passport fields: stable
Agent ID, product and provider, surfaces, installed state, detection source,
sanitized version, coarse running state, bounded process count, confidence, last
seen time, and observation time.

Payloads never contain access tokens, account IDs, email addresses, raw plan
values, raw endpoint responses, local errors, prompts, responses, model traffic,
commands, tool input, paths, source code, or Teti discovery profile fields. The
protocol validator rejects unknown fields, secret-like versions, oversized
payloads, and values outside conservative bounds.

## Protocol design

AI state uses the independent application message `teti.ai.status.sync`. It is
not added to the five-second presence heartbeat or the public discovery
heartbeat. This keeps consented private metadata out of public presence and
allows different retry and expiry policies.

The schema remains provider-neutral rather than Codex-specific. Version 1 is
bounded to eight `tools` and eight quotas per tool. Version 2 adds up to 64
sanitized `agents`.

A due synchronization sends schema v1 first and schema v2 second with identical
generation and expiry timestamps. Older peers retain Resource compatibility.
Current peers prefer schema v2 on an equal timestamp and therefore display
Agent data without a new application message type.

Enabled state is sent after confirmation, when data changes, and at most once
per ten-minute refresh interval when unchanged. Every payload expires after 30
minutes; the validator rejects TTLs over one hour. The receiver accepts AI
status only when both the Teti ID and transport sender match a confirmed peer,
ignores older updates, and displays expired data as expired.

Optional AI-status send failures never interrupt the existing connection poll
or presence heartbeat. If an immediate revocation cannot be delivered, the
last remote snapshot still expires by TTL.

## Asset and verification

The Codex mark is a downsampled copy of the official Codex light icon bundled in
the locally installed ChatGPT macOS application. The toolbar uses the supplied
`ai-tools-btn.png` and `settings.png` assets. CSS applies state colors and
consistent framing; no network image request or macOS permission prompt is
involved.

Automated coverage includes exact plan mapping, sanitized Resource and Agent projection,
strict protocol validation, private setting persistence, default-off consent,
concurrent sidecar response routing, confirmed-peer delivery, revocation,
field-level denial, stale Agent runtime fallback, rapid-toggle coalescing, Dock
activation, controller refresh behavior, and the new desktop copy. Tests use
fake usage data and an in-memory
Chatmail relay; they do not read the real Codex authentication file, contact
OpenAI, or consume model tokens.
