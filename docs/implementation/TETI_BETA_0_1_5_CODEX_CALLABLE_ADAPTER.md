# Teti Beta 0.1.5 Codex Callable Adapter

Status: Implemented
Date: 2026-07-26
Application version: 0.1.5
Adapter ID: `openai.codex.exec`
Adapter revision: 1
Network protocol change: none

## Objective

Beta 0.1.5 qualifies the official local Codex CLI as Teti's first real
Callable Adapter. It proves that Runtime can reuse the user's existing Codex
login, submit an explicit text task non-interactively, observe JSONL lifecycle
events, cancel the process safely, and return one bounded text Artifact.

This version does not let Desktop or another Teti submit a task. It adds no
Lifecycle method, Chatmail message, Passport callable projection, approval UI,
or Execution Grant flow.

## Qualified official surface

The implementation was checked against the current official Codex
non-interactive documentation and the locally installed CLI:

- local version tested: `codex-cli 0.146.0-alpha.3.1`;
- authentication state tested: `Logged in using ChatGPT`;
- official command: `codex exec`;
- saved CLI authentication is reused by default;
- `-` reads the task from stdin;
- `--json` emits newline-delimited JSON lifecycle events;
- `--ephemeral` avoids persisting the task session;
- `--sandbox read-only` selects the least-write sandbox;
- `--ignore-user-config` still preserves Codex authentication while excluding
  local config behavior;
- `--ignore-rules` excludes project/user exec-policy rules.

Teti never reads, parses, copies, logs, stores, or sends `auth.json` or a login
token. Readiness runs only `codex login status` and trusts its exit status, not
its output text.

## Entrypoint qualification

Runtime checks, in order:

1. an explicit local Agent path override, when configured;
2. executable `codex` candidates from `PATH`;
3. `~/.local/bin/codex`;
4. Homebrew and `/usr/local/bin` locations;
5. the Codex binary embedded in `/Applications/ChatGPT.app` or the user's local
   Applications folder.

An explicit override must itself be named `codex`, exist, resolve to a regular
file, and be executable. When an override is present but invalid, qualification
fails closed instead of silently choosing another binary.

The Adapter registers only when both the executable and `codex login status`
are ready. Missing login produces `needs_login`; probe timeout or execution
failure produces `degraded`. The path never enters Runtime snapshots,
Passport, diagnostics, or peer messages.

## Controlled invocation

Every task uses the fixed Adapter entrypoint and these controls:

```text
codex exec
  --json
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --strict-config
  --sandbox read-only
  --skip-git-repo-check
  --color never
  -c approval_policy="never"
  -c web_search="disabled"
  --disable apps
  --disable hooks
  --disable multi_agent
  --disable remote_plugin
  --disable shell_snapshot
  --disable shell_tool
  --disable unified_exec
  -
```

The task text is absent from argv, environment, path, process title, and launch
context. Kernel writes it to UTF-8 stdin after spawning Codex inside a new empty
temporary workspace.

The Adapter does not set a model and does not accept a task-selected model,
provider, URL, executable, argument, environment value, path, or sandbox mode.

## JSONL state and Artifact boundary

The JSONL parser recognizes only the lifecycle information Teti requires:

```text
thread.started -> turn.started -> item.* -> turn.completed
                                      \-> turn.failed / error
```

It retains no thread ID, usage, reasoning, command, file change, tool call,
diagnostic, or intermediate message. Unknown future events are ignored only
while the stream remains within strict event and line limits.

Only the last completed `item.type = agent_message` may become an Artifact. It
must be non-empty UTF-8 text and remain within the frozen 56 KiB Artifact text
limit. The complete stdout/stderr process budget is 512 KiB. Malformed,
incomplete, out-of-order, oversized, failed, or error streams fail closed and
discard all partial output.

## Execution limits

- Capability: `code-analysis` only.
- Input: explicit text, maximum 24 KiB.
- Artifact: final text only, maximum 56 KiB.
- Process JSONL and stderr combined: maximum 512 KiB.
- Timeout: five minutes.
- Normal cancellation grace: 500 ms, then process-group `SIGKILL`.
- Runtime shutdown: immediate process-group `SIGKILL` within the Runtime's
  existing bounded shutdown.
- Session persistence: disabled through `--ephemeral`.
- User and project Codex configuration/rules: ignored.
- Shell, unified exec, Apps, Hooks, subagents, remote plugins, and Web Search:
  disabled.

## Security boundary discovered during qualification

Official Codex guidance states that a read-only sandbox prevents writes but is
not, by itself, a complete secret-reading isolation boundary. Beta 0.1.5
mitigates this by using an empty workspace, ignoring config/rules, and disabling
local execution tools and external tool surfaces.

Nevertheless, 0.1.5 is approved only for an explicit local task initiated by
trusted Teti code. It must not be wired directly to untrusted peer text.

Before the planned remote collaboration milestone, Teti must separately prove:

- no available Codex tool can read arbitrary user files or credential stores;
- task-content policy and local allow-once approval happen before execution;
- execution uses a stronger outer filesystem boundary if tool disabling is not
  sufficient for a future Capability;
- adversarial prompt-injection tests cannot reach local paths, processes,
  credentials, connectors, Hooks, MCP servers, or network tools.

This is a recorded release gate, not a claim that `read-only` alone supplies
`userFileAccess:none`.

## Verification

Automated tests cover:

- fixed non-interactive arguments and stdin-only content delivery;
- missing executable, invalid override, signed-out, degraded, and ready states;
- fake CLI login reuse and complete Kernel execution;
- documented JSONL success events;
- failed/error/malformed/incomplete/out-of-order/oversized streams;
- filtering of command output, reasoning, usage, and thread IDs;
- Artifact and total output limits;
- existing Kernel timeout, cancellation, process-tree cleanup, and isolation.

A real local smoke test executes a minimal no-tools task through the installed
Codex CLI and requires the exact controlled Artifact:

```json
{"ok":true,"adapterId":"openai.codex.exec","adapterRevision":1,"artifact":"TETI_CODEX_ADAPTER_OK"}
```

Run it manually with:

```sh
npm run desktop:codex-adapter:smoke
```

The smoke test contacts the user's configured Codex provider and consumes a
small amount of their local Codex entitlement. It never prints authentication
material or raw JSONL.

## Deferred

- repository, file, image, URL, command, or tool input;
- workspace-write or code modification;
- configurable model, sandbox, timeout, executable, or arguments;
- session resume and conversation persistence;
- streaming JSONL status in Desktop UI;
- callable Passport exposure;
- Chatmail Task transport;
- peer approval, Execution Grant, replay protection, and remote cancellation;
- unattended background execution;
- public A2A endpoint, Agent Card, MCP server, SDK, or third-party Adapter API.
