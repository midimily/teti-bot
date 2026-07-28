# Agent Integrations

Provider-specific Agent Connectors and fail-closed qualification modules live
under this boundary. Beta 0.2.1 migrates the already-qualified Codex and
CodeBuddy CLI paths into the Host/Child Agent Core; it adds no new provider.

The frozen reusable contract is defined in `core/callability/agent-core.ts`.
`TetiHostAgentKernel` owns Execution Authority, isolated workspaces, Transport
selection, cancellation, process-tree cleanup, timeout, output limits,
Artifact persistence, and error isolation. A Connector owns only fixed
provider invocation and bounded output decoding.

Qualification is deliberately outside the lifecycle startup critical path.
The sidecar opens its request reader first, then a cancellable background
supervisor qualifies providers in isolation and dynamically registers only the
Connectors that pass. Provider startup latency must never consume the Desktop
`lifecycle.health` budget.

The Codex integration:

- resolves a local executable without copying it into Passport;
- checks `codex login status` and reuses saved CLI authentication without
  reading auth material;
- runs `codex exec` through stdin with JSONL, ephemeral state, a read-only
  sandbox, ignored user config/rules, disabled local tools, and disabled web;
- projects only the final completed `agent_message` into a bounded Artifact.

It has no Desktop, Chatmail, or remote task submission entry in Beta 0.1.5.

The CodeBuddy qualification:

- distinguishes the CodeBuddy CN Electron editor and its `buddycn` editor
  launcher from the separately installed official CodeBuddy Code CLI commands
  `codebuddy` / `cbc`;
- uses only the official Headless process surface; HTTP and ACP are not started;
- performs a zero-token `--max-turns 0` login probe and registers only after the
  expected local terminal sentinel is observed;
- disables built-in tools, Hooks, inherited settings, MCP, session persistence,
  background tasks, Cron, shell snapshots, subagent forks, and marketplaces;
- sends the task only over stdin and projects only the final successful text
  from a strictly bounded stream-JSON result;
- reports `detected`, `needs_login`, or `degraded` without a Connector whenever
  any qualification gate fails.

An integration must not enter this directory as callable merely because its
Agent is installed or running. It must qualify an official, fixed local
entrypoint and pass the Host/Transport safety tests before it may advertise
`ready`.

Beta 0.1.10 connects that qualified registration to Callable Passport. The
public projection deliberately removes the executable, Connector identifier,
Connector revision, Transport kind, installation/version/process evidence,
credentials, prompt,
task content, and Artifact. Only Agent identity, curated capability IDs,
text-mode support, availability, and observation time may cross Chatmail.

Connector implementations must not import Passport, Chatmail, or connection
modules. `AgentConnectorContext` contains only task ID, curated capability,
Host-created workspace, and Host-staged image paths. It never contains task
text, `ExecutionAuthority`, peer identity, or collaboration consent. The Host
delivers task text to the selected Transport over stdin after validation.

Beta 0.2.1 Transport policy:

- `ProcessTransport` is the only production backend and is used by Codex,
  Codex Image, and CodeBuddy;
- `FakeTransport` is deterministic and test-only;
- `LoopbackHttpTransport` reserves the interface but is disabled and performs
  no network request.
