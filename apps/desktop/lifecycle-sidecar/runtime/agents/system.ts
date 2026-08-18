import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, join, win32 } from "node:path";
import type { LifecycleDesktopPlatform } from "../../desktop-platform.ts";
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
  return createAgentObserverSystem("macos", env);
}

export function createAgentObserverSystem(
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv = process.env
): AgentObserverSystem {
  return {
    findExecutable: (names) => findExecutable(names, env, platform),
    findExecutablePath: (paths, expectedNames) =>
      findExecutablePath(paths, expectedNames, platform, env),
    inspectAppBundle: platform === "macos"
      ? inspectAppBundle
      : async () => ({ present: false }),
    listProcessNames: () => listProcessNames(platform, env),
    runVersionProbe: (path, probe) => runVersionProbe(path, probe, platform, env)
  };
}

async function findExecutablePath(
  paths: readonly string[],
  expectedNames: readonly string[],
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv
): Promise<ResolvedExecutable | null> {
  const acceptedNames = new Set(expectedNames.map((name) => normalizedExecutableName(name, platform)));
  for (const configuredPath of paths) {
    const candidate = expandConfiguredPath(configuredPath, platform, env);
    if (!candidate || !acceptedNames.has(normalizedExecutableName(basename(candidate), platform))) continue;
    try {
      await access(candidate, platform === "windows" ? constants.F_OK : constants.X_OK);
      const canonicalPath = await realpath(candidate);
      if (!acceptedNames.has(normalizedExecutableName(basename(canonicalPath), platform))) continue;
      if ((await stat(canonicalPath)).isFile()) return { canonicalPath };
    } catch {
      // A missing, unreadable, or renamed explicit path is a normal negative signal.
    }
  }
  return null;
}

async function findExecutable(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: LifecycleDesktopPlatform
): Promise<ResolvedExecutable | null> {
  const searchPaths = (env.PATH ?? "").split(platform === "windows" ? ";" : delimiter).filter(Boolean);
  for (const name of names) {
    for (const directory of searchPaths) {
      for (const fileName of executableFileNames(name, platform, env)) {
        const candidate = platform === "windows"
          ? win32.join(directory, fileName)
          : join(directory, fileName);
        try {
          await access(candidate, platform === "windows" ? constants.F_OK : constants.X_OK);
          const canonicalPath = await realpath(candidate);
          if ((await stat(canonicalPath)).isFile()) return { canonicalPath };
        } catch {
          // One missing, unreadable, or broken PATH entry is a normal negative signal.
        }
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

async function listProcessNames(
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const executable = platform === "windows"
    ? windowsSystemExecutable(env, "tasklist.exe")
    : "/bin/ps";
  const args = platform === "windows" ? ["/FO", "CSV", "/NH"] : ["-axo", "comm="];
  const stdout = await execFileText(executable, args, {
    timeoutMs: PROCESS_LIST_TIMEOUT_MS,
    maxOutputBytes: PROCESS_LIST_MAX_BYTES,
    errorCode: "PROCESS_ENUMERATION_FAILED"
  });
  if (platform === "windows") return parseWindowsTasklist(stdout);
  return stdout
    .split(/\r?\n/)
    .map((line) => basename(line.trim()))
    .filter(Boolean);
}

async function runVersionProbe(
  executablePath: string,
  probe: AgentVersionProbe,
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  if (platform === "windows" && [".cmd", ".bat"].includes(extname(executablePath).toLowerCase())) {
    return null;
  }
  const stdout = await execFileText(executablePath, probe.args, {
    timeoutMs: probe.timeoutMs,
    maxOutputBytes: probe.maxOutputBytes,
    errorCode: "VERSION_PROBE_FAILED",
    minimalEnvironment: true,
    environment: env,
    platform
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
  environment?: NodeJS.ProcessEnv;
  platform?: LifecycleDesktopPlatform;
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
        ? minimalProbeEnvironment(
            options.environment ?? process.env,
            options.platform ?? (process.platform === "win32" ? "windows" : "macos")
          )
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

function expandConfiguredPath(
  value: string,
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv
): string | null {
  if (platform === "macos") return expandHome(value);
  let unresolved = false;
  const expanded = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => {
    const replacement = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    if (!replacement) unresolved = true;
    return replacement ?? "";
  });
  return unresolved ? null : expanded;
}

function executableFileNames(
  name: string,
  platform: LifecycleDesktopPlatform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform !== "windows" || extname(name)) return [name];
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^\.[a-z0-9]{1,8}$/.test(value));
  return [...new Set(extensions.map((extension) => `${name}${extension}`))];
}

function normalizedExecutableName(
  name: string,
  platform: LifecycleDesktopPlatform
): string {
  const lower = platform === "windows" ? name.toLowerCase() : name;
  return platform === "windows" ? lower.replace(/\.(?:exe|cmd|bat)$/i, "") : lower;
}

export function parseWindowsTasklist(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"((?:[^"]|"")*)"(?:,|$)/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.replaceAll('""', '"').trim();
    if (name) names.push(name.replace(/\.exe$/i, ""));
  }
  return names;
}

function windowsSystemExecutable(env: NodeJS.ProcessEnv, name: string): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  if (!/^[A-Za-z]:\\[^\u0000-\u001f]+$/.test(systemRoot)) {
    throw new AgentObserverSystemError("PROCESS_ENUMERATION_FAILED");
  }
  return win32.join(systemRoot, "System32", name);
}

function minimalProbeEnvironment(
  env: NodeJS.ProcessEnv,
  platform: LifecycleDesktopPlatform
): NodeJS.ProcessEnv {
  if (platform === "windows") {
    return Object.fromEntries([
      "SystemRoot",
      "SYSTEMROOT",
      "ComSpec",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "TEMP",
      "TMP",
      "PATH",
      "PATHEXT",
      "CODEX_HOME"
    ].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));
  }
  return {
    HOME: env.HOME ?? homedir(),
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {})
  };
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}
