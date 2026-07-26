# Teti Beta 0.1.3 Agent Management

Status: implemented locally

## Outcome

Beta 0.1.3 adds a local Agent management section to Desktop settings and
completes the five-provider coarse discovery milestone. It does not make any
Agent callable and does not change Chatmail, Registry, account, or Passport
network protocols.

The built-in catalog is:

1. Codex
2. Claude Code
3. Gemini CLI
4. Cursor
5. CodeBuddy, including CodeBuddy CN bundle/process evidence

Each detector reports only installation, a sanitized version string, and a
coarse process-running state. A running process does not imply activity,
authentication, task readiness, or callability.

## Desktop behavior

- Runtime discovery begins independently of Teti account creation.
- During the first scan, settings shows a progress message and no built-in
  Agent list.
- The list becomes visible atomically after the first completed scan.
- Later scans retain the previous list and label it as rescanning.
- Settings provides an explicit **重新扫描** action.
- Each built-in Agent provides an optional, local-only path override.
- Coarse observations stay in Agent management. They do not appear in the
  local callable Passport panel; remote compatibility projection remains
  separately governed by the existing Passport sharing implementation.

## Path override boundary

Overrides are stored at:

```text
<Teti profile>/agent-detectors.override.json
```

The file is atomically replaced with mode `0600`. A write refuses malformed or
ambiguous existing configuration rather than deleting it.

An override:

- is accepted only for one of the five built-in IDs;
- must be an absolute path or a `~/` path;
- must preserve the known executable filename or app-bundle name;
- cannot contain traversal segments, commands, arguments, environment, or
  shell syntax;
- uses only the detector's fixed `--version` probe when applicable;
- is returned only by the private local lifecycle bridge;
- is never copied into Observation evidence, Passport, Chatmail, or Registry.

## Private Runtime surface

Desktop consumes three allowlisted lifecycle methods:

- `agent.observation.get`
- `agent.observation.scan`
- `agent.observation.override.set`

These are local Desktop-to-Runtime operations, not a new Teti network protocol.
Rust and TypeScript enforce method-specific timeouts and the existing 64 KiB
request limit.

## Isolation guarantees

- one detector timeout or failure degrades only that Agent;
- process enumeration or configuration errors use safe codes and disclose no
  raw output;
- version probes retain fixed arguments, timeouts, and output limits;
- discovery never reads prompt, source code, files, tokens, credentials,
  account rights, conversation content, cwd, or tool input;
- no Hook, MCP registration, Agent task invocation, or provider account access
  is introduced in 0.1.3.

## Release gate

The milestone is accepted only when TypeScript typecheck, the full repository
test suite, Rust tests, frontend/runtime bundling, and the macOS Tauri App build
all pass at application version `0.1.3`.
