# Teti Application Protocol

The Teti Application Protocol starts only after two Tetis have a confirmed
trusted relationship. Chatmail remains the encrypted asynchronous transport;
the protocol is not a generic chat or public A2A endpoint.

## Beta 0.2 hard boundary

Beta 0.2 establishes collaboration epoch 2:

- Application Envelope: version 2 only;
- Presence: `collaborationProtocolEpoch: 2`;
- Task protocol: version 4 only;
- network Callable Passport: schema 3 only;
- processed-message Store: version 2.

Application Envelope v1 is rejected before its payload is dispatched. Task
v1–v3 and Passport v1/v2 are not downgrade targets. Historical parsers may
remain for read-only archive characterization, but are outside the 0.2 network
ingress.

## Layer boundaries

Identity is owned by chatmail/core. Discovery identifies public Teti
identities. The connection handshake establishes trust. Only a confirmed
connection whose Teti ID and Chatmail address match the sender may deliver an
Application Envelope.

The connection handshake is intentionally separate from the application epoch.
This allows identity, contacts, and confirmed relationships to migrate while
blocking 0.1 collaboration payloads.

## Envelope v2

```json
{
  "version": 2,
  "type": "teti.presence",
  "messageId": "uuid",
  "fromTetiId": "teti_abc123xyz",
  "createdAt": "2026-07-28T00:00:00.000Z",
  "payload": {}
}
```

The complete UTF-8 envelope is limited to 128 KiB before JSON parsing. Exact
top-level and payload key allowlists, bounded IDs and timestamps, canonical
`teti_[a-z0-9]{9}` identities, and private-field rejection apply before
business handling. A malformed Chatmail message is isolated from later
messages in the same poll.

For a syntactically bounded v1 envelope only the outer version, message ID, and
sender ID may be inspected to classify a confirmed Peer as `需要升级`. Its
payload is never parsed as a Task, Passport, or other Application Message.

## Presence

```json
{
  "type": "teti.presence",
  "payload": {
    "status": "online",
    "timestamp": "2026-07-28T00:00:00.000Z",
    "collaborationProtocolEpoch": 2,
    "taskProtocolVersions": [4],
    "passportSchemaVersions": [3]
  }
}
```

All three protocol declarations are required and exact. Reachability uses the
relay receive time rather than the sender's wall clock. Compatibility and
reachability are independent: a confirmed v1 sender can be recently reachable
and still require an upgrade.

## Callable Passport

`teti.ai.status.sync` accepts only schema 3 on the Beta 0.2 network. It contains
only locally qualified callable Agents, curated Capabilities, Bindings, bounded
resource summaries, and sharing/expiry metadata.

It never includes installation paths, executable paths, command arguments,
credentials, prompt text, Task input, result content, Adapter identity, login
tokens, or process details. A Passport is sent only after the Peer advertises
epoch 2 and schema 3; unknown and incompatible Peers receive no speculative
payload.

## Task v4

`teti.task.request` accepts only a `CollaborationTaskRequest` with
`schemaVersion: 4`. It carries an immutable Task ID, requester/target IDs,
selected offer and capability, bounded text plus up to four ordered PNG/JPEG
descriptors, creation time, and expiry. Image bytes travel only through the
Chatmail file field.

The protocol also defines:

- `teti.task.receipt`: durable request ingestion and supported Task `[4]`;
- `teti.task.attachment`: verified input or Artifact bytes;
- `teti.task.attachment.receipt`: emitted only after durable verified storage;
- `teti.task.status`: monotonic A2A-aligned Task state revision;
- `teti.task.cancel`: idempotent cancellation request;
- `teti.task.artifact`: bounded text and/or verified image result manifest.

Several Task-v4 component payloads retain `schemaVersion: 1` as their own
structural schema. This does not mean Task protocol v1 is accepted; the
containing Application Envelope v2 and an existing Task-v4 identity are
required.

Transport receipt, attachment receipt, local approval, execution status, and
Artifact are distinct events. Only the receiver's explicit Allow Once action
creates a short-lived local Execution Grant. Chatmail data cannot grant
execution.

## Attachment delivery and the 0.1.15 known defect

Every input and result image requests a durable per-attachment receipt. The
sender retries only unacknowledged attachment IDs with bounded backoff until
receipt or Task expiry. Duplicate bytes and receipts are idempotent. Format,
byte length, dimensions, MIME sniffing, Task/Artifact identity, and SHA-256 are
verified before an attachment becomes ready.

`KD-0.1.15-MULTI-IMAGE-DELIVERY` records the physical dual-Mac observation that
2- and 4-image Tasks often arrive incomplete while one-image delivery is
usually successful. Beta 0.2.0 temporarily tolerates the completion-rate defect
but fails closed:

- the receiver reports X/Y stored images;
- approval and execution remain disabled until all Y verify;
- incomplete Tasks never become completed;
- retries cannot cross Task or Artifact identity;
- per-image diagnostics record only safe IDs, sizes, hashes, attempts, state,
  timestamps, and safe error codes—never local paths.

## Replay, recovery, and storage

Generic replay IDs live in `~/.teti/store-v2/messages.json`; Task semantic state
lives in `~/.teti/store-v2/tasks.json`; verified attachments live below
`~/.teti/store-v2/task-attachments`. Application replay Store and Task Store
both use Store schema version 2.

Semantic `(requesterTetiId, taskId)` idempotency remains authoritative across
new envelope/message IDs. Conflicting immutable content is rejected. Status
revisions cannot roll back terminal or newer state. Interrupted execution
becomes `failed` with `TASK_RUNTIME_RESTARTED`. Task TTL remains authoritative
through authentication recovery and restart.

Migrated 0.1 Tasks, attachments, messages, and Peer capability state are copied
to read-only `~/.teti/legacy-0.1`. They are never loaded into active v2 Task or
replay state and therefore cannot be executed again.

## Result-image actions

Open, Reveal in Finder, and Save As accept only canonical verified PNG/JPEG
files below Teti's private v2 Artifact directory. No remote field can select an
arbitrary local path.
