# Security Model

## Privacy by Design

Teti assumes public infrastructure can be compromised. The discovery registry therefore stores only public, short-lived identity cards.

## Cloudflare KV Leakage

If KV data leaks, attackers may learn public identity metadata such as public keys, chatmail addresses, public categories, and AI environment labels. They should not obtain private keys, chat credentials, private profiles, connection graphs, conversations, or agent history because those fields are not accepted or returned by the registry.

## Local Ownership

Private keys must remain on the user's device. Future signature verification should prove ownership of an identity without sending private material to the Worker.

## Application and Task Ingress

Confirmed-peer status is necessary but not sufficient for accepting a message.
Beta 0.1.13 additionally enforces:

- a 128 KiB UTF-8 limit before Application Envelope JSON parsing;
- an exact top-level Envelope allowlist and bounded identifiers/timestamps;
- strict per-message payload schemas, canonical Teti identity binding and Task
  TTL/clock-skew limits;
- semantic Task deduplication, monotonic status revisions and ordered receipts;
- isolation of malformed messages so one payload cannot stop the Runtime poll;
- bounded image, Adapter input/output and process lifetime limits.

Remote data cannot select an executable, command, argument, environment,
workspace, path, credential, model or tool. A Chatmail receipt never grants
execution. Only a receiver-side allow-once action creates a short-lived local
grant.

Beta 0.1.14 treats generated images as untrusted files until they pass the same
PNG/JPEG, size, dimensions and SHA-256 checks as Task inputs. Adapter output
paths must resolve inside the isolated task workspace, then the image is copied
to the private Artifact store before that workspace is deleted. An
`image-editing` execution that produces no verified image fails closed and
cannot publish a text-only success.

Beta 0.1.15 result-image actions canonicalize the selected path and allow only
verified PNG/JPEG files beneath Teti's private Artifact root. Opening, revealing
or exporting a result therefore cannot turn a remote Task field into an
arbitrary local filesystem operation. Task-v4 attachment receipts contain only
strict task, peer, purpose and attachment identifiers plus a timestamp.

Beta 0.2.0 rejects Application Envelope v1 before business dispatch and accepts
only Task v4 and network Passport schema 3. A bounded legacy outer-header check
may classify a confirmed sender as `需要升级`, but never parses its payload as a
Task or Passport. Unknown or incompatible Peers receive no speculative
downgrade.

The active collaboration Store is isolated below `~/.teti/store-v2`. Migrated
0.1 Tasks and attachments are copied to a read-only, explicitly non-executable
archive. Active replay and Task stores start empty, preventing old queued Tasks
from being executed by the new Runtime.

For `KD-0.1.15-MULTI-IMAGE-DELIVERY`, incomplete delivery is a tolerated
availability defect only. Every expected image must independently verify before
approval or execution; per-image diagnostics contain no path or credential.

Beta 0.2.1 separates collaboration authorization from provider integration.
The receiver-side allow-once action is reduced to an exact-input-bound,
short-lived, single-use `ExecutionAuthority`. Only `TetiHostAgent` can validate
and consume it. An `AgentConnector` receives no Authority, task text, Passport,
Chatmail object, connection record or peer identity. It returns only a
local-only execution specification; the Host validates that specification and
writes task text to the selected Transport.

`ProcessTransport` retains fixed entrypoints, bounded arguments/environment,
isolated working directories, combined output limits and detached process-group
cleanup. `FakeTransport` is test-only. `LoopbackHttpTransport` is reserved but
disabled, so Beta 0.2.1 introduces no new local HTTP attack surface. Transport
and Resource Binding details are excluded from both Task and Passport.

Beta 0.2.2 replaces the Host's unversioned task directory with Collaboration
Workspace v1. Network Task v5 can request only a temporary Workspace or name an
already confirmed Workspace ID and revision. The receiving Runtime derives all
disk paths locally, issues a path-free ExecutionGrant/Authority, executes in a
private Snapshot, and commits only after traversal, symlink, file-type, quota,
and optimistic-revision checks. Snapshot paths exist only inside the Host and
Connector execution context.

Beta 0.2.3 activates `LoopbackHttpTransport` for `runtime_facade` Connectors
only. It accepts exact `http://127.0.0.1:<port>/v1/chat/completions` endpoints,
never follows redirects, never pools sockets, and refuses any Host Workspace.
Before sending task text, it verifies the published instance configuration,
single listener PID, canonical `Osaurus.app` location, Bundle ID, Developer Team
ID, code-directory hash, and owner of the exact established loopback socket.
An arbitrary process occupying the configured port therefore cannot qualify.

The Osaurus request contains one user text message, the fixed Bonsai model,
`stream: true`, and `tools: []`. Teti sends `X-Persist: false` and omits
`X-Osaurus-Agent-Id`, authorization, Memory, session, Skill, Agent prompt, and
Workspace data. Strict SSE is buffered and committed only after a valid finish
reason plus `[DONE]`; malformed streams cannot publish partial text.

The reviewed official Osaurus implementation still passes the full decoded
request body to its in-memory Insights ring even when `X-Persist: false` is
present. Because Teti cannot remove that copy without modifying Osaurus, 0.2.3
qualification fails closed with `OSAURUS_INSIGHTS_BODY_RETENTION`. The Child is
not registered or advertised until a documented, machine-verifiable
no-request-body-retention mode is available.

Beta 0.2.4 makes local compute a first-class, exact Passport schema-4 object.
Only a Host-registered Connector can publish an offer. The wire object is
limited to capability, `local_model`, `receiver_local`, text modes, concurrency
one, allow-once, ID, and timestamp; exact-key validation rejects model, Runtime
endpoint/port, hardware, credential, token, path, or local Agent configuration
fields.

Task v5 binds both offer and capability, but the receiver alone resolves them
to a local Connector. The local-compute offer cannot use a legacy capability
alias or a remote Workspace reference. Its path-free grant uses no Host
Workspace Snapshot. One execution may run and at most eight may wait; overflow
fails boundedly, queued tasks remain cancelable, and shutdown cancels the whole
queue. Osaurus trust, health, fixed-model inventory, and Insights policy are
rechecked per task, allowing a later task to recover only after a new listener
PID qualifies.

Beta 0.2.5 persists receiver-local execution identity separately from Task and
Passport. `providerExecutionId` and `checkpointRef` are never serialized into a
peer message. The handle file and private checkpoint copies use owner-only
permissions; checkpoint sources must resolve inside the Host-owned Workspace
Snapshot before copying.

Crash recovery never implies replay. An orphaned process is marked interrupted,
and possible-side-effect Connectors cannot become resumable. Workspace-pure
resume requires explicit Connector support, a captured checkpoint, a new
single-use Authority, and an incremented epoch. Every terminal callback and
Artifact publication checks that epoch, making duplicate completion and stale
process output harmless.

Beta 0.2.6 stores long-term Child Memory only after two receiver-local actions:
an exact scope authorization and a separate save of a completed incoming text
Artifact. Merely receiving, approving or completing a peer Task cannot persist
Memory, even if its prompt asks the Agent to remember private data. Task Memory
is the current execution input and is not written to the durable Memory file.

Workspace Memory requires both exact `workspaceId + childAgentId` matching and
a durable Workspace. Child Agent Memory requires an exact Child ID. Retrieval
rechecks live authorization and expiry against the authoritative store on each
execution; there is no v1 index that can outlive deletion. At most four records,
4 KiB each and 8 KiB total are injected as explicitly untrusted reference data.
The owner-only store and exports expose provenance locally, while no Memory
record, content, authorization or export path enters Task, Passport, Chatmail,
Connector context or peer-visible execution state.

Teti's inference request uses an exact verified 127.0.0.1 socket and has no
Authorization header, so Teti consumes no external API token for this route.
That statement does not assert that arbitrary third-party Runtime code has no
egress. The current Insights and local code-signature blockers remain
fail-closed, and the UI describes the capability as `本地算力`, never
`免费算力`.

Beta 0.2.7 applies the same signed listener and socket-owner boundary to the
Osaurus Native Child, then adds a fixed-Agent authority audit. The effective
permission is the intersection of the one-time Teti grant, the Child descriptor
and the provider record. Tools, Osaurus Memory, Host Workspace and Autonomous
Exec must all resolve to deny; missing fields are not treated as safe defaults.

The fixed Agent record is bounded, non-symlinked and hashed. Teti re-reads it
before every `/agents/{id}/run` request and watches its directory for atomic
replacement. A digest change removes the public offer and cancels work through
that Connector. A bounded Workspace context can contain selected relative paths
and UTF-8 content, but never the Snapshot path or an arbitrary host mount.
Provider-native Memory remains disabled until provider writes, retrieval and
deletion can be audited. The existing Insights body-retention blocker applies
equally to this endpoint.

## Authentication Recovery

Teti does not transport or persist Agent credentials. If an Adapter detects an
expired local login, the Task returns to `auth_required` and pending approval.
The user authenticates through the Agent's own local interface and must choose
allow once again. The original Task TTL remains authoritative, so an
authentication prompt cannot remain actionable forever.
