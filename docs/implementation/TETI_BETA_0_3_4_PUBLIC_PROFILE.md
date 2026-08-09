# Teti Mac App Beta 0.3.4 — Public Profile & State Change

Beta 0.3.4 consumes Teti Network protocol `1`, minimum contract revision `5`, and requires
`identity`, `clientAuthentication`, `publicDirectory`, `publicProfile`, and `presence`.

## Runtime boundary

- Presence remains the minimal Redis-backed session/mode/sequence report.
- PublicProfile is a low-frequency SQLite-backed full replacement containing only display name,
  avatar URL, summary, discoverability, platform, public categories, and public capability IDs.
- Confirmed-peer Capability Passport, Resources, Agent metadata, tasks, and sharing policy remain
  local/Chatmail data and cannot enter PublicProfile.
- Legacy Worker heartbeat is ID-only and cannot upload a Profile.

## Write recovery

`GET /v1/profile/self` returns a strong ETag. Before a `PUT`, Runtime persists the exact request
body, ETag, expected revision, and idempotency key. Retryable failures retain those values. A
`PROFILE_REVISION_CONFLICT` clears that attempt, reloads the latest document, recomputes the full
replacement, and allocates a new idempotency key.

Runtime state-change notifications are coalesced. They trigger recomputation, not unconditional
writes: only a changed public projection produces a Network mutation.
