# Teti Mac App Beta 0.3.3 — Presence

## Contract boundary

Beta 0.3.3 consumes Teti Network protocol `1`, minimum contract revision `4`, and requires
`identity`, `clientAuthentication`, `publicDirectory`, `publicProfile`, and `presence`.
The client consumes the versioned JSON/OpenAPI contract only; it imports no Hono or Redis types.

The two formal endpoints are:

- `PUT /v1/presence/self`
- `GET /v1/presence/{tetiId}`

Both use the Beta 0.3.2 ClientInstance signing contract. Presence reports intentionally omit
`Teti-Idempotency-Key`. A retry retains the exact Presence body while generating fresh request ID,
timestamp, nonce, and signature metadata.

## Runtime ownership

`RuntimePresencePolicyController` is the sole scheduler and report owner. Renderer and native macOS
code only submit policy signals:

- collaboration active: 5 seconds
- connection panel visible: 5 seconds
- foreground online: 15 seconds
- background: 30 seconds
- system sleep: stopped
- system wake or mode change: immediate

Mode priority is collaboration, connection panel, foreground online, then background. Normal
reports use bounded ±10% jitter. Retry backoff is 5, 15, 30, 60, then 300 seconds with ±20% jitter;
`Retry-After` is honored. One report may be in flight. Rapid signal changes coalesce into one
immediate report of the latest mode.

The report body is limited to schema version, session ID, monotonic sequence, mode, and the optional
`collaboration_active` marker. It contains no Profile, Agent, Resource, Capability, sharing policy,
Chatmail address, or task data.

## Peer state

Runtime reads confirmed peers through Network Presence and projects `checking`, `online`, `offline`,
or `unavailable` into the Passport snapshot. Only an authenticated HTTP 200 response with
`state=offline` becomes offline. Timeout, malformed response, rate limit, or Redis/Network failure
becomes unavailable and is shown as checking; transport failures never create a false offline state.

Chatmail heartbeat remains unchanged and is not used as the Network Presence report payload.

## Environment selection

Production is fixed to `https://network.teti.bot`. Settings provides a default-off local-development
switch fixed to `http://127.0.0.1:8788`. The preference is stored outside WebView storage with a
strict two-field schema and owner-only file mode. It does not accept arbitrary origins.

Changing the setting is restart-bound. The current Runtime continues using its active origin until
restart, preventing one process from signing requests against two Identity/ClientInstance domains.

## Verification

The Beta 0.3.3 test boundary includes:

- exact Revision 4 bootstrap policy parsing;
- minimal signed report/read request serialization;
- fake-clock 5/5/15/30 transitions, sleep/wake, jitter/backoff, and coalescing;
- fixed environment preference persistence and malformed configuration rejection;
- native sleep/wake and lifecycle bridge signal routing;
- local `teti-network` identity/auth/report/read/stale-sequence integration;
- TypeScript, Rust, full repository tests, and a macOS `.app` build without a DMG.
