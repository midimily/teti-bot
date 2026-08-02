# Teti Architecture

Teti is a local-first identity companion.

The accepted Beta collaboration direction and versioned implementation plan are
defined in [`TETI_BETA_0_2_0_ROADMAP.md`](TETI_BETA_0_2_0_ROADMAP.md). Beta
0.1.2 freezes those future boundaries without changing current product or
network behavior.

## Layers

### Layer 1: Discovery

Cloudflare Worker + KV publishes short-lived public identity cards so other Teti nodes can discover available identities.

KV stores:

- Teti ID
- chatmail address
- public key
- public profile
- created and updated timestamps

KV must never store:

- private keys
- chat credentials
- private capability profiles
- connection graphs
- private conversations
- agent history

### Layer 2: Secure Communication

mail.seep.im is used as a relay for encrypted messages. The relay transports ciphertext only. Teti clients own the private keys and perform encryption/decryption locally.

### Layer 3: Confirmed-peer application semantics

The version-2 Teti Application Envelope carries Passport and Task semantic
objects over Chatmail. Beta 0.1.12 adds reliable text and image Task input,
transport receipts, explicit allow-once execution, state synchronization,
cancellation and bounded text Artifacts with identity binding, TTL,
idempotency, replay protection, passive version negotiation and offline
delivery.

This layer is A2A-aligned at the Task model boundary, but it is not a public A2A
endpoint and does not replace A2A. Transport receipt is separate from local
user approval and Agent execution. Local execution remains behind a qualified
Host Agent, an isolated task directory and a short-lived single-use Authority.

### Layer 4: Host/Child Agent execution

Beta 0.2.1 freezes `TetiHostAgent`, `LocalChildAgent`, `AgentConnector`,
`ExecutionTransport`, `ExecutionAuthority`, and `AgentResourceBinding`.
Collaboration stays Teti-owned while Codex and CodeBuddy become local Child
Agents reached through provider Connectors and `ProcessTransport`.

The Host owns authorization, workspaces, lifecycle, limits and Artifact
persistence. A Connector owns provider-specific invocation and decoding but
cannot access Passport, Chatmail or peer identity through its contract.
Transport details remain local and cannot enter a Task or Passport.

### Layer 5: Collaboration Workspace

Beta 0.2.2 adds `ephemeral_task` and `durable_collaboration` Workspace modes.
Task v6 transports only a temporary request or a confirmed Workspace
ID/revision plus abstract access. The receiver owns storage resolution, quota,
TTL, membership, Snapshot creation, and atomic revision commit. Absolute paths,
remote paths, arbitrary host paths, external folders, traversal, and symlink
escape are outside the contract.

### Layer 6: Local Runtime facade

Beta 0.2.3 activates `LoopbackHttpTransport` only for a qualified
`runtime_facade`. The first binding is `Osaurus Runtime (Bonsai)`: fixed-model,
text-only inference with no tools, Agent prompt, Osaurus Memory, or Host
Workspace. This is a Child Agent integration unit in Teti's architecture, but
it is not represented as an Osaurus Native Agent.

The local endpoint is not trusted merely because it is on localhost. Teti binds
Osaurus shared configuration to the live listener PID, signed app identity,
code-directory hash, and the owner of the established socket before sending a
body. Current official Osaurus builds still retain request bodies in Insights,
so the production qualification path fails closed and does not advertise the
Child until a verifiable no-retention capability exists.

### Layer 7: Receiver-local compute collaboration

Beta 0.2.4 adds a safe Compute Offer to Passport schema 4. The offer describes
only `general-text-assistance`, `local_model`, `receiver_local`, text-only I/O,
concurrency one, and allow-once approval. It does not expose or accept the
receiver's model, endpoint, port, hardware, credential, path, or Connector.

The requester selects the offer; the receiver's Host validates the exact offer
and capability, creates a single-use local grant, and maps it to its own
qualified Osaurus Connector. Active inference remains concurrency one behind a
bounded local queue. Osaurus is re-qualified before every execution so a
stopped, replaced, or restarted listener cannot reuse stale PID/signature
evidence. Teti retries discovery but never starts or configures Osaurus.

### Layer 8: Durable asynchronous execution

Beta 0.2.5 gives each receiver-local run a durable `ExecutionHandle` with a
renewable lease and monotonic `executionEpoch`. The handle store survives UI and
Sidecar restarts, while process handles, provider execution IDs, checkpoint
paths, and resume decisions remain local to the receiving Host.

Restart reconciliation is deliberately non-replaying. An orphan becomes
`interrupted`; external-side-effect work stays non-resumable. Only a Connector
that declares both Checkpoint and Resume, is classified as Workspace-pure, and
returns an explicit contained checkpoint can offer a user-triggered checkpoint
restart. The fresh run receives a new one-time Authority and higher epoch, so
late output from the prior process cannot commit an Artifact or Task result.

### Layer 9: Teti-managed Child Memory

Beta 0.2.6 keeps current Task input as execution-only Task Memory and adds two
opt-in durable scopes: exact Workspace plus Child Agent, or exact Child Agent.
The receiving user must first authorize the scope and then separately save a
completed local text Artifact. A Peer, Task prompt, completion event, Connector
or provider cannot write the store.

The Host selects at most four authorized records and 8 KiB for the exact Child;
Workspace records additionally require the exact execution Workspace. Selected
content is labeled untrusted historical reference data and added to Transport
input. The Connector receives neither database access nor Memory policy.
Records, authorization and exports remain receiver-local and never enter Task,
Passport, Chatmail or ExecutionAuthority.

### Layer 10: Osaurus Native Child

Beta 0.2.7 adds `Osaurus Native Agent (Teti)` as a distinct `native_agent`, not
an alias for the 0.2.3 Runtime facade. `OsaurusAgentTransport` targets only the
receiver's fixed `/agents/{id}/run` route. Signed listener identity, local Agent
policy, public Agent metadata and request-retention policy must all qualify.

The Host converts a confirmed Workspace Snapshot into a bounded, path-free
text context. The Connector never receives a mount, Passport, Chatmail or Peer
identity. Provider authority must deny Tools, native Memory, Host Workspace and
Autonomous Exec; a configuration digest change withdraws Readiness before a new
task can start. The HTTP run maps to Teti's existing durable states but remains
truthfully non-resumable because the provider endpoint is connection-bound.

### Layer 11: Long-horizon collaboration

Beta 0.2.8 makes the Teti Host, not any provider, the owner of a durable
collaboration session. A Child receives one bounded stage request and returns
one intermediate Artifact. At the stage boundary the Host records the
Workspace revision, creates a Host checkpoint, requests user input, and waits;
it does not recursively prompt the Child or automatically select another one.

Each stage has its own derived execution Task ID and Execution Epoch. A
Snapshot-writing stage must advance the exact expected Workspace revision;
read-only or bounded-context stages must leave it unchanged. Intermediate
Artifacts are append-only. Resume, Child selection, renewal, pause, failure,
checkpoint and completion are receiver-local audited events. The requester
sees only a minimized progress projection and can submit one bounded next-stage
instruction.

### Layer 12: Teti Host delegation

Beta 0.2.9 adds a receiver-local deterministic `DelegationPlan` above the
long-horizon stage mechanism. The user selects one to four ordered local
Child/Connector/Capability targets. The Host freezes each target's Resource
binding, bounded text budget, output budget, timeout and Workspace access, then
executes exactly one Child at a time. Each step depends only on its immediate
predecessor; delegation depth is fixed at one, so a Child cannot create another
Teti delegation or contact a remote Teti Agent through this contract.

The final step is not a Child. `Teti Host` deterministically bundles the ordered
intermediate Artifacts and records a final Artifact. Every provenance entry
binds Artifact ID, producing step, Child or Host producer, receiver-local
Resource binding and committed Workspace revision. A target or authority change
before execution stops the plan. A failed step never falls through to the next
Child.

The autonomous `DelegationPlanner` interface exists only as a future seam. Its
Beta 0.2.9 implementation is disabled and fail-closed. Plans can be created only
from the local user's explicit ordered selection; Task v6, Passport and Chatmail
contain no Delegation Plan.

### Layer 13: Security and recovery release gate

Beta 0.2.10 does not introduce a new product layer or execution route. It binds
the existing layers into one reproducible RC suite and adds receiver-local
checkpoint attestation at the durable execution boundary. The attestation is
stored beside Execution Handles, not in the collaboration protocol. Resume is
therefore allowed only when the current local file still matches the digest
captured from the atomic private copy; otherwise the resume capability is
quarantined. The application protocol, Connector contract and Host/Child
ownership model remain unchanged.

## Boundary

The Worker is an identity discovery layer, not a centralized user database or social graph.
