import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, win32 } from "node:path";
import { execFile } from "node:child_process";
import type {
  AgentAdapterReadiness
} from "../../../core/callability/types.ts";
import type {
  AgentConnector,
  AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import {
  classifyCodexFailure,
  decodeCodexArtifact
} from "./jsonl.ts";
import { isSafeAbsoluteLocalPath } from "../../../core/application/local-path.ts";

export type CodexHostPlatform = "macos" | "windows";

export const CODEX_CONNECTOR = {
  connectorId: "openai.codex.exec",
  childAgentId: "codex",
  connectorRevision: 3,
  capabilityIds: ["code-analysis"],
  timeoutMs: 5 * 60 * 1_000,
  cancelGraceMs: 500,
  maxOutputBytes: 512 * 1024
} as const;

export const CODEX_CONTROLLED_EXEC_ARGS = Object.freeze([
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
  "--color",
  "never",
  "-c",
  'approval_policy="never"',
  "-c",
  'web_search="disabled"',
  "--disable",
  "apps",
  "--disable",
  "hooks",
  "--disable",
  "multi_agent",
  "--disable",
  "remote_plugin",
  "--disable",
  "shell_snapshot",
  "--disable",
  "shell_tool",
  "--disable",
  "unified_exec"
]);

export interface CodexConnectorOptions {
  entrypoint: string;
  codexHome?: string;
}

export interface CodexConnectorQualification {
  readiness: AgentAdapterReadiness;
  connector: CodexConnector | null;
}

export interface QualifyCodexConnectorOptions {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  signal?: AbortSignal;
  now?: () => Date;
  resolveEntrypoint?: () => Promise<string | null>;
  probeLogin?: (entrypoint: string) => Promise<"ready" | "needs_login" | "degraded">;
  platform?: CodexHostPlatform;
}

export class CodexConnector implements AgentConnector {
  readonly descriptor = {
    contractVersion: 2 as const,
    connectorId: CODEX_CONNECTOR.connectorId,
    connectorRevision: CODEX_CONNECTOR.connectorRevision,
    childAgentId: CODEX_CONNECTOR.childAgentId,
    capabilityIds: [...CODEX_CONNECTOR.capabilityIds],
    inputModes: ["text", "image"] as const,
    outputModes: ["text"] as const,
    transportKind: "process" as const,
    executionCapabilities: {
      supportsProgress: false,
      supportsPause: false,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsCancel: true
    },
    executionSemantics: "external_side_effects_possible" as const,
    timeoutMs: CODEX_CONNECTOR.timeoutMs,
    cancelGraceMs: CODEX_CONNECTOR.cancelGraceMs,
    maxOutputBytes: CODEX_CONNECTOR.maxOutputBytes
  };
  readonly resourceBinding = {
    schemaVersion: 1 as const,
    bindingId: "codex.process.code-analysis",
    childAgentId: CODEX_CONNECTOR.childAgentId,
    connectorId: CODEX_CONNECTOR.connectorId,
    transportKind: "process" as const,
    capabilityIds: [...CODEX_CONNECTOR.capabilityIds]
  };
  readonly fixedProcessEntrypoint: string;
  private readonly codexHome: string | undefined;

  constructor(options: CodexConnectorOptions) {
    this.fixedProcessEntrypoint = options.entrypoint;
    this.codexHome = options.codexHome;
  }

  createExecutionSpec(context: Readonly<AgentConnectorContext>) {
    return {
      kind: "process" as const,
      executable: this.fixedProcessEntrypoint,
      args: [
        ...CODEX_CONTROLLED_EXEC_ARGS,
        ...(context.images ?? []).flatMap((image) => ["--image", image.path]),
        "--",
        "-"
      ],
      environment: {
        NO_COLOR: "1",
        TERM: "dumb",
        ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {})
      }
    };
  }

  decodeArtifact(stdout: string): string {
    return decodeCodexArtifact(stdout);
  }

  classifyFailure(stdout: string) {
    return classifyCodexFailure(stdout);
  }
}

export async function qualifyCodexConnector(
  options: QualifyCodexConnectorOptions = {}
): Promise<CodexConnectorQualification> {
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? (process.platform === "win32" ? "windows" : "macos");
  const entrypoint = await (options.resolveEntrypoint?.() ?? resolveCodexEntrypoint({
    pathOverride: options.pathOverride,
    environment,
    homeDirectory,
    platform
  }));
  const checkedAt = now().toISOString();
  if (options.signal?.aborted) {
    return {
      readiness: readiness("degraded", checkedAt, "CODEX_QUALIFICATION_ABORTED"),
      connector: null
    };
  }
  if (!entrypoint) {
    return {
      readiness: readiness("not_detected", checkedAt, "CODEX_EXECUTABLE_NOT_FOUND"),
      connector: null
    };
  }

  const loginState = await (options.probeLogin?.(entrypoint)
    ?? probeCodexLogin(entrypoint, {
      environment,
      homeDirectory,
      signal: options.signal,
      platform
    }));
  if (loginState !== "ready") {
    return {
      readiness: readiness(
        loginState,
        checkedAt,
        loginState === "needs_login" ? "CODEX_LOGIN_REQUIRED" : "CODEX_LOGIN_PROBE_FAILED"
      ),
      connector: null
    };
  }

  return {
    readiness: readiness("ready", checkedAt),
    connector: new CodexConnector({
      entrypoint,
      ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {})
    })
  };
}

export async function resolveCodexEntrypoint(options: {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: CodexHostPlatform;
} = {}): Promise<string | null> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? (process.platform === "win32" ? "windows" : "macos");
  const configuredOverride = options.pathOverride?.trim();
  const candidates = configuredOverride
    ? [configuredOverride]
    : codexEntrypointCandidates(environment, homeDirectory, platform);

  for (const candidate of candidates) {
    if (!isSafeAbsoluteLocalPath(candidate, platform)) continue;
    const name = basenameForPlatform(candidate, platform).toLowerCase();
    if (platform === "windows" ? name !== "codex.exe" : name !== "codex") continue;
    try {
      await access(candidate, platform === "windows" ? constants.F_OK : constants.X_OK);
      const canonicalPath = await realpath(candidate);
      const canonicalName = basenameForPlatform(canonicalPath, platform).toLowerCase();
      if ((platform === "windows" ? canonicalName === "codex.exe" : canonicalName === "codex")
        && (await stat(canonicalPath)).isFile()) return canonicalPath;
    } catch {
      // One missing or non-executable candidate is a normal negative signal.
    }
  }
  return null;
}

export async function probeCodexLogin(
  entrypoint: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    platform?: CodexHostPlatform;
  } = {}
): Promise<"ready" | "needs_login" | "degraded"> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? (process.platform === "win32" ? "windows" : "macos");
  return new Promise((resolve) => {
    execFile(entrypoint, ["login", "status"], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 2_000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
      signal: options.signal,
      env: codexProbeEnvironment(environment, homeDirectory, platform)
    }, (error) => {
      if (!error) {
        resolve("ready");
        return;
      }
      if ("killed" in error && error.killed) {
        resolve("degraded");
        return;
      }
      resolve(readExitCode(error) === 1 ? "needs_login" : "degraded");
    });
  });
}

export function codexEntrypointCandidates(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  platform: CodexHostPlatform
): string[] {
  if (platform === "windows") {
    const pathCandidates = (environment.PATH ?? "")
      .split(";")
      .filter(Boolean)
      .map((directory) => win32.join(directory, "codex.exe"));
    const localAppData = environment.LOCALAPPDATA;
    return [...new Set([
      ...pathCandidates,
      win32.join(homeDirectory, ".local", "bin", "codex.exe"),
      ...(localAppData
        ? [
            win32.join(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
            win32.join(localAppData, "Programs", "OpenAI", "ChatGPT", "resources", "codex.exe")
          ]
        : [])
    ])];
  }
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "codex"));
  return [...new Set([
    ...pathCandidates,
    join(homeDirectory, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex")
  ])];
}

function basenameForPlatform(value: string, platform: CodexHostPlatform): string {
  return platform === "windows" ? win32.basename(value) : basename(value);
}

function codexProbeEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  platform: CodexHostPlatform
): NodeJS.ProcessEnv {
  if (platform === "windows") {
    return {
      USERPROFILE: environment.USERPROFILE ?? homeDirectory,
      HOME: homeDirectory,
      ...copyEnvironmentKeys(environment, [
        "SystemRoot", "SYSTEMROOT", "ComSpec", "LOCALAPPDATA", "APPDATA",
        "TEMP", "TMP", "PATH", "PATHEXT", "CODEX_HOME"
      ])
    };
  }
  return {
    HOME: homeDirectory,
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...(environment.CODEX_HOME ? { CODEX_HOME: environment.CODEX_HOME } : {})
  };
}

function copyEnvironmentKeys(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[]
): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap((key) =>
    environment[key] === undefined ? [] : [[key, environment[key]!]]
  ));
}

function readiness(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode?: string
): AgentAdapterReadiness {
  return {
    schemaVersion: 1,
    agentId: CODEX_CONNECTOR.childAgentId,
    adapterId: CODEX_CONNECTOR.connectorId,
    adapterRevision: CODEX_CONNECTOR.connectorRevision,
    state,
    capabilityIds: [...CODEX_CONNECTOR.capabilityIds],
    inputModes: ["text", "image"],
    outputModes: ["text"],
    checkedAt,
    ...(reasonCode ? { reasonCode } : {})
  };
}

function readExitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "number"
    ? error.code
    : undefined;
}
