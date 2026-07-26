import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import type {
  AgentAdapterReadiness
} from "../../../core/callability/types.ts";
import type {
  CallableAdapter,
  CallableAdapterLaunchContext
} from "../../../core/callability/adapter.ts";
import {
  classifyCodexFailure,
  decodeCodexArtifact
} from "./jsonl.ts";

export const CODEX_CALLABLE_ADAPTER = {
  adapterId: "openai.codex.exec",
  agentId: "codex",
  adapterRevision: 2,
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

export interface CodexCallableAdapterOptions {
  entrypoint: string;
  codexHome?: string;
}

export interface CodexAdapterQualification {
  readiness: AgentAdapterReadiness;
  adapter: CodexCallableAdapter | null;
}

export interface QualifyCodexAdapterOptions {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  signal?: AbortSignal;
  now?: () => Date;
  resolveEntrypoint?: () => Promise<string | null>;
  probeLogin?: (entrypoint: string) => Promise<"ready" | "needs_login" | "degraded">;
}

export class CodexCallableAdapter implements CallableAdapter {
  readonly descriptor = {
    contractVersion: 2 as const,
    adapterId: CODEX_CALLABLE_ADAPTER.adapterId,
    adapterRevision: CODEX_CALLABLE_ADAPTER.adapterRevision,
    agentId: CODEX_CALLABLE_ADAPTER.agentId,
    capabilityIds: [...CODEX_CALLABLE_ADAPTER.capabilityIds],
    inputModes: ["text", "image"] as const,
    outputModes: ["text"] as const,
    timeoutMs: CODEX_CALLABLE_ADAPTER.timeoutMs,
    cancelGraceMs: CODEX_CALLABLE_ADAPTER.cancelGraceMs,
    maxOutputBytes: CODEX_CALLABLE_ADAPTER.maxOutputBytes
  };
  readonly entrypoint: string;
  private readonly codexHome: string | undefined;

  constructor(options: CodexCallableAdapterOptions) {
    this.entrypoint = options.entrypoint;
    this.codexHome = options.codexHome;
  }

  createLaunchSpec(context: Readonly<CallableAdapterLaunchContext>) {
    return {
      executable: this.entrypoint,
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

export async function qualifyCodexCallableAdapter(
  options: QualifyCodexAdapterOptions = {}
): Promise<CodexAdapterQualification> {
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const entrypoint = await (options.resolveEntrypoint?.() ?? resolveCodexEntrypoint({
    pathOverride: options.pathOverride,
    environment,
    homeDirectory
  }));
  const checkedAt = now().toISOString();
  if (options.signal?.aborted) {
    return {
      readiness: readiness("degraded", checkedAt, "CODEX_QUALIFICATION_ABORTED"),
      adapter: null
    };
  }
  if (!entrypoint) {
    return {
      readiness: readiness("not_detected", checkedAt, "CODEX_EXECUTABLE_NOT_FOUND"),
      adapter: null
    };
  }

  const loginState = await (options.probeLogin?.(entrypoint)
    ?? probeCodexLogin(entrypoint, {
      environment,
      homeDirectory,
      signal: options.signal
    }));
  if (loginState !== "ready") {
    return {
      readiness: readiness(
        loginState,
        checkedAt,
        loginState === "needs_login" ? "CODEX_LOGIN_REQUIRED" : "CODEX_LOGIN_PROBE_FAILED"
      ),
      adapter: null
    };
  }

  return {
    readiness: readiness("ready", checkedAt),
    adapter: new CodexCallableAdapter({
      entrypoint,
      ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {})
    })
  };
}

export async function resolveCodexEntrypoint(options: {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): Promise<string | null> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredOverride = options.pathOverride?.trim();
  const candidates = configuredOverride
    ? [configuredOverride]
    : codexEntrypointCandidates(environment, homeDirectory);

  for (const candidate of candidates) {
    if (basename(candidate) !== "codex") continue;
    try {
      await access(candidate, constants.X_OK);
      const canonicalPath = await realpath(candidate);
      if ((await stat(canonicalPath)).isFile()) return canonicalPath;
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
  } = {}
): Promise<"ready" | "needs_login" | "degraded"> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  return new Promise((resolve) => {
    execFile(entrypoint, ["login", "status"], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 2_000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
      signal: options.signal,
      env: {
        HOME: homeDirectory,
        PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        ...(environment.CODEX_HOME ? { CODEX_HOME: environment.CODEX_HOME } : {})
      }
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

function codexEntrypointCandidates(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): string[] {
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

function readiness(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode?: string
): AgentAdapterReadiness {
  return {
    schemaVersion: 1,
    agentId: CODEX_CALLABLE_ADAPTER.agentId,
    adapterId: CODEX_CALLABLE_ADAPTER.adapterId,
    adapterRevision: CODEX_CALLABLE_ADAPTER.adapterRevision,
    state,
    capabilityIds: [...CODEX_CALLABLE_ADAPTER.capabilityIds],
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
