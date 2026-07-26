# Teti Beta 0.1.4 Callable Adapter Kernel

Status: Implemented
Date: 2026-07-26
Application version: 0.1.4
Network protocol change: none
Remote Agent connection: none

## Objective

Beta 0.1.4 establishes the process-local execution safety boundary required by
future Codex, Claude Code, Gemini CLI, Cursor, and CodeBuddy Adapters. It does
not make any of those Agents callable yet.

The implemented path is:

```text
Runtime-local task
  -> registered Callable Adapter
  -> fixed launch specification
  -> isolated temporary workspace
  -> bounded child-process execution
  -> text Artifact or safe terminal error
```

The production Runtime starts an empty Kernel and owns its shutdown. The fake
Agent is test-only and is never bundled as a production Adapter.

## Adapter contract

`core/callability/adapter.ts` freezes contract version 1:

- stable Adapter, Agent, revision, and curated Capability identifiers;
- text input and text output only;
- Adapter-owned timeout, cancellation grace period, and combined output cap;
- a fixed local executable registered with the Adapter, plus a launch
  specification produced from task ID, Capability ID, and an isolated
  workspace path; the Kernel rejects any executable substitution;
- no task text in launch context, argv, environment, path, or process title;
- task text delivered only as UTF-8 stdin;
- bounded argument and environment shapes;
- no caller-selected executable, cwd, arguments, environment, URL, model, or
  credential.

Adapter metadata is separate from Observation. Installed or running status
still does not prove callability.

## Local task state machine

The Kernel reuses the frozen A2A-aligned vocabulary rather than creating a new
network protocol:

```text
submitted -> working -> completed
                     -> failed
                     -> canceled
```

Terminal snapshots are immutable. Only `completed` may contain a text Artifact.
Failed, timed-out, canceled, or shutdown tasks discard partial output and expose
only a stable safe error code.

Timeout is represented as `failed + ADAPTER_TIMEOUT`; it is an execution
failure, not a new wire-level Task state. Runtime shutdown and user cancellation
use `canceled` with distinct local safe codes.

## Process ownership and cleanup

The Node Runtime owns every Adapter process:

1. create a dedicated `teti-agent-task-*` directory under the system temporary
   root;
2. spawn a detached process group with a minimal environment;
3. stream the explicit task text through stdin;
4. count stdout and stderr together against one byte limit;
5. on normal cancel, timeout, or output overflow, send `SIGTERM` to the process
   group;
6. after the Adapter grace period, escalate to `SIGKILL`;
7. on Runtime shutdown, immediately `SIGKILL` the process group so the
   Adapter's grace period cannot exceed the sidecar's bounded shutdown budget;
8. wait for process exit and remove the isolated workspace;
9. retain only bounded, path-free task snapshots in memory.

The process-group rule is important: an Agent wrapper cannot leave its own child
process behind when Teti cancels the task.

Only a minimal environment is inherited (`HOME`, `PATH`, locale, and temporary
directory). Task content and arbitrary parent-process variables are not copied.

## Output and error boundary

- Input uses the existing 24 KiB task-text ceiling.
- Each Adapter selects a validated output ceiling between 1 KiB and 4 MiB.
- stdout and stderr both consume that ceiling.
- Only valid UTF-8 stdout from a successful zero exit becomes an Artifact.
- stderr, executable paths, argv, workspace paths, provider diagnostics, and
  raw exception messages never enter a task snapshot.
- One preparation, launch, exit, or output failure terminates only that task and
  does not stop the Kernel or another Adapter.
- The Kernel limits concurrent work and retained history to prevent unbounded
  local resource growth.

## Fake Agent harness

`apps/desktop/test/fixtures/fake-callable-agent.mjs` provides deterministic
test-only modes:

- echo stdin and complete;
- exit non-zero;
- hang and ignore `SIGTERM`;
- overflow output;
- create a child process tree and ignore graceful termination.

Tests prove:

- text is sent through stdin and absent from Adapter launch context;
- temporary workspaces are removed;
- timeout and explicit cancellation escalate and settle;
- parent and descendant fake-Agent processes are reaped;
- overflow discards partial output;
- a failing Adapter does not affect a healthy concurrent task;
- duplicate IDs, unknown Adapters, and post-shutdown submissions fail closed;
- Runtime shutdown cancels active Kernel work exactly once.

## Runtime integration

`TetiRuntime.stop()` now drains the Runtime Host, closes Chatmail, and shuts down
the Callable Adapter Kernel within the existing bounded Runtime shutdown.

There is deliberately no new Lifecycle method. Consequently Desktop, a peer,
or Chatmail cannot submit or cancel an Adapter task in 0.1.4. Passport and Agent
management behavior remain unchanged.

## Explicitly deferred

- Codex, Claude Code, Gemini CLI, Cursor, or CodeBuddy execution;
- Adapter readiness probes and callable Passport projection;
- user approval and Execution Grant issuance/consumption;
- task persistence or restart recovery;
- Chatmail Task messages and remote collaboration;
- UDS, Hook installation, MCP server work, A2A endpoint, Agent Card, or SDK;
- file/repository access, workspace mutation, binary Artifacts, and unattended
  execution.

## Release gate

Beta 0.1.4 is complete only when contract/state tests, real child-process fake
Agent tests, Runtime lifecycle regression, the full repository suite, Desktop
typecheck, Rust checks, production Tauri build, App metadata version validation,
and bundle signature verification all pass.
