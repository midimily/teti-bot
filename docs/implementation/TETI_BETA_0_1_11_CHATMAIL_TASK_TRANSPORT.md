# Teti Beta 0.1.11 Chatmail Task Transport

Status: Implemented

Application version: 0.1.11

## Outcome

Beta 0.1.11 adds a reliable, asynchronous Task transport between confirmed
Teti identities. It reuses Application Envelope version 1 and Chatmail. It does
not introduce a Teti transport protocol, an A2A endpoint, or a second message
channel.

This milestone transports A2A-aligned semantic objects; it does not claim A2A
wire-protocol compliance. The existing `CollaborationTaskRequest` uses A2A task
state vocabulary and is carried as the payload of `teti.task.request`.

Receiving a Task means only that it was durably ingested into the local pending
queue. It never means approval, execution, or success.

## Wire objects

The existing envelope remains unchanged:

```json
{
  "version": 1,
  "type": "teti.task.request",
  "messageId": "application-envelope-uuid",
  "fromTetiId": "teti_abc123xyz",
  "createdAt": "2026-07-26T00:00:00.000Z",
  "payload": {
    "schemaVersion": 1,
    "taskId": "task-uuid",
    "requesterTetiId": "teti_abc123xyz",
    "targetTetiId": "teti_def456uvw",
    "offerId": "capability:code-analysis",
    "capabilityId": "code-analysis",
    "input": {
      "kind": "text",
      "text": "Explicitly supplied task text"
    },
    "createdAt": "2026-07-26T00:00:00.000Z",
    "expiresAt": "2026-07-26T01:00:00.000Z"
  }
}
```

The receiver returns `teti.task.receipt` with `received`, `duplicate`,
`expired`, `conflict`, or `rejected`. A receipt confirms transport ingestion;
it is not a user approval response.

Both objects are strict allowlists. A Task cannot select an Adapter, Agent,
executable, command, argument, environment, path, workspace, model, URL, tool,
credential, or local file.

## Identity binding

A Task is accepted only when all of these agree:

1. the Chatmail sender address;
2. the confirmed connection address;
3. the envelope `fromTetiId`;
4. `requesterTetiId`;
5. the local account and `targetTetiId`.

Task messages from unknown or unconfirmed peers are ignored. Self-targeted and
non-canonical public IDs fail validation.

## Idempotency and replay

The semantic idempotency key is `(requesterTetiId, taskId)`, not the Chatmail
message number or Application Envelope `messageId`.

- The same Task ID and identical immutable request create one local record and
  return `duplicate` on later delivery.
- The same Task ID with different immutable content never overwrites the first
  request and returns `conflict`.
- A sender-side retry reuses the exact stored request, including timestamps,
  and does not create a second send after Chatmail has accepted the first one.
- A request left `queued` or `send_failed` is retried from the Runtime outbox.
- A receipt that could not be sent stays pending and is retried by Runtime.

The local store is `${profile.root}/tasks.json`, is written atomically with
mode `0600`, and is capped at 512 records. Expired records may be pruned to
make room; their absolute expiry still prevents a replay from entering pending
approval.

## TTL

- Default TTL: 1 hour.
- Maximum TTL: 24 hours.
- Empty, negative, excessive, or non-integer TTL values are rejected.
- An expired offline Task is recorded as `expired` and never enters pending
  approval.
- A remote `createdAt` more than five minutes in the future is rejected, so a
  forged future clock cannot extend the effective TTL.

## Version negotiation

Task payload schema and transport version are currently both 1.

- Presence heartbeat optionally advertises `taskProtocolVersions: [1]`.
- A Task receipt also advertises the receiver's complete supported version set.
- Unknown peers use compatibility floor v1. This is required so a current peer
  that is offline can receive its first Task without a synchronous handshake.
- Once a peer has advertised versions, Teti selects the highest common version.
- A known peer with no common version fails before sending.
- Pre-0.1.11 peers ignore the optional heartbeat field and reject the unknown
  Task application type safely. They cannot acknowledge or execute it.

This is passive negotiation. It adds no negotiation message and creates no
online prerequisite for Chatmail delivery.

## Offline delivery

Chatmail remains the offline transport:

1. the sender queues a Task while the receiver is offline;
2. the receiver's Runtime later drains Chatmail backlog first;
3. the receiver durably stores the Task before sending a receipt;
4. the receipt can itself wait in Chatmail while the sender is offline;
5. the sender later consumes the receipt and marks delivery acknowledged.

The test suite covers this complete path with the same `PeerConnectionRuntime`
used by production.

## Lifecycle surface

The existing lifecycle protocol version remains 1 and adds only:

- `task.send`: bounded Task construction and Chatmail submission;
- `task.list`: read-only, capped to one full record per response so the
  64 KiB bridge response limit cannot be exceeded.

There is deliberately no approve, execute, cancel-Agent, Artifact-send, path,
command, or arbitrary payload lifecycle method in 0.1.11.

## Deferred to 0.1.12

- incoming Task UI;
- explicit allow-once and reject actions;
- binding an approved Task to a locally qualified Callable Adapter;
- task status updates after transport receipt;
- bounded Artifact return and two-Mac product demo.
