# Teti AI status UI and sharing protocol

> Historical network-adapter note. Desktop presentation and settings now consume the Passport domain described in `docs/TETI_BETA_MVP_1_0_PASSPORT_DOMAIN_INTEGRATION.md`. The `teti.ai.status.sync` payload documented here remains unchanged as the current wire adapter.

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
position now opens **设置**, whose four-character toggle is **状态共享**.
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

Status sharing is off by default. The lifecycle sidecar owns the setting and
persists it in the active Teti profile with mode `0600`; the renderer cannot
write the file directly. Turning sharing on sends status only to peers with a
`Confirmed` connection. Turning it off sends an empty revocation payload.

Peer payloads contain only:

- a provider-neutral tool ID;
- normalized plan key and an explicit `membershipVerified` boolean;
- bounded quota period, rounded remaining percentage, reset/window metadata,
  and exact/inferred identification;
- ready/stale/unavailable state and timestamps.

They never contain access tokens, account IDs, email addresses, raw plan values,
raw endpoint responses, local errors, prompts, model traffic, or Teti discovery
profile fields. The protocol validator rejects unknown fields and identifier
values outside a conservative slug format.

## Protocol design

AI state uses the independent application message `teti.ai.status.sync`. It is
not added to the five-second presence heartbeat or the public discovery
heartbeat. This keeps consented private metadata out of public presence and
allows different retry and expiry policies.

The schema is a versioned `tools[]` collection rather than a Codex-specific
packet. Future integrations such as Claude Code or CodeBuddy can add another
tool adapter without changing the connection protocol. Version 1 is bounded to
eight tools and eight quotas per tool.

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

Automated coverage includes exact plan mapping, sanitized share projection,
strict protocol validation, private setting persistence, default-off consent,
concurrent sidecar response routing, confirmed-peer delivery, revocation,
rapid-toggle coalescing, Dock activation, controller refresh behavior, and the
new desktop copy. Tests use fake usage data and an in-memory
Chatmail relay; they do not read the real Codex authentication file, contact
OpenAI, or consume model tokens.
