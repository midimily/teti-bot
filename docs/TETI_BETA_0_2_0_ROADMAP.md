# Teti Beta 0.2.0 Roadmap

Status: Accepted plan
Previous product baseline: Beta 0.1.1
Current implemented milestone: Beta 0.1.12
Next planned release: Beta 0.1.13

Product sequencing decision: 0.1.6, 0.1.7, and 0.1.8 are deferred and were not
implemented. The application version intentionally jumps from 0.1.5 to 0.1.9;
the skipped version numbers must not be read as completed Adapter milestones.

## Product target

Teti is a decentralized personal AI Agent capability collaboration and
pass-through node.

- Settings shows the broad local Agent observation catalog.
- Adapter readiness proves whether an Agent can actually accept a controlled
  task and return a result.
- Only callable Agents and their curated Capabilities enter the future AI
  Passport.
- Confirmed Tetis discover each other's callable Passport metadata.
- Collaboration requests travel asynchronously through Chatmail.
- The receiving user grants or rejects each task locally.
- Teti maps task lifecycle and results to A2A concepts without creating another
  Agent protocol.

Teti 0.2.0 does not expose a public A2A endpoint or Agent Card and must not claim
A2A protocol compliance. Chatmail remains a private asynchronous binding over
the existing Teti Application Envelope until a separately reviewed A2A bridge
exists.

## Milestones

| Version | Outcome | Release gate |
| --- | --- | --- |
| 0.1.2 | Version and Observation/Callability/Passport/Task/Grant boundary freeze | No production behavior or network change; full build green |
| 0.1.3 | Settings Agent management and five-vendor coarse discovery | Initial scan is atomic; Agent failures remain isolated |
| 0.1.4 | Callable Adapter kernel and fake-Agent harness | Timeout, cancel, process cleanup, output bounds, and safe errors pass |
| 0.1.5 | Codex controlled Adapter | Official local entrypoint, local auth reuse, text-only task, bounded result |
| 0.1.6 | Claude Code controlled Adapter — deferred, not implemented | Official surface qualification and the same execution safety gates |
| 0.1.7 | Gemini CLI controlled Adapter — deferred, not implemented | Official headless qualification and the same execution safety gates |
| 0.1.8 | Cursor controlled Adapter — deferred, not implemented | Official surface must pass stability and no-write validation |
| 0.1.9 | CodeBuddy controlled Adapter — implemented | Official Headless CLI passes login, no-tools, JSONL, cancel, timeout, concurrency, and Artifact gates; safe fallback remains detected-only |
| 0.1.10 | Callable Passport and cross-version projection — implemented | Raw Observation is local; only Runtime-qualified Agents and capabilities enter schema 3; known current peers receive no redundant legacy payload |
| 0.1.11 | A2A-aligned Task objects over Chatmail — implemented | Versioning, identity, TTL, idempotency, replay, durable outbox, and offline receipt pass; no execution |
| 0.1.12 | Two-Mac request, allow-once, execution, status, and Artifact UI — implemented | Text plus bounded image input; explicit approval; isolated Adapter execution; bounded text Artifact |
| 0.1.13 | Security hardening and release candidate | Restart, duplicate, reordering, crash, timeout, expiry, and old-peer tests pass |
| 0.2.0 | Beta collaboration release | Complete two-Mac demo and compatibility matrix pass |

Every completed milestone increments the application patch version. A
milestone does not increment its schema or protocol versions unless that
milestone actually changes the corresponding contract.

The 0.1.9 qualification found official CodeBuddy Code Headless, HTTP, and ACP
surfaces, but those belong to a separately installed `codebuddy` / `cbc` CLI.
The CodeBuddy CN desktop bundle and its `buddycn chat` editor launcher are not a
substitute. The audited Mac now has the standalone CLI installed and logged in;
0.1.9 selects only Headless process execution and leaves HTTP/ACP disabled.
Machines without the CLI or login remain fail-closed and do not register the
Adapter.

## Provider priority and qualification

Codex, Claude Code, Gemini CLI, Cursor, and CodeBuddy are the first Adapter
qualification set. Priority does not allow Teti to fabricate callability.

Every Agent shown as callable must prove:

1. a supported official invocation surface;
2. local authentication without exporting credentials to Teti peers;
3. non-interactive task submission;
4. observable completion or failure;
5. timeout, cancellation, and child-process cleanup;
6. bounded input, output, concurrency, and diagnostic data;
7. no remote control over local path, executable, arguments, or environment;
8. a stable mapping to curated Passport Capabilities.

An Agent that fails any gate remains visible in Settings as detected but does
not enter the callable Passport.

## Beta 0.2.0 collaboration boundary

Included:

- bounded text and explicitly pasted code snippets;
- per-task allow-once or reject;
- submitted, working, input-required, auth-required, completed, failed,
  canceled, and rejected states;
- bounded text Artifacts;
- Chatmail offline delivery within Task TTL;
- local idempotency and replay protection.

Deferred:

- automatic file or repository access;
- user workspace mutation;
- remote command, cwd, environment, URL, model, or tool selection;
- binary or file-reference Artifacts;
- reusable or unattended execution grants;
- launchd availability after Teti Desktop exits;
- public A2A HTTP/gRPC/JSON-RPC endpoints and Agent Cards;
- MCP platform work, SDK, marketplace, and arbitrary third-party Adapters.

## Previous Phase 2-5 mapping

- The planned UDS Agent Status API remains an optional observation ingress. It
  is not a prerequisite for Runtime-owned Adapter invocation.
- Claude Hooks remain an opt-in observation mechanism and are not the primary
  execution interface.
- Resource Adapter qualification may proceed independently, but only official,
  stable, privacy-safe entitlement fields enter Passport.
- Schema-v1 Resource and schema-v2 observed-Agent payloads remain accepted.
  Beta 0.1.10 sends an unknown peer one schema-v1 compatibility payload plus
  one schema-v3 Callable Passport. Receipt of schema 1, 2, or 3 passively
  records the peer's best known capability; later syncs send exactly that one
  schema. Coarse observation is never projected into a new outgoing Passport.
- Beta 0.1.11 reuses Application Envelope v1 for strict `teti.task.request` and
  `teti.task.receipt` objects. Task version support is advertised passively by
  presence and receipt. Unknown peers receive compatibility-floor v1 so an
  offline current peer does not require a synchronous negotiation round trip;
  known incompatible peers fail before send.
- Beta 0.1.12 keeps Application Envelope v1 and adds Task protocol v2 multipart
  input plus typed attachment, status, cancel and Artifact objects. Image bytes
  use the official Chatmail file field and are verified before approval. The
  receiver must issue one local single-use Execution Grant; receipt alone never
  starts an Agent. Current Codex and CodeBuddy Adapters return bounded text
  Artifacts. Image result Artifacts remain deferred.
