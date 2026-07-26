# Teti Beta 0.1.2 Boundary Freeze

Status: Implemented
Date: 2026-07-26
Behavior change: none
Network protocol change: none

## Objective

Beta 0.1.2 freezes the boundary needed to evolve Teti from a Capability
Passport into a decentralized personal AI Agent collaboration node. It does not
invoke an Agent, accept a peer task, install a Hook, add a Chatmail message type,
or alter current Passport sharing.

The frozen path is:

```text
Observation -> Adapter Readiness -> Callable Agent -> Passport
                                                -> local Task execution later
```

The five concepts below remain independent.

## 1. Observation

`AgentObservation` is a local fact about installation, version, and coarse
process-running state. It is produced by the current Observer Supervisor and
continues to follow the Phase 0 privacy denylist.

Observation never proves that an Agent:

- is authenticated;
- accepts non-interactive work;
- can be canceled;
- can return a bounded result;
- is safe to expose as a callable Capability.

The current schema-v2 AI Status projection of observed Agents remains an
explicit compatibility behavior in 0.1.2. It must not be interpreted as a
callability claim.

## 2. Callability

`core/callability/types.ts` freezes a separate Adapter readiness state:

```text
not_detected -> detected -> adapter_available -> needs_login -> ready
                                      \-> degraded
                                      \-> disabled
```

Only `ready` may project to `CallableAgent`. A ready projection additionally
requires:

- stable Agent and Adapter IDs;
- a positive Adapter revision;
- at least one curated Capability ID;
- the Beta text input/output boundary;
- a valid readiness timestamp.

Installed, running, or high-confidence Observation is insufficient. Beta 0.1.2
does not connect the callability projection to Runtime or Passport.

## 3. Passport

Passport remains discovery metadata, not execution authority.

- The existing **Passport 分享** switch continues to control only the current
  privacy-safe Resource and Agent snapshot shared with Confirmed peers.
- It never grants permission to start a local process or Agent task.
- It never contains a task instruction, source file, local path, credential,
  response, or Artifact.
- The future callable Passport must consume `CallableAgent`, not raw
  `AgentObservation`.
- The existing schema-v1/v2 delivery remains unchanged until a separately
  versioned callable Passport migration is implemented.

## 4. Collaboration Task

`core/task/types.ts` freezes a local, A2A-alignable Task model without putting it
on the wire.

The first safe collaboration slice is text-only:

- a requester selects an advertised offer and Capability;
- a requester cannot select the receiver's Agent, Adapter, executable, command,
  working directory, or file path;
- a Task request is limited to 32 KiB total and 24 KiB of UTF-8 text;
- a request expires within 24 hours;
- self-targeting and non-canonical Teti IDs are rejected;
- output is a text Artifact limited to 64 KiB total and 56 KiB of UTF-8 text.

The Task state vocabulary mirrors A2A Task lifecycle concepts. Local user
approval is a separate state so Teti does not invent a competing network task
state machine.

Task text may contain content the requester explicitly types or pastes,
including a code snippet. Teti 0.2 planning does not authorize implicit reading
or transmission of either user's files, project, repository, prompt history, or
conversation history.

## 5. Execution Grant

An `ExecutionGrant` is local-only. It is never a Passport field and never a
Chatmail payload.

Every Grant is:

- bound to one Task, requester, Capability, Agent, Adapter, and SHA-256 input
  digest;
- valid for no more than five minutes;
- single-use;
- limited to an isolated task directory;
- denied access to user files;
- limited to a fixed Adapter entrypoint;
- unable to let the remote peer configure network access.

`networkPolicy: "agent_managed"` acknowledges that official cloud-backed Agent
clients require their own provider connection. It does not permit a peer to
choose a URL, proxy, host, command, or credential.

Grant issuance, persistence, consumption, replay protection, and Adapter
execution are intentionally deferred to later milestones.

## Privacy separation

The existing Observation/Passport denylist remains absolute for discovery
metadata. Task text is a separate, explicit user action and must be previewed at
both the send and allow-once boundaries when UI execution is implemented.

Beta 0.1.2 does not attempt unreliable secret detection inside arbitrary text.
Instead it guarantees that no local file, environment value, credential, token,
command, or conversation is added automatically.

## Compatibility invariants

Beta 0.1.2 does not change:

- Teti account creation or local profile paths;
- Registry registration, heartbeat, or KV fields;
- connection request, reciprocal intent, acceptance, or rejection;
- Chatmail polling, identity, relay, or message delivery;
- Teti Application Envelope version or message types;
- AI Status schema 1/2 payloads, ordering, TTL, or stale behavior;
- Passport switch behavior or audience;
- Desktop UI or Runtime scheduling;
- macOS minimum version, Bundle Identifier, signing, or package channel.

## Verification

Automated tests establish that:

- observed/detected/installed states cannot project to a callable Agent;
- only a valid `ready` Adapter claim projects;
- Task requests reject local execution selectors and unknown fields;
- Task requests reject self-targeting, uppercase public IDs, excessive TTL, and
  oversized text;
- Artifacts are bounded and text-only;
- Grants are short-lived, single-use, input-bound, and local-scope only;
- Passport sharing policy cannot validate as an Execution Grant;
- all application version sources and generated lock metadata remain aligned.

## Exit criteria

0.1.2 is complete when the full existing regression suite, new boundary tests,
Desktop typecheck, Rust checks, production Desktop build, and built App metadata
validation all pass at application version `0.1.2`.
