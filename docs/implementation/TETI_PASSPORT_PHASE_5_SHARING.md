# Teti Passport Phase 5 Sharing

Status: Implemented
Date: 2026-07-25
Scope: Existing Passport switch, confirmed-peer delivery, Agent inventory
compatibility, privacy, and expiry

> Historical Phase 5 behavior through Beta 0.1.9. Beta 0.1.10 retains schema 1
> and 2 only for compatibility, stops outgoing coarse Observation projection,
> enables the Callable Capability catalog, and no longer dual-sends to known
> peers. See
> [`TETI_BETA_0_1_10_CALLABLE_PASSPORT.md`](TETI_BETA_0_1_10_CALLABLE_PASSPORT.md).

Beta 0.1.2 clarification: this schema-v2 Agent section is a compatibility view
of coarse Observation data. It does not assert that an Agent is authenticated,
controllable, or callable. The future callable Passport boundary is frozen in
[`TETI_BETA_0_1_2_BOUNDARY_FREEZE.md`](TETI_BETA_0_1_2_BOUNDARY_FREEZE.md).

## Product decision

The existing **Passport 分享** switch remains the only Desktop control in this
release.

- Off remains the default.
- Turning it on shares every currently available, privacy-safe Resource and
  Agent Passport field with every `Confirmed` peer.
- Turning it off sends an empty revocation to every `Confirmed` peer.
- Pending, rejected, unknown, or merely discovered Teti identities never
  receive a Passport.
- Capability sharing remains disabled because the Runtime does not yet produce
  a Capability catalog.
- Selected-peer policy is not exposed in this release. The audience remains
  `confirmed_peers`.

“Every Agent field” means every field in the sanitized `AiAgent` boundary. It
does not mean raw detector output or private machine data.

## Shared Agent fields

The current schema shares:

| Field | Meaning |
| --- | --- |
| `agentId` | Stable detector ID |
| `name` | Product display name |
| `provider` | Normalized provider slug, when known |
| `type` | Primary CLI, desktop, IDE extension, or local service surface |
| `surfaces` | All detected product surfaces |
| `installationStatus` | Installed, not installed, or unknown |
| `detectionSource` | Command, application bundle, or process |
| `version` | Sanitized locally observed version |
| `runtimeStatus` | Running, not running, or unknown |
| `processCount` | Bounded count, when observable |
| `confidence` | Low, medium, or high |
| `lastSeenAt` | Last coarse running observation, when available |
| `observedAt` | Observation time |

The Runtime shares all completed discovery rows, including installed,
not-installed, and unknown results. It sends no Agent list before the first
complete Observer scan, so startup and first registration do not expose
synthetic built-in rows.

## Non-negotiable privacy boundary

The Phase 0 denylist and strict wire allowlist remain authoritative. Teti does
not collect or share:

- prompts, responses, conversations, or transcripts;
- source code, file contents, file names, paths, working directories, projects,
  repositories, or branches;
- commands, command arguments, environment variables, tool input, or tool
  arguments;
- process IDs;
- access tokens, refresh tokens, API keys, cookies, credentials, or account
  identifiers;
- raw detector output, raw provider responses, or local error text.

An unknown wire field is rejected. Agent IDs, providers, surfaces, enums,
versions, timestamps, counts, collection lengths, and total payload bytes are
bounded. Version strings containing path separators or secret-like labels are
rejected.

## Compatibility strategy

No new Teti application message type is created. The existing
`teti.ai.status.sync` adapter now has two schema versions:

1. schema v1 contains the legacy sanitized `tools[]` Resource view;
2. schema v2 contains the same `tools[]` view plus sanitized `agents[]`.

For every due synchronization, Runtime sends v1 first and v2 second with the
same generation and expiry timestamps. An older peer consumes v1 and rejects or
ignores v2. A current peer prefers v2 when both snapshots have the same
`generatedAt`, so the Agent Passport wins without losing Resource compatibility.

The current format deliberately keeps bounded `tools` and `agents` arrays
present and uses empty arrays for a field-level denial or revocation. This is a
compatibility exception to a future “physically omit a denied section” schema;
an empty array contains no denied values. Introducing optional sections requires
a separately versioned contract and is not necessary for the single-switch
release.

## Consent and storage migration

The local sharing settings wrapper is version 3.

- No settings file loads the all-off policy.
- Legacy `statusSharing:false` migrates to all off.
- Legacy `statusSharing:true` migrates to Resource and Agent sharing on.
- The previous version-2 resource-only Passport policy migrates its enabled
  switch to Resource and Agent sharing on.
- Capability sharing remains false.

This intentionally broadens the meaning of the already-visible Passport switch:
after this Phase 5 decision, “on” means the complete privacy-safe Passport, not
only Codex plan and quota. It does not broaden the audience beyond confirmed
peers or cross the denylist.

Internally, the policy still has independent `resourceSummary`,
`resourceQuota`, and `agents` booleans. This provides testable field-level
enforcement and a future UI migration path. The current Desktop controller sets
all three together.

## Freshness and failure behavior

- Unchanged Passport data is refreshed on the existing AI-status schedule.
- Every payload has the existing 30-minute TTL.
- A remote enabled Passport becomes `stale` when its TTL expires.
- Expired Resources are marked stale.
- Expired Agent installation evidence may remain visible as historical
  information, but live runtime state falls back to `unknown` and process count
  is removed.
- A successful explicit revocation becomes `disabled`.
- If revocation delivery fails, the last remote snapshot still expires by TTL.
- Optional Passport transmission failure never interrupts Chatmail polling or
  peer presence.

## Bounds

- maximum encoded payload: 64 KiB;
- maximum Resource/tool rows: 8;
- maximum Agent rows: 64;
- maximum quota rows per Resource: 8;
- maximum Agent process count: 1,024;
- maximum TTL accepted by the protocol: 1 hour.

## Verification baseline

Automated coverage includes:

- default-off policy;
- migration from the boolean and previous resource-only policy;
- one switch enabling Resources, quotas, and Agents together;
- v1 followed by v2 delivery;
- v2 preference for equal-generation snapshots;
- delivery only to confirmed peers;
- complete safe Agent projection;
- independent quota and Agent field denial;
- revocation;
- stale runtime-state fallback;
- unknown-field, secret-like version, invalid TTL, invalid bound, and oversized
  payload rejection;
- isolation of optional Passport delivery failure from peer lifecycle.

## Phase 2–4 execution plan

Phase 5 does not make Teti an Agent Gateway. The following phases remain local
observation and Passport work.

### Phase 2: local Agent Status API

#### 2.0 Threat model and native identity spike

- Freeze the allowed callers, profile ownership, socket lifecycle, replay
  boundary, rate limits, and failure codes.
- On macOS, prove caller UID and PID retrieval on a Unix domain socket and prove
  how a stable signed-caller identity is derived. UID alone is not sufficient.
- Decide whether the authenticated socket gate belongs in the existing Rust
  host and forwards sanitized events to Runtime. Do not add an unauthenticated
  Node socket as a shortcut.

Exit: a test program cannot impersonate an approved caller by copying a string
identifier or token file.

#### 2.1 UDS transport and bounded parser

- Place the socket in the private active profile directory with owner-only
  permissions.
- Use length-framed or strictly bounded messages rather than unbounded JSON
  reads.
- Reject oversized, malformed, unknown-method, unknown-field, and rate-limited
  requests before they enter Runtime.
- Remove the socket during bounded shutdown and recover only a proven stale
  socket at startup.

Exit: malformed and oversized traffic cannot block Runtime, Chatmail, Registry,
or the Observer.

#### 2.2 One-time authorization and method grants

- Desktop shows an explicit allow-once decision for the authenticated caller.
- A grant binds caller identity, method, agent identity, expiry, and a
  single-use nonce.
- Grants are method-specific and fail closed after use, expiry, caller change,
  or Runtime restart.
- Never place reusable credentials in command arguments, logs, or the socket
  directory.

Exit: an unapproved Agent and a previously approved but expired/replayed request
are both rejected.

#### 2.3 Status method

- Accept only the frozen activity enum: `active`, `waiting_approval`,
  `completed`, `error`, and `unknown`.
- Allow only bounded session count, a separately sanitized model identifier,
  event time, and privacy-safe evidence metadata.
- Reject prompt, response, path, cwd, project, command, arguments, tool input,
  file, transcript, token, credential, and arbitrary metadata fields.
- Feed accepted reports into the Observer snapshot; do not execute Agent work.

Exit: authorized safe status is visible locally, while every forbidden field
and an oversized payload is rejected.

### Phase 3: Claude Code deep observation

#### 3.0 Official-surface research

- Re-evaluate current official Claude Code Skill, Hook, and MCP Tool
  documentation at implementation time.
- Compare lifecycle coverage, multi-session identity, approval events, model
  identifiers, configuration ownership, upgrade stability, and uninstall
  behavior.
- Reject transcript/log scraping and undocumented internal files.

#### 3.1 Zero-mutation adapter

- Keep the existing coarse installed/running detector as the default.
- Do not modify Claude configuration and do not install a Hook automatically.
- Verify independent launch, multiple processes, approval waiting, normal exit,
  crash exit, timeout, and Runtime-offline behavior.

#### 3.2 Explicit opt-in integration

- Only after user authorization, install or register the smallest official
  integration needed to report safe lifecycle state through the Phase 2 API.
- Make every configuration change previewable, attributable, reversible, and
  tolerant of an existing user configuration.
- Report only status, bounded session count, safe model identifier, source,
  observation time, confidence, assurance, and expiry.

Exit: no prompt, cwd, transcript path, response body, source code, tool input, or
credential is collected in any lifecycle path.

### Phase 4: Resource Adapter expansion

#### 4.0 Source qualification

For Claude, Cursor, and CodeBuddy, record for every proposed field:

- official source and documented terms;
- authentication and credential boundary;
- whether it represents subscription entitlement, API billing, or only local
  product state;
- confidence, assurance, observation time, expiry, and failure semantics;
- rate limit, maintenance owner, and fallback behavior.

Web scraping, cookies, session logs, transcript databases, and undocumented
private endpoints fail qualification by default.

#### 4.1 Adapter contract and fixtures

- Implement only sources that pass qualification.
- Keep provider credentials inside the adapter boundary.
- Project provider data into the frozen Resource, Entitlement, and Quota types.
- Store sanitized fixtures; never check real responses or credentials into the
  repository.
- Isolate timeout, malformed response, provider outage, and schema drift per
  adapter.

#### 4.2 Passport integration

- Add qualified Resource snapshots to the same local Passport aggregator.
- Reuse the current sharing policy and expiration behavior.
- Distinguish API credits and pay-as-you-go billing from desktop or CLI
  subscription rights in both model and UI copy.

Exit: every exported Resource field has a recorded source, confidence,
assurance, observation time, and expiry; one failed provider does not affect
another provider, Agent observation, or Runtime lifecycle.

## Recommended order

Implement Phase 2 before the opt-in part of Phase 3 because the deep Claude
adapter needs an authenticated local status ingress. Phase 4 source research can
run independently, but implementation should follow the source-qualification
gate. Do not extend the network schema again until Phases 2–4 produce stable,
privacy-reviewed local fields.
