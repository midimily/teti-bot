# Teti Mac App Beta 0.3.6 — Relationship Runtime Cutover

Beta 0.3.6 consumes Teti Network protocol `1`, minimum contract revision `7`, and requires
`relationships=true` together with the Identity, ClientInstance, Public Read, PublicProfile, and
Presence capabilities delivered by earlier Beta 0.3 versions.

## Authority boundary

Teti Network Relationship is the only collaboration authority. Runtime permits a collaboration
operation only after the signed authorization endpoint returns `decision=allow` and
`reason=confirmed` for the expected peer. Network errors and malformed responses fail closed.

`connections.json` retains public delivery/display recovery metadata and the latest observed
Relationship revision. It does not independently grant permission. Legacy Chatmail connection
handshakes are acknowledged for transport hygiene but cannot create or promote Relationship state.
The default desktop Runtime requires a Network Relationship service; the historical handshake
authority can only be enabled explicitly by legacy protocol tests and is not a shipped App path.

## Recovery

Each Network environment has its own private reconciliation store. A cold Runtime scans the stable
Relationship-ID snapshot, then consumes changes after the snapshot base checkpoint. Subsequent
cycles consume incremental changes. Runtime persists a checkpoint only after all corresponding
Relationship documents have been written to the local recovery cache.

Older revisions are ignored. Equal revisions must have the same canonical document fingerprint;
divergence is a protocol conflict and fails closed. Block and revoke command results update the
local projection immediately.

## Transport failure behavior

- Network unavailable: cached state may remain visible, but no collaboration message or Task is
  sent or processed. Incoming Chatmail messages remain unacknowledged for a later authorization
  attempt.
- Network authoritative deny: the in-flight collaboration message is rejected and acknowledged.
- Chatmail unavailable: Network Relationship reads and commands remain usable; message transport
  retains its existing queue/retry behavior.

All application envelopes are authorized immediately before Chatmail send and immediately before
processing. Task approval, delegation continuation, and durable resume also re-check Network
authorization before local Agent execution.
