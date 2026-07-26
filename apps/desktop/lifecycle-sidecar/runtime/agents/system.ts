import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type {
  AgentObserverSystem,
  AgentVersionProbe,
  AppBundleInspection,
  ResolvedExecutable
} from "./types.ts";

const PROCESS_LIST_TIMEOUT_MS = 1_500;
const PROCESS_LIST_MAX_BYTES = 512 * 1024;
const PLUTIL_TIMEOUT_MS = 1_000;
const PLUTIL_MAX_BYTES = 8 * 1024;

export class AgentObserverSystemError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentObserverSystemError";
    this.code = code;
  }
}

export function createMacAgentObserverSystem(
  env: NodeJS.ProcessEnv = process.env
): AgentObserverSystem {
  return {
    findExecutable: (names) => findExecutable(names, env),
    findExecutablePath,
    inspectAppBundle,
    listProcessNames,
    runVersionProbe
  };
}

async function findExecutablePath(
  paths: readonly string[],
  expectedNames: readonly string[]
): Promise<ResolvedExecutable | null> {
  const acceptedNames = new Set(expectedNames);
  for (const configuredPath of paths) {
    const candidate = expandHome(configuredPath);
    if (!acceptedNames.has(basename(candidate))) continue;
    try {
      await access(candidate, constants.X_OK);
      const canonicalPath = await realpath(candidate);
      if (!acceptedNames.has(basename(canonicalPath))) continue;
      if ((await stat(canonicalPath)).isFile()) return { canonicalPath };
    } catch {
      // A missing, unreadable, or renamed explicit path is a normal negative signal.
    }
  }
  return null;
}

async function findExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<ResolvedExecutable | null> {
  const searchPaths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const directory of searchPaths) {
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        const canonicalPath = await realpath(candidate);
        if ((await stat(canonicalPath)).isFile()) return { canonicalPath };
      } catch {
        // One missing, unreadable, or broken PATH entry is a normal negative signal.
      }
    }
  }
  return null;
}

async function inspectAppBundle(
  paths: readonly string[],
  bundleIdentifiers: readonly string[],
  readVersion: boolean
): Promise<AppBundleInspection> {
  for (const configuredPath of paths) {
    const appPath = expandHome(configuredPath);
    try {
      if (!(await stat(appPath)).isDirectory()) continue;
    } catch {
      continue;
    }

    const plistPath = join(appPath, "Contents", "Info.plist");
    if (bundleIdentifiers.length > 0) {
      const identifier = await readPlistValue(plistPath, "CFBundleIdentifier");
      if (!identifier || !bundleIdentifiers.includes(identifier)) continue;
    }
    const version = readVersion
      ? sanitizeVersion(await readPlistValue(plistPath, "CFBundleShortVersionString"))
      : null;
    return {
      present: true,
      ...(version ? { version } : {})
    };
  }
  return { present: false };
}

async function listProcessNames(): Promise<string[]> {
  const stdout = await execFileText("/bin/ps", ["-axo", "comm="], {
    timeoutMs: PROCESS_LIST_TIMEOUT_MS,
    maxOutputBytes: PROCESS_LIST_MAX_BYTES,
    errorCode: "PROCESS_ENUMERATION_FAILED"
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => basename(line.trim()))
    .filter(Boolean);
}

async function runVersionProbe(
  executablePath: string,
  probe: AgentVersionProbe
): Promise<string | null> {
  const stdout = await execFileText(executablePath, probe.args, {
    timeoutMs: probe.timeoutMs,
    maxOutputBytes: probe.maxOutputBytes,
    errorCode: "VERSION_PROBE_FAILED",
    minimalEnvironment: true
  });
  return sanitizeVersion(stdout);
}

async function readPlistValue(plistPath: string, key: string): Promise<string | null> {
  try {
    return (await execFileText("/usr/bin/plutil", ["-extract", key, "raw", plistPath], {
      timeoutMs: PLUTIL_TIMEOUT_MS,
      maxOutputBytes: PLUTIL_MAX_BYTES,
      errorCode: "APP_METADATA_READ_FAILED"
    })).trim() || null;
  } catch {
    return null;
  }
}

interface ExecTextOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  errorCode: string;
  minimalEnvironment?: boolean;
}

function execFileText(
  executable: string,
  args: readonly string[],
  options: ExecTextOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: options.minimalEnvironment
        ? {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C"
          }
        : undefined
    }, (error, stdout) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const code = readErrorCode(error);
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(new AgentObserverSystemError("VERSION_OUTPUT_LIMIT"));
        return;
      }
      if ("killed" in error && error.killed) {
        reject(new AgentObserverSystemError(
          options.errorCode === "VERSION_PROBE_FAILED" ? "VERSION_PROBE_TIMEOUT" : options.errorCode
        ));
        return;
      }
      reject(new AgentObserverSystemError(options.errorCode));
    });
  });
}

function sanitizeVersion(value: string | null): string | null {
  if (!value) return null;
  const line = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((candidate) => candidate.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
    .find(Boolean);
  if (!line || line.length > 160 || !/\d/.test(line)) return null;
  if (/[\\/@]/.test(line)) return null;
  if (/\b(?:token|cookie|credential|password|api[_ -]?key)\b/i.test(line)) return null;
  return line;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}
