# Teti Beta 0.4.2: Connection acceptance latency

## Scope

Beta 0.4.2 makes incoming connection approval visibly responsive without
weakening the authoritative Relationship transition. The checkmark still
commits through the Runtime and Teti Network before the row becomes confirmed.

## User-visible behavior

- The selected row immediately enters an `aria-busy` accepting or rejecting
  state in English and Simplified Chinese.
- The unchanged checkmark is replaced by a spinner and progress label while the
  operation is running, preventing accidental duplicate clicks.
- A successful bridge response is projected into the row immediately. A stale
  Passport refresh cannot temporarily roll it back to pending.
- Passport refresh runs after the committed result and no longer delays the
  checkmark response.
- Failures restore the actions and show a localized, retry-safe row message;
  transport or backend details never become UI copy.

## Runtime critical path

The authoritative accept and local Relationship projection remain the commit
point. The first presence message is published immediately so the peer can
prove protocol compatibility, but DeltaChat delivery observation is detached
from the serialized connection queue. Compute Passport broadcasting is left to
the normal poll cycle.

`connection.accept` diagnostics contain only stable result metadata and phase
durations (`queueWaitMs`, `authorityMs`, `projectionMs`, `presenceMs`,
`snapshotMs`, and `totalMs`). Peer addresses, display names, public keys, and
raw error messages are excluded.

## Regression gates

- Controller tests prove immediate per-row progress and that completion does
  not wait for Passport refresh.
- Controller tests prove safe localized failure recovery.
- Runtime tests prove a permanently pending delivery observation cannot block
  the connection queue.
- The complete peer Runtime suite preserves heartbeat, Passport, Task, image,
  Artifact, cancellation, and recovery behavior.
