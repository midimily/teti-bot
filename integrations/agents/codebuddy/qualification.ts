import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type {
  CallableAdapter,
  CallableAdapterLaunchContext
} from "../../../core/callability/adapter.ts";
import type { AgentAdapterReadiness } from "../../../core/callability/types.ts";
import {
  classifyCodeBuddyFailure,
  decodeCodeBuddyArtifact,
  parseCodeBuddyJsonl
} from "./jsonl.ts";

export const CODEBUDDY_CALLABLE_ADAPTER = {
  adapterId: "tencent.codebuddy.code",
  agentId: "codebuddy",
  adapterRevision: 1,
  capabilityIds: ["code-analysis"],
  timeoutMs: 5 * 60 * 1_000,
  cancelGraceMs: 500,
  maxOutputBytes: 512 * 1024
} as const;

export const CODEBUDDY_CN_BUNDLE_IDENTIFIER = "com.tencent.codebuddycn";

const CODEBUDDY_CODE_COMMAND_NAMES = new Set(["codebuddy", "cbc"]);
const CODEBUDDY_CN_APP_PATHS = [
  "/Applications/CodeBuddy CN.app",
  "~/Applications/CodeBuddy CN.app"
] as const;
const CODEBUDDY_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const CODEBUDDY_LOCKED_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  allowUntrustedFrontmatterHooks: false
});

export const CODEBUDDY_CONTROLLED_HEADLESS_ARGS = Object.freeze([
  "-p",
  "--input-format",
  "text",
  "--output-format",
  "stream-json",
  "--tools",
  "",
  "--disallowedTools",
  "*",
  "--permission-mode",
  "dontAsk",
  "--subagent-permission-mode",
  "dontAsk",
  "--strict-mcp-config",
  "--mcp-config",
  CODEBUDDY_EMPTY_MCP_CONFIG,
  "--setting-sources",
  "",
  "--settings",
  CODEBUDDY_LOCKED_SETTINGS,
  "--no-session-persistence",
  "--max-turns",
  "1"
]);

export const CODEBUDDY_CONTROLLED_ENVIRONMENT = Object.freeze({
  NO_COLOR: "1",
  TERM: "dumb",
  CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
  CODEBUDDY_DISABLE_BACKGROUND_TASKS: "1",
  CODEBUDDY_DISABLE_CRON: "1",
  CODEBUDDY_DISABLE_FORK_SUBAGENT: "1",
  CODEBUDDY_DISABLE_SHELL_SNAPSHOT: "1",
  CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1",
  CODEBUDDY_AUTO_UPDATE_THIRD_PARTY_MARKETPLACES: "0",
  CODEBUDDY_CODE_DISABLE_TERMINAL_TITLE: "1",
  CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
  CODEBUDDY_WAIT_FOR_MCP_SERVERS_ENABLED: "0"
});

const CODEBUDDY_LOGIN_PROBE_ARGS = Object.freeze([
  ...CODEBUDDY_CONTROLLED_HEADLESS_ARGS.slice(0, -1),
  "0"
]);
const LOGIN_PROBE_INPUT = "TETI_LOGIN_PROBE";
const LOGIN_PROBE_TIMEOUT_MS = 5_000;
const LOGIN_PROBE_MAX_BYTES = 256 * 1024;
const PLIST_PROBE_TIMEOUT_MS = 1_000;
const PLIST_PROBE_MAX_BYTES = 8 * 1024;

export interface CodeBuddyAdapterQualification {
  readiness: AgentAdapterReadiness;
  adapter: CodeBuddyCallableAdapter | null;
  evidence: {
    desktopDetected: boolean;
    officialCliDetected: boolean;
  };
}

export interface QualifyCodeBuddyAdapterOptions {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  signal?: AbortSignal;
  now?: () => Date;
  resolveCliEntrypoint?: () => Promise<string | null>;
  detectDesktop?: () => Promise<boolean>;
  probeLogin?: (
    entrypoint: string
  ) => Promise<"ready" | "needs_login" | "degraded">;
}

export class CodeBuddyCallableAdapter implements CallableAdapter {
  readonly descriptor = {
    contractVersion: 1 as const,
    adapterId: CODEBUDDY_CALLABLE_ADAPTER.adapterId,
    adapterRevision: CODEBUDDY_CALLABLE_ADAPTER.adapterRevision,
    agentId: CODEBUDDY_CALLABLE_ADAPTER.agentId,
    capabilityIds: [...CODEBUDDY_CALLABLE_ADAPTER.capabilityIds],
    inputMode: "text" as const,
    outputMode: "text" as const,
    timeoutMs: CODEBUDDY_CALLABLE_ADAPTER.timeoutMs,
    cancelGraceMs: CODEBUDDY_CALLABLE_ADAPTER.cancelGraceMs,
    maxOutputBytes: CODEBUDDY_CALLABLE_ADAPTER.maxOutputBytes
  };
  readonly entrypoint: string;

  constructor(entrypoint: string) {
    this.entrypoint = entrypoint;
  }

  createLaunchSpec(_context: Readonly<CallableAdapterLaunchContext>) {
    return {
      executable: this.entrypoint,
      args: [...CODEBUDDY_CONTROLLED_HEADLESS_ARGS],
      environment: { ...CODEBUDDY_CONTROLLED_ENVIRONMENT }
    };
  }

  decodeArtifact(stdout: string): string {
    return decodeCodeBuddyArtifact(stdout);
  }

  classifyFailure(stdout: string) {
    return classifyCodeBuddyFailure(stdout);
  }
}

/**
 * Qualifies only the separately installed official CodeBuddy Code CLI. The
 * CodeBuddy CN Electron app and its `buddycn` editor launcher remain
 * observation evidence and can never register this Adapter.
 */
export async function qualifyCodeBuddyCallableAdapter(
  options: QualifyCodeBuddyAdapterOptions = {}
): Promise<CodeBuddyAdapterQualification> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const [cliEntrypoint, desktopDetected] = await Promise.all([
    options.resolveCliEntrypoint?.() ?? resolveCodeBuddyCodeEntrypoint({
      pathOverride: options.pathOverride,
      environment,
      homeDirectory
    }),
    options.detectDesktop?.() ?? detectCodeBuddyCnDesktop({ homeDirectory })
  ]);
  const officialCliDetected = Boolean(cliEntrypoint);
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();

  if (options.signal?.aborted) {
    return qualificationResult(
      "degraded",
      checkedAt,
      "CODEBUDDY_QUALIFICATION_ABORTED",
      desktopDetected,
      officialCliDetected,
      null
    );
  }

  if (!cliEntrypoint) {
    return qualificationResult(
      desktopDetected ? "detected" : "not_detected",
      checkedAt,
      desktopDetected ? "CODEBUDDY_CODE_CLI_NOT_INSTALLED" : "CODEBUDDY_NOT_DETECTED",
      desktopDetected,
      false,
      null
    );
  }

  const loginState = await (options.probeLogin?.(cliEntrypoint)
    ?? probeCodeBuddyLogin(cliEntrypoint, {
      environment,
      homeDirectory,
      signal: options.signal
    }));
  if (loginState !== "ready") {
    return qualificationResult(
      loginState,
      checkedAt,
      loginState === "needs_login"
        ? "CODEBUDDY_LOGIN_REQUIRED"
        : "CODEBUDDY_LOGIN_PROBE_FAILED",
      desktopDetected,
      officialCliDetected,
      null
    );
  }

  return qualificationResult(
    "ready",
    checkedAt,
    undefined,
    desktopDetected,
    officialCliDetected,
    new CodeBuddyCallableAdapter(cliEntrypoint)
  );
}

export async function resolveCodeBuddyCodeEntrypoint(options: {
  pathOverride?: string | null;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): Promise<string | null> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredOverride = options.pathOverride?.trim();
  const candidates = configuredOverride
    ? [configuredOverride]
    : codeBuddyCodeCandidates(environment, homeDirectory);

  for (const candidate of candidates) {
    if (!CODEBUDDY_CODE_COMMAND_NAMES.has(basename(candidate))) continue;
    try {
      await access(candidate, constants.X_OK);
      const canonicalPath = await realpath(candidate);
      if ((await stat(canonicalPath)).isFile()) return canonicalPath;
    } catch {
      // A missing, unreadable, or non-executable candidate is a normal signal.
    }
  }
  return null;
}

export async function probeCodeBuddyLogin(
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
  const workspace = await mkdtemp(join(tmpdir(), "teti-codebuddy-probe-"));
  try {
    const output = await runBoundedProbe({
      entrypoint,
      args: CODEBUDDY_LOGIN_PROBE_ARGS,
      input: LOGIN_PROBE_INPUT,
      cwd: workspace,
      timeoutMs: options.timeoutMs ?? LOGIN_PROBE_TIMEOUT_MS,
      maxOutputBytes: LOGIN_PROBE_MAX_BYTES,
      signal: options.signal,
      environment: {
        HOME: homeDirectory,
        PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: environment.TMPDIR ?? tmpdir(),
        ...CODEBUDDY_CONTROLLED_ENVIRONMENT
      }
    });
    const summary = parseCodeBuddyJsonl(output);
    if (summary.failureKind === "auth") return "needs_login";
    // `--max-turns 0` intentionally reaches a local terminal sentinel before
    // any model turn. The audited CLI reports zero tokens/cost and the fixed
    // text below only after its local authentication initialization succeeds.
    return summary.terminalState === "failed"
      && summary.failureKind === "upstream"
      && summary.finalMessage === "Max turns (0) exceeded"
      ? "ready"
      : "degraded";
  } catch {
    return "degraded";
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function detectCodeBuddyCnDesktop(options: {
  homeDirectory?: string;
} = {}): Promise<boolean> {
  const homeDirectory = options.homeDirectory ?? homedir();
  for (const configuredPath of CODEBUDDY_CN_APP_PATHS) {
    const appPath = configuredPath.startsWith("~/")
      ? join(homeDirectory, configuredPath.slice(2))
      : configuredPath;
    try {
      if (!(await stat(appPath)).isDirectory()) continue;
      const identifier = await readBundleIdentifier(join(appPath, "Contents", "Info.plist"));
      if (identifier === CODEBUDDY_CN_BUNDLE_IDENTIFIER) return true;
    } catch {
      // Missing or unreadable app metadata is a normal negative signal.
    }
  }
  return false;
}

function codeBuddyCodeCandidates(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): string[] {
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => [...CODEBUDDY_CODE_COMMAND_NAMES]
      .map((name) => join(directory, name)));
  return [...new Set([
    ...pathCandidates,
    join(homeDirectory, ".local", "bin", "codebuddy"),
    join(homeDirectory, ".local", "bin", "cbc"),
    "/opt/homebrew/bin/codebuddy",
    "/opt/homebrew/bin/cbc",
    "/usr/local/bin/codebuddy",
    "/usr/local/bin/cbc"
  ])];
}

function runBoundedProbe(options: {
  entrypoint: string;
  args: readonly string[];
  input: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  environment: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("probe aborted"));
      return;
    }
    const child = spawn(options.entrypoint, [...options.args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("probe timeout"), true), options.timeoutMs);
    const abort = () => finish(new Error("probe aborted"), true);
    options.signal?.addEventListener("abort", abort, { once: true });

    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += value.byteLength;
      if (totalBytes > options.maxOutputBytes) {
        finish(new Error("probe output limit"), true);
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect([], chunk));
    child.once("error", (error) => finish(error, false));
    child.once("close", () => finish(null, false));
    child.stdin.once("error", (error: Error & { code?: string }) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        finish(error, true);
      }
    });
    child.stdin.end(options.input, "utf8");

    function finish(error: Error | null, terminate: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (terminate && child.pid) {
        try {
          process.platform === "win32"
            ? child.kill("SIGKILL")
            : process.kill(-child.pid, "SIGKILL");
        } catch {
          // The child may have exited between the timeout and the signal.
        }
      }
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    }
  });
}

function readBundleIdentifier(plistPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plistPath], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), PLIST_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= PLIST_PROBE_MAX_BYTES) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && bytes <= PLIST_PROBE_MAX_BYTES
        ? Buffer.concat(chunks).toString("utf8").trim() || null
        : null);
    });
  });
}

function qualificationResult(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode: string | undefined,
  desktopDetected: boolean,
  officialCliDetected: boolean,
  adapter: CodeBuddyCallableAdapter | null
): CodeBuddyAdapterQualification {
  return {
    readiness: {
      schemaVersion: 1,
      agentId: CODEBUDDY_CALLABLE_ADAPTER.agentId,
      adapterId: CODEBUDDY_CALLABLE_ADAPTER.adapterId,
      adapterRevision: CODEBUDDY_CALLABLE_ADAPTER.adapterRevision,
      state,
      capabilityIds: [...CODEBUDDY_CALLABLE_ADAPTER.capabilityIds],
      inputModes: ["text"],
      outputModes: ["text"],
      checkedAt,
      ...(reasonCode ? { reasonCode } : {})
    },
    adapter,
    evidence: {
      desktopDetected,
      officialCliDetected
    }
  };
}
