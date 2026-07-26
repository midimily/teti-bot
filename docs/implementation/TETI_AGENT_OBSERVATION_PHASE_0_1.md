# Teti Agent Observation Phase 0–1

Status: Implemented
Scope: local-only Observation contracts and coarse Agent discovery
Network protocol impact: none

Beta 0.1.2 clarification: Observation remains local inventory evidence and is
not callability. Only a separately validated `ready` Adapter may later project
to a callable Passport Agent; see
[`TETI_BETA_0_1_2_BOUNDARY_FREEZE.md`](TETI_BETA_0_1_2_BOUNDARY_FREEZE.md).

## Frozen Phase 0 contracts

Schema version 1 freezes four distinct concepts:

- `Observation`: a timestamped, evidence-backed local fact. Unsupported levels
  are absent; `unknown` means a supported check could not establish a value.
- `ResourceObservation`: provider/product availability plus independently
  evidenced Entitlement and Quota observations.
- `EntitlementObservation`: plan, billing model, and sign-in state. It is not a
  billing receipt or cryptographic ownership proof.
- `QuotaObservation`: a bounded usage window, remaining percentage, reset time,
  and exact/inferred/unknown identification.
- `ExposurePolicy`: local discovery, Agent reporting, audience, and field grants
  are independent. Local discovery defaults on; every outbound field and Agent
  report defaults off.

The authoritative TypeScript contracts are in `core/observation/types.ts`.
Phase 0 does not replace the current Passport types or migrate stored data.

### Evidence semantics

Every evidence item records only:

- a closed source enum;
- low, medium, or high confidence;
- inferred, locally observed, provider observed, or provider verified assurance;
- adapter ID and revision;
- observation and optional expiry timestamps.

Evidence never contains raw commands, paths, provider responses, or credentials.

## Privacy denylist

`core/observation/privacy.ts` rejects forbidden keys recursively before an Agent
snapshot becomes Passport data. The denylist covers:

- prompts, messages, responses, conversations, histories, and transcripts;
- filenames, file paths, working directories, projects, repositories, and
  branches;
- commands, arguments, environment values, tool inputs, and tool arguments;
- tokens, API keys, cookies, and credentials;
- source code and private content;
- PID and PPID values.

Phase 1 detectors additionally enforce these collection rules:

- no network API exists in the detector system interface;
- no account, auth, token, entitlement, quota, prompt, source, or content file is
  opened;
- process enumeration is reduced immediately to executable basenames and only a
  count enters the Observation;
- executable and application paths are transient detector inputs and never enter
  the Observation or Passport;
- version output is limited to one sanitized line of at most 160 characters;
- secret-like or path-like version output is discarded;
- errors cross the boundary only as bounded safe codes.

## Existing Codex Resource adapter risk

The existing Codex Resource Passport behavior is deliberately preserved, but it
has a separate high-change-risk dependency:

- it reads the access token and optional account ID from the local Codex
  `auth.json` on every refresh;
- it calls the undocumented/internal
  `https://chatgpt.com/backend-api/wham/usage` endpoint;
- the endpoint, authorization rules, headers, response schema, plan labels,
  rate limits, and availability have no compatibility promise in this project;
- a returned `plan_type` and quota snapshot are provider-observed operational
  data, not billing-grade verification or a transferable proof of entitlement;
- Codex may rotate its auth format or endpoint without notice, causing a safe
  `unavailable` or `stale` Passport state.

Mitigations already present and retained:

- credentials are re-read and kept only within the provider request boundary;
- only required authorization headers are sent;
- requests have an eight-second timeout;
- raw responses, credentials, account IDs, and unsafe errors never enter
  Passport, diagnostics, UI, or Chatmail payloads;
- schema changes fail closed as `PAYLOAD_SCHEMA_MISMATCH`;
- the last good snapshot becomes stale rather than fabricated;
- `membershipVerified` remains false.

This Phase does not authorize migrating that adapter to another endpoint or
adding account access to Agent detectors.

## AI Status → Passport compatibility baseline

The current production network adapter remains `teti.ai.status.sync` schema 1.
Phase 0 adds a regression baseline proving that:

- `openai.codex`, plan key, weekly quota, reset time, and exact/inferred meaning
  map identically into the generic Passport Resource;
- the existing payload still passes its strict protocol validator;
- remote enabled/disabled/fresh/stale behavior is unchanged;
- Agent and Capability sharing remain false by default.

No Chatmail message, TTL, Registry field, stored account, or sharing migration
was changed by Phase 0 or Phase 1. Passport Sharing Phase 5 later extends the
existing AI-status message with a compatible v2 Agent section; see
[`TETI_PASSPORT_PHASE_5_SHARING.md`](TETI_PASSPORT_PHASE_5_SHARING.md).

## Phase 1 architecture

```text
Teti Runtime
  └─ Observer Supervisor (startup, then every 5 minutes)
       ├─ validated built-in/override catalog
       ├─ one bounded process-name snapshot
       ├─ isolated Codex detector
       ├─ isolated Claude Code detector
       ├─ isolated Gemini CLI detector
       ├─ isolated Cursor detector
       └─ isolated CodeBuddy detector
            └─ local install / version / coarse process-running only
```

The built-ins are declarative definitions. They detect:

| Agent | Install evidence | Version | Coarse running evidence |
| --- | --- | --- | --- |
| Codex | `codex` executable | fixed `--version` | exact `codex` process name |
| Claude Code | `claude` executable | fixed `--version` | exact `claude` process name |
| Gemini CLI | `gemini` executable | fixed `--version` | exact `gemini` process name |
| Cursor | executable or validated app bundle | app metadata or fixed `--version` | exact Cursor process name |
| CodeBuddy | executable or app bundle | app metadata or fixed `--version` | exact CodeBuddy process name |

“Running” means only that a matching local process name was observed. It does
not mean active, authenticated, operating on a project, accepting requests, or
remotely callable.

### Supervisor guarantees

- first discovery is independent of Teti account creation;
- before the first scan completes, Passport returns `agents: []`;
- the UI therefore renders no built-in Agent rows during startup,
  initialization, or registration;
- after completion, the complete observation list replaces the empty list
  atomically;
- later scans retain the last completed list while discovery is in progress;
- each Agent has a three-second supervisor deadline;
- version probes default to 1.5 seconds and 32 KiB;
- process enumeration, plist reads, and version probes have separate time and
  output bounds;
- one failure or timeout degrades only the affected Agent;
- malformed override configuration falls back to safe built-ins and records a
  safe local error;
- Runtime scheduling and all other Agent detectors continue after a failure.

## Override and kill switches

The optional local override file is:

```text
<Teti profile>/agent-detectors.override.json
```

Built-ins may be enabled/disabled and may have one local path override. The
override must retain the built-in executable or app-bundle name and cannot add
arguments or commands:

```json
{
  "schemaVersion": 1,
  "agents": [
    { "id": "cursor", "enabled": true, "pathOverride": "~/Applications/Cursor.app" }
  ]
}
```

`discoveryEnabled:false` disables all detectors.
`customDetectorsEnabled:false` ignores all `user.*` definitions.
`TETI_AGENT_DISCOVERY_DISABLED=1` is the highest-priority emergency kill switch
and short-circuits even an unreadable or malformed override file.

Custom definitions are bounded to declarative executable/app/process matching.
They cannot define a shell command, arbitrary arguments, version probe, network
request, content read, hook, account adapter, entitlement adapter, or quota
adapter. App paths are restricted to `/Applications/*.app` and
`~/Applications/*.app`.

## Explicit non-goals

Phase 0–1 does not:

- execute Agent hooks;
- observe prompts, tasks, sessions, activity, models, files, or project context;
- access Claude, Cursor, or CodeBuddy accounts;
- expose local Agent data to peers (implemented later by Passport Sharing
  Phase 5, not by the Phase 0–1 Observer);
- add a new Teti message type;
- write Agent data to Registry KV;
- derive Capabilities or enable remote invocation.

## Verification

Automated tests cover the frozen types, denylist, legacy compatibility mapping,
malformed configuration, override behavior, both kill switches, custom detector
rejection, first-scan UI behavior, per-Agent timeout, process/version failure
isolation, output bounds, sanitized version output, periodic snapshot stability,
Runtime scheduling without an account, and Passport revision changes.
