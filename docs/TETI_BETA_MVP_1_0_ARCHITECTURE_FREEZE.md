# Teti Beta MVP 1.0 Architecture Freeze

Status: Accepted; Tasks 1–4 implemented
Scope: Product boundary, local runtime boundary, domain model, privacy boundary, and migration constraints
Implementation baseline: `05de174824374738690793361bec849b49ea4d0a`

## Decision

Teti Beta MVP 1.0 is a **Personal AI Capability Passport Node**.

It allows two confirmed Teti identities to exchange a user-controlled view of:

- who the user is;
- which AI resources the device can observe;
- which supported AI agents are installed;
- which capabilities can be derived from those resources and agents.

Beta 1.0 is not an Agent Gateway. It does not remotely invoke an agent, accept a task, transfer a prompt or source code, or return an agent artifact.

## Preserved product capabilities

The following working capabilities remain authoritative and must not be redesigned by the Runtime convergence:

- canonical Teti ID and Chatmail identity;
- `mail.seep.im` relay integration;
- Teti Registry registration and activity heartbeat;
- connection request, approval, rejection, reciprocal intent, and confirmed relationship state;
- local account and connection persistence;
- local Codex entitlement and weekly quota observation;
- opt-in sharing of the existing sanitized Codex status with confirmed peers;
- sender Teti ID and Chatmail address matching for confirmed peer messages;
- existing wire payloads and TTL behavior during Task 1 and Task 2.

## Beta boundary

### Included

1. Identity Passport
2. AI Resource Passport
3. Local Agent Inventory
4. Derived Capability Passport
5. Field-level Passport Sharing Policy
6. Private synchronization to confirmed peers

### Excluded

- remote agent invocation;
- execution grants or allow-once execution;
- prompts, source code, private files, or conversation transfer;
- MCP client or server integration;
- A2A endpoint or published Agent Card;
- Teti Agent, Command, or Message Protocol;
- Agent running/activity observation;
- per-peer policy overrides;
- a public SDK or adapter marketplace;
- a launchd-managed daemon;
- Resource, Agent, or Capability Passport data in Workers KV.

## Runtime decision

The existing Node lifecycle sidecar evolves into **Teti Runtime**. No second Runtime project or process is created.

```text
Teti Desktop UI
  -> Tauri / Rust host
  -> Teti Runtime (existing Node sidecar)
  -> account, registry, Chatmail, resource, agent, capability, and sharing services
```

Rust remains responsible for native macOS behavior, process supervision, and bounded local IPC. TypeScript/Node remains responsible for product-domain services and adapters.

### Lifecycle boundary

- Teti Runtime starts with the Teti Desktop application.
- It keeps running while the island is collapsed, hidden, or unfocused.
- It stops when the Teti Desktop application exits.
- Beta 1.0 does not promise availability after the application exits.
- A launchd daemon requires a later architecture decision covering installation, upgrades, single-instance storage ownership, IPC authentication, and uninstall behavior.

### Runtime ownership

As implemented in Task 2, Runtime owns:

- Registry activity heartbeat;
- Chatmail polling and backlog processing;
- confirmed-peer presence heartbeat;
- existing AI status synchronization;
- Codex resource refresh lifecycle;
- later Resource, Agent, Capability, and policy services.

Desktop remains responsible for UI state, presentation, and explicit user operations. As implemented in Task 3, Desktop periodically reads local Runtime snapshots, but those reads do not drive Registry, Chatmail, or provider network I/O.

Task 1 added an unconnected Runtime Host skeleton. Task 2 connects that Host to the existing sidecar process and transfers the characterized background jobs without changing their network payloads.

### P0 lifecycle safety invariants

Task 2 makes Runtime a long-lived owner of Chatmail and scheduled work, so process lifecycle is part of the data-safety boundary:

- exactly one Runtime may own a local Teti profile and its Chatmail accounts directory at a time;
- Runtime takes an exclusive, private local profile lock before starting any background job;
- a live lock causes a second Runtime to fail closed, while a stale lock may be recovered atomically;
- a lock holder removes only the lock carrying its own random ownership token;
- loss of the parent stdout or stderr pipe is terminal and must never create a recursive `EPIPE` diagnostic loop;
- Runtime shutdown first cancels future scheduling, then actively closes the Chatmail RPC transport and drains in-flight work within a finite deadline;
- the Rust host closes Runtime stdin, waits for graceful exit, then terminates the Runtime process group and performs a final `wait` so neither Runtime nor `deltachat-rpc-server` is orphaned;
- application exit invokes the Rust lifecycle shutdown explicitly; object destruction remains a final safety net.

These rules do not turn Runtime into an independent daemon. Its lifetime is still bounded by the Desktop application for Beta 1.0.

## Frozen domain model

Resource, Agent, and Capability are independent entities rather than a strict hierarchy. A `CapabilityBinding` relates them.

```text
AI Resource --+
              +--> Capability Binding --> Capability
AI Agent -----+
```

The TypeScript contracts are frozen in `core/passport/types.ts`.

### AI Resource

An `AIResource` represents an observed subscription, account entitlement, local model, or compute resource.

Required semantics:

- `availability` is one of `available`, `unavailable`, `stale`, or `unknown`;
- `assurance` states whether information is provider-observed, locally observed, or self-declared;
- a provider-observed snapshot is not an exportable cryptographic proof;
- quota is a separate field-level sharing permission;
- observations have timestamps and may expire.

Current Codex membership and quota data maps to an AI Resource in Phase 1. Task 1 does not alter the current Codex DTO or wire payload.

### AI Agent

An `AIAgent` represents supported software detected on the local device.

Beta observation is limited to:

- stable ID and name;
- CLI, desktop, or local-service type;
- installed, not installed, or unknown;
- command or application detection source;
- observation time.

Installed does not mean running, active, authenticated, or remotely callable.

### Capability

A `Capability` is a curated, user-visible description such as `coding` or `analysis`.

It is not a remote method, task type, tool invocation, quality score, or claim that an agent is currently executing.

### Capability Binding

A binding declares the known Agents and Resources required for one Capability. Every referenced entity is required. Bindings are curated and deterministic; they are not a general rule DSL or automatic semantic inference system.

### Capability Resolver

The future resolver may only:

1. read known bindings;
2. read observed Resource and Agent state;
3. derive `available`, `unavailable`, or `unknown` for a Capability.

It must not infer arbitrary abilities from process names, rank agents, or build an ontology in Beta 1.0.

## Frozen sharing model

`PassportSharingPolicy` applies one field-level policy to all confirmed peers:

- `resourceSummary` controls provider, product, plan, availability, assurance, and observation freshness;
- `resourceQuota` separately controls quota details;
- `agents` controls supported installed-Agent observations;
- `capabilities` controls derived Capability descriptors;
- `audience` is fixed to `confirmed_peers` in Beta 1.0.

All fields default to false. Per-peer and execution policies are outside Beta 1.0.

### Existing setting migration

When Phase 2 replaces `statusSharing:boolean`:

- `false` becomes all four sharing fields false;
- `true` becomes `resourceSummary=true` and `resourceQuota=true`;
- `agents` and `capabilities` remain false until the user enables them.

This preserves existing Codex sharing consent without silently exposing new data.

## Data placement and privacy

| Data | Local | Confirmed peer | Registry KV |
| --- | --- | --- | --- |
| Teti ID, relay address, public key, display name | Yes | Yes | Yes |
| Registry activity timestamp | Yes | Yes | Yes |
| AI Resource summary | Yes | Policy-controlled | No |
| Resource quota | Yes | Separately policy-controlled | No |
| Installed Agent observation | Yes | Policy-controlled | No |
| Capability descriptor | Yes | Policy-controlled | No |
| Credentials or login token | Local adapter boundary only | Never | Never |
| Prompt, source, file, conversation, Agent log | Never collected for Passport | Never | Never |

The current Registry public profile and `aiEnvironment` fields remain backward-compatible during Runtime convergence, but they are not the authoritative store for the new Agent or Capability inventory.

## Internal IPC and network boundary

The Rust-to-Runtime JSON Lines interface is private implementation IPC, not a Teti network protocol.

Task 4 replaces the fragmented Desktop read surface with:

- `passport.get`, which returns one Runtime-owned `RuntimePassportSnapshot` without network or provider I/O;
- `passport.sharing.set`, which persists the field-level resource policy and returns the updated Snapshot;
- the existing account and connection command methods for explicit user operations.

There was no released Desktop/Runtime pair before this migration, so Task 4 does not preserve cross-version private IPC. The obsolete `connection.list`, `connection.poll`, `usage.get`, `usage.refresh`, `sharing.get`, and `sharing.set` reads are removed from the allowed Desktop IPC surface.

This private IPC cutover does not change the Teti network boundary:

- `teti.ai.status.sync` remains unchanged;
- existing AI-status TTL behavior remains unchanged;
- Chatmail, Registry, connection, and presence payloads remain unchanged;
- `teti.capability.offer` is not expanded.

Runtime uses one process-local scheduler with these frozen Beta intervals:

- Registry activity heartbeat: 5 minutes, including an immediate attempt when Runtime starts with an account;
- Chatmail backlog, peer presence, and AI-status poll: 3 seconds, including an immediate attempt when Runtime starts with an account;
- Codex resource refresh: 10 minutes, including an immediate attempt when Runtime starts.

Account-bound jobs remain idle before first account creation and are triggered after a successful creation or Registry retry. One failed job is logged with secret-like text redacted and does not stop the other jobs. Runtime stops scheduling and drains in-flight jobs when the lifecycle sidecar exits.

## Approved implementation sequence

### Task 1: Architecture Freeze and Runtime Host Skeleton

- freeze this decision and the TypeScript contracts;
- add an unconnected, testable Runtime Host skeleton;
- preserve all production behavior.

### Task 2: Runtime Background Ownership Migration

- move Registry heartbeat, Chatmail polling, peer presence, AI status synchronization, and Codex refresh lifecycle into Runtime;
- make legacy polling calls return Runtime state without performing duplicate network I/O.

Implementation status: complete locally. The production sidecar entrypoint starts and stops `TetiRuntime` and owns all background network work.

### Task 3: Desktop Runtime Consumer Migration

- remove Desktop-owned background scheduling;
- retain UI snapshot refresh and user operations only.

Implementation status: complete locally. The obsolete Desktop Discovery heartbeat scheduler and bridge client are removed. Connection and AI-status controllers are Runtime snapshot consumers; account creation, Registry retry, connection request/accept/reject, and sharing changes remain explicit user operations.

### Task 4: Passport Domain Integration

- adapt the existing account, connection, Codex, sharing, and remote AI-status caches into the frozen Passport contracts;
- make `RuntimePassportSnapshot` the only Desktop read model;
- add Passport ViewModels for connection cards, the AI panel, and settings;
- retain the existing Teti network payload and privacy boundary.

Implementation status: complete locally. Runtime owns Passport aggregation, Desktop has one Passport controller, and Renderer no longer consumes Codex usage, remote AI-status, Chatmail, Registry, or `statusSharing` DTOs.

## Task 1 acceptance criteria

- no production entrypoint imports or starts `TetiRuntimeHost`;
- no existing timer, network request, payload, setting, or storage format changes;
- Runtime Host start is idempotent;
- Runtime jobs cannot overlap with themselves;
- one failed job does not stop other jobs or future scheduling;
- account-bound jobs can remain idle and be triggered after account creation;
- stop cancels timers and prevents in-flight work from rescheduling;
- existing Desktop, core, Chatmail, discovery, and Worker tests remain green;
- typecheck, Rust check, frontend build, and release packaging remain green.

## Task 2 acceptance criteria

- the lifecycle sidecar starts exactly one `TetiRuntime` instance;
- Runtime is the only production scheduler that sends Registry heartbeat, receives Chatmail backlog, sends due peer presence, synchronizes due AI status, and periodically refreshes Codex state;
- the old `discovery.heartbeat`, `connection.poll`, and production `usage.refresh` calls do not duplicate their background network work;
- connection request, accept, reject, sharing changes, account creation, and Registry retry remain explicit user operations;
- a new account activates account-bound jobs without restarting the Desktop process;
- connection results from explicit operations immediately update the Runtime cache;
- Chatmail event counters are accumulated between Desktop reads and consumed once;
- Runtime stop cancels future timers and drains work already in flight;
- broken parent pipes fail closed without recursive output or a busy loop;
- Runtime shutdown is bounded and actively closes Chatmail RPC;
- the Rust host reaps Runtime and its child process group on application exit;
- a second Runtime cannot use the same local profile concurrently;
- existing wire payloads, TTLs, storage formats, lifecycle method names, and UI behavior remain compatible through Task 3; Task 4 separately replaces unreleased private read methods;
- Task 3 is implemented and verified separately from the Runtime ownership migration.

## Task 3 acceptance criteria

- Desktop has no Registry heartbeat scheduler or heartbeat client;
- Desktop never calls `usage.refresh` in production UI code;
- connection snapshot reads never receive Chatmail or send peer heartbeats;
- AI-status snapshot reads never call the OpenAI provider;
- UI snapshot timers exist only to make Runtime-owned state visible to the user;
- pending connection requests still open the connection island and remain actionable;
- connection request, accept, reject, sharing changes, account creation, and Registry retry remain explicit user operations;
- Task 3 preserves the v1 private IPC method set; Task 4 later supersedes only the unreleased private read surface while preserving all network payloads;
- Desktop disposal cancels only UI animation, auto-collapse, and snapshot-read timers;
- Runtime remains healthy when the island is collapsed, hidden, or unfocused.

## Task 4 acceptance criteria

- `passport.get` performs local aggregation only and triggers no Registry, Chatmail, heartbeat, AI sync, or provider request;
- Snapshot identity may be null before account creation;
- local resources use the frozen `AiResource` contract and Agent/Capability/Binding arrays remain empty;
- remote Passport state is exactly `fresh`, `stale`, `disabled`, or `unknown`;
- expiry remains resource- or remote-Passport-scoped rather than invalidating the whole Snapshot;
- sharing persists as `PassportSharingPolicy`, defaults off, and migrates the previous boolean once without broadening consent;
- Desktop has one three-second local Passport reader and no connection, usage, or sharing read controller;
- connection request, accept, reject, account creation, and Registry retry remain explicit commands;
- Renderer receives Passport ViewModels and contains no legacy AI-status interpretation;
- all existing Teti network payloads and TTLs remain unchanged.
