# Teti Application Protocol

The Teti Application Protocol starts only after two Tetis have a confirmed
trusted relationship. Chatmail remains the encrypted asynchronous transport;
the protocol is not a generic chat or public A2A endpoint.

## Beta 0.2 hard boundary

Beta 0.2 establishes collaboration epoch 2:

- Application Envelope: version 2 only;
- Presence: `collaborationProtocolEpoch: 2`;
- Task protocol: version 6 only;
- network Compute Passport: schema 4 only;
- processed-message Store: version 2.

Application Envelope v1 is rejected before its payload is dispatched. Task
v1–v5 and Passport v1–v3 are not downgrade targets. Historical parsers may
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
    "taskProtocolVersions": [6],
    "passportSchemaVersions": [4]
  }
}
```

All three protocol declarations are required and exact. Reachability uses the
relay receive time rather than the sender's wall clock. Compatibility and
reachability are independent: a confirmed v1 sender can be recently reachable
and still require an upgrade.

## Compute Passport

`teti.ai.status.sync` accepts only schema 4 on the Beta 0.2.4 network. It contains
only locally qualified callable Agents, curated Capabilities, Bindings, bounded
resource summaries, privacy-minimized receiver-local Compute Offers, and
sharing/expiry metadata.

It never includes installation paths, executable paths, command arguments,
credentials, prompt text, Task input, result content, Adapter identity, login
tokens, or process details. A Compute Offer contains only an abstract offer ID,
capability, `local_model`, `receiver_local`, text modes, concurrency one,
`allow_once`, and an observation timestamp. It contains no model name/file,
Runtime endpoint, port, hardware detail, credential, token, local binding, or
Agent configuration. A Passport is sent only after the Peer advertises epoch
2, Task v6, and Passport schema 4; unknown and incompatible Peers receive no
speculative payload.

## Task v6

`teti.task.request` accepts only a `CollaborationTaskRequest` with
`schemaVersion: 6`. It carries an immutable Task ID, requester/target IDs,
selected offer and capability, bounded text plus up to four ordered PNG/JPEG
descriptors, an abstract Workspace request, an explicit `single_stage` or
`long_horizon` execution mode, creation time, and expiry. The
Workspace request can ask for temporary storage or reference a confirmed
Workspace ID/revision and access list; it cannot contain a path. Image bytes
travel only through the Chatmail file field.

The protocol also defines:

- `teti.task.receipt`: durable request ingestion and supported Task `[6]`;
- `teti.task.attachment`: verified input or Artifact bytes;
- `teti.task.attachment.receipt`: emitted only after durable verified storage;
- `teti.task.status`: monotonic A2A-aligned Task state revision;
- `teti.task.cancel`: idempotent cancellation request;
- `teti.task.input`: one bounded requester instruction for the current stage;
- `teti.task.artifact`: bounded text and/or verified image result manifest.

Several Task-v6 component payloads retain `schemaVersion: 1` as their own
structural schema. This does not mean Task protocol v1 is accepted; the
containing Application Envelope v2 and an existing Task-v6 identity are
required.

Beta 0.2.8 long-horizon status uses status schema 2. It projects only phase,
stage number, Workspace revision, bounded Progress, continuation expiry,
input-request ID and optional final Artifact ID. The receiver-local Child,
Connector, instruction digest, checkpoint digest, audit trail and provider
execution identity never cross Chatmail. Intermediate Artifact payloads add
only stage number and `intermediate`/`final` role. Duplicate Artifact IDs and
input IDs are idempotent.

Beta 0.2.9 does not add a network Delegation message or Task field. A
`DelegationPlan` is created only after receiver-local approval of an incoming
long-horizon Task. Ordered Child/Connector/Capability choices, Resource
bindings, per-step budgets, Workspace access, producer provenance and Host audit
remain in the receiver's Task store. The requester receives the already-defined
Task-v6 stage status and Artifact stream only; it cannot distinguish or address
the local plan's Child Agents through the wire contract.

Beta 0.2.10 likewise adds no Application Message or schema field. Checkpoint
integrity evidence, the Execution Handle store schema and the RC gate results
are receiver-local. Peers cannot provide, replace, address or attest a local
checkpoint, and no checkpoint digest or path crosses Chatmail.

For `local.compute.general-text-assistance.v1`, the receiver resolves the
abstract offer to its own locally qualified Connector. A `capability:` alias,
remote Workspace reference, model ID, endpoint, or local path cannot select the
Runtime facade. Only receiver-side Allow Once can mint the exact local grant.

Transport receipt, attachment receipt, local approval, execution status, and
Artifact are distinct events. Only the receiver's explicit Allow Once action
creates a short-lived local Execution Grant. Chatmail data cannot grant
execution.

Beta 0.2.5 does not add a network Task or Passport field. Durable
`ExecutionHandle`, provider execution identity, checkpoint location, lease, and
resume controls are receiver-local lifecycle state. Peer-visible Task status
continues to use the existing bounded state/error projection; a Peer cannot
name a checkpoint, provider run, local path, or resume authority.

Beta 0.2.6 likewise adds no network Memory field or message type. Task Memory is
the current bounded request during execution. Workspace and Child Agent Memory
records, authorization, provenance, content, deletion and export are
receiver-local lifecycle state. A Peer cannot request a durable write, name a
Memory record, select retrieval content, or receive a Memory export.

Beta 0.2.7 adds a second privacy-minimized Compute Offer resource class,
`native_agent`, for the qualified `Osaurus Native Agent (Teti)`. The wire object
still contains only offer ID, general-text capability, receiver-local execution,
text modes, concurrency one, allow-once and observation time. Fixed Agent UUID,
model, endpoint, port, provider authority, configuration digest and bounded
Workspace context remain receiver-local.

The requester cannot address `/agents/{id}/run` or select the Agent. Allow Once
resolves the abstract offer on the receiver, whose Host intersects the Teti
grant with Child and provider authority. No new peer message gives Osaurus a
remote Teti address, callback, Passport, Chatmail identity, provider Memory
control or Workspace path.

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
