# Teti Beta 0.1.9 CodeBuddy Callable Adapter

Status: Implemented and locally qualified
Date: 2026-07-26
Application version: 0.1.9
Adapter ID: `tencent.codebuddy.code`
Adapter revision: 1
Network protocol change: none

## Outcome

Beta 0.1.9 implements the CodeBuddy Callable Adapter through the official
CodeBuddy Code Headless CLI. It also preserves the strict boundary between the
CodeBuddy CN Electron editor and the separately installed Agent CLI.

Local qualification evidence:

```text
CodeBuddy CN.app version: 4.10.4
CodeBuddy CN bundle ID: com.tencent.codebuddycn
CodeBuddy Code CLI: /opt/homebrew/bin/codebuddy
CodeBuddy Code version: 2.127.0
CLI architecture: arm64
CLI Team ID: FN2V63AD2J
Qualification: ready
Adapter registered: true
```

`buddycn chat` remains an editor-window launcher and is never accepted as an
Adapter. A Mac with only CodeBuddy CN Desktop remains `detected` but
non-callable. A Mac with the CLI but no login reports `needs_login` and also
registers no Adapter.

## Official surface decision

Sources are the current Tencent CodeBuddy developer documentation:

- Headless mode: <https://www.codebuddy.ai/docs/cli/headless>
- CLI reference: <https://www.codebuddy.ai/docs/cli/cli-reference>
- ACP integration: <https://www.codebuddy.ai/docs/cli/acp>
- HTTP API Beta: <https://www.codebuddy.ai/docs/cli/http-api>
- Permission rules: <https://www.codebuddy.ai/docs/cli/permissions>
- Settings and Hook disable switch: <https://www.codebuddy.ai/docs/cli/settings>
- Environment controls: <https://www.codebuddy.ai/docs/cli/env-vars>

| Candidate | Decision | Reason |
| --- | --- | --- |
| `codebuddy -p` / `cbc -p` | Selected | Official process-per-task Headless entry, stdin and stream-JSON |
| `codebuddy --acp` | Deferred | Valid future client surface, but adds session/protocol lifecycle not required by 0.1.9 |
| `codebuddy --serve` | Rejected for 0.1.9 | HTTP API is Beta and introduces a resident port, request authentication, and server ownership |
| CodeBuddy CN `buddycn chat` | Observation only | Opens/reuses editor UI; no bounded Headless task result contract |
| Extension commands/internal RPC | Rejected | Product internals have no public compatibility contract for Teti |

Teti does not create a new protocol. It invokes the official local Headless CLI
and maps its bounded result into the already frozen local Adapter contract.

## Qualification state machine

Runtime resolves only exact `codebuddy` or `cbc` executable names. It never
accepts `buddycn`, a renamed executable, an editor extension command, or an
already-running editor process as callable evidence.

The resulting states are:

- `not_detected / CODEBUDDY_NOT_DETECTED`: neither Desktop nor CLI exists;
- `detected / CODEBUDDY_CODE_CLI_NOT_INSTALLED`: Desktop exists without CLI;
- `needs_login / CODEBUDDY_LOGIN_REQUIRED`: CLI emits its structured
  authentication failure;
- `degraded / CODEBUDDY_LOGIN_PROBE_FAILED`: timeout, malformed output, or an
  incompatible CLI surface;
- `ready`: the zero-token login probe passes and a real Adapter is registered.

CodeBuddy returns process exit code 0 even for an authentication failure.
Qualification therefore never trusts the exit code alone. It parses the final
stream-JSON `result.is_error`, subtype, and bounded safe error classification.

### Zero-token login probe

CodeBuddy has no validated standalone `login status` command. `/status` waits
for an interactive UI and is unsuitable for Runtime startup. Teti instead uses
the normal locked Headless shape with:

```text
input: TETI_LOGIN_PROBE
--max-turns 0
```

On the audited logged-in CLI, initialization reaches the fixed local terminal
sentinel `Max turns (0) exceeded` with zero input tokens, zero output tokens,
zero provider cost, and no model turn. When signed out, the same surface returns
a structured authentication-required result. Any other result is `degraded`.

The probe runs in a new empty temporary directory, has a five-second deadline
and 256 KiB total output cap, deletes its directory, and retains no session ID,
account source, model, usage, path, or output text.

### Startup isolation (0.1.9 P0)

Callable qualification is not part of the Desktop lifecycle bootstrap critical
path. Runtime first opens the lifecycle stdin reader and can answer
`lifecycle.health`; Codex and CodeBuddy qualification then run concurrently
under a cancellable background supervisor. A qualified Adapter is registered
dynamically in the running Kernel. A slow, damaged, signed-out, or incompatible
Agent cannot delay the Desktop first render or suppress another Agent.

Runtime shutdown aborts in-flight qualification probes before the sidecar exits.
The Desktop also renders and expands a bounded startup-error state if lifecycle
bootstrap fails for an unrelated reason, so the transparent native shell cannot
remain as an empty invisible window.

## Controlled task invocation

Every task uses fixed arguments equivalent to:

```text
codebuddy
  -p
  --input-format text
  --output-format stream-json
  --tools ""
  --disallowedTools "*"
  --permission-mode dontAsk
  --subagent-permission-mode dontAsk
  --strict-mcp-config
  --mcp-config '{"mcpServers":{}}'
  --setting-sources ""
  --settings '{"disableAllHooks":true,"allowUntrustedFrontmatterHooks":false}'
  --no-session-persistence
  --max-turns 1
```

It never uses `-y`, `--dangerously-skip-permissions`, `bypassPermissions`,
`--serve`, `--acp`, `--ide`, `--continue`, `--resume`, `--add-dir`, a model
override, a user-selected executable, or a user-selected argument.

The task is absent from argv, environment, path, and process title. Kernel sends
it over UTF-8 stdin inside a new empty temporary workspace. User/project/local
settings sources are excluded. Hooks and untrusted frontmatter Hooks are
disabled. Built-in tools are set to the documented empty allowlist and all
tools are additionally denied. MCP is strict and empty. Sessions are not
persisted.

Environment flags additionally disable automatic memory, background tasks,
Cron, fork subagents, shell snapshots, marketplace loading/update, terminal
title changes, prompt suggestions, and MCP wait behavior.

## Stream-JSON and Artifact boundary

The strict parser accepts only:

- bounded `system` initialization/status events;
- bounded assistant `thinking`, which is discarded;
- bounded assistant `text`, which is a candidate final result;
- one terminal `result` event.

Any tool-use/non-text content, malformed line, unknown event type, missing
terminal result, event after termination, excessive event count, excessive line
size, failed result, or empty/oversized final text fails closed. Authentication
and upstream failures are reduced to stable Teti error codes.

Only the final successful result text enters the 56 KiB Artifact. Session IDs,
request IDs, account source, model, cwd, tool list, slash commands, reasoning,
usage, cost, timestamps, permission details, errors, and intermediate messages
are discarded.

## Runtime limits

- Capability: `code-analysis` only.
- Input: explicit text, maximum 24 KiB.
- Artifact: final text only, maximum 56 KiB.
- Combined stdout/stderr process budget: 512 KiB.
- Timeout: five minutes.
- Cancellation grace: 500 ms, then process-group `SIGKILL`.
- Runtime shutdown: active CodeBuddy process groups are force-reaped.
- Kernel concurrency: existing four-task local maximum.
- HTTP server and ACP server: never started.

## Verification

Automated tests cover missing CLI, missing login, degraded and ready states;
exact executable naming; fixed launch arguments; fake login reuse; stdin-only
delivery; JSONL success/auth/upstream/malformed/tool-use/size cases; Artifact
filtering; complete Kernel execution; dynamic registration after bootstrap;
slow/failing qualification isolation; abort on shutdown; and visible Desktop
startup failure fallback.

Real local checks passed:

```text
normal smoke:
  result = TETI_CODEBUDDY_ADAPTER_OK

security smoke:
  outside sentinel exposed = false
  outside write observed = false

lifecycle smoke:
  two concurrent zero-token initializations = ready
  cancellation = ADAPTER_CANCELED
  forced short timeout = ADAPTER_TIMEOUT
```

Run them explicitly with:

```sh
npm run desktop:codebuddy-adapter:smoke
npm run desktop:codebuddy-adapter:security-smoke
npm run desktop:codebuddy-adapter:lifecycle-smoke
```

The normal and security smoke tests contact the configured CodeBuddy provider
and consume a small amount of the user's entitlement. The login and concurrent
initialization probes use `--max-turns 0` and consumed zero tokens in local
validation.

## Remaining boundary

The tool deny policy and empty workspace passed the explicit sentinel test, but
they are not claimed to be a complete operating-system filesystem sandbox.
CodeBuddy must not be connected directly to untrusted peer text until the
planned local allow-once grant, adversarial prompt policy, and stronger outer
execution boundary are reviewed.

0.1.9 adds no Desktop task UI, Lifecycle task method, Chatmail Task message,
callable Passport projection, remote execution, ACP endpoint, HTTP endpoint, or
account/token sharing. 0.1.6 Claude Code, 0.1.7 Gemini CLI, and 0.1.8 Cursor were
intentionally skipped and remain unimplemented.
