# Teti Mac App Beta 0.3.5 — Relationship Contract Bring-up

Beta 0.3.5 consumes Teti Network protocol `1`, minimum contract revision `6`, and requires the
`relationships` capability in addition to the Beta 0.3.4 capabilities.

## Runtime boundary

Relationship HTTP is Runtime-owned and signed with the enrolled Network ClientInstance. The
Desktop UI continues to consume Runtime snapshots. Chatmail remains the message transport and its
connection records remain local recovery state; they do not override a newer Network revision.

Network projection is fixed as follows:

- `requested` + self requester → `Requested`
- `requested` + self addressee → `PendingApproval`
- `confirmed` → `Confirmed`
- `rejected` → `Rejected`
- `blocked` → `Blocked`
- `revoked` → archived and excluded from authorized messaging/task paths

`Accepted` remains a Chatmail delivery recovery state only.

## Command safety

Every Relationship write durably stores its exact JSON bytes, `If-Match`, expected revision, and
idempotency key before sending. A retry uses a fresh signed HTTP request while preserving those
four command facts. A successful retry is followed by a signed GET because an idempotency receipt
may contain a historical document.

A `412 RELATIONSHIP_REVISION_CONFLICT` clears the stale pending command and performs a fresh read,
but never replays the user intent. Reciprocal request is the sole stale exception: an incoming
`requested` relationship sends `currentRevision - 1`, the server's request-base revision, so both
members converge on one Relationship ID.

## Persistence and privacy

The App persists only canonical Relationship ID, revision, ETag, Network state, viewer-relative
`blockedBy`, and state-change time in the local recovery record. Relationship payloads contain no
Profile, Passport, Presence, Agent, Resource, Capability, Chatmail message, or credential data.

## Verification

Unit and Runtime tests cover strict response parsing, signed private reads, exact command recovery,
stale command behavior, historical receipts, all state projections, archive authorization, and
Identity/Chatmail address independence. The local integration test starts teti-network 0.1.5 with
a temporary SQLite database and isolated Redis prefix, registers two isolated ClientInstances, and
checks concurrent reciprocal request, repeated accept/reject, stale reject, block actor, revoke,
restart persistence, later request cycles, and stable canonical ID. Test state is removed on exit.
