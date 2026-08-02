import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { LoopbackRuntimeIdentityVerifier } from "../../../apps/desktop/lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import { LoopbackRuntimeIdentityError } from "../../../apps/desktop/lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";

export const OSAURUS_BUNDLE_IDENTIFIER = "com.dinoki.osaurus";
export const OSAURUS_DEVELOPER_TEAM_ID = "4W8QF9VR2F";
export const OSAURUS_RUNTIME_CONFIG_MAX_BYTES = 16 * 1024;

const INSTANCE_ID_PATTERN = /^[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12}$/;
const CD_HASH_PATTERN = /^[a-fA-F0-9]{40,64}$/;
const COMMAND_TIMEOUT_MS = 2_000;
const COMMAND_MAX_BYTES = 64 * 1024;

export interface OsaurusRuntimeIdentity {
  instanceId: string;
  endpoint: string;
  listenerPid: number;
  appPath: string;
  executablePath: string;
  bundleIdentifier: typeof OSAURUS_BUNDLE_IDENTIFIER;
  teamIdentifier: typeof OSAURUS_DEVELOPER_TEAM_ID;
  codeDirectoryHash: string;
  codeIdentityHash: string;
  appVersion: string | null;
  observedAt: string;
}

export type OsaurusRuntimeDiscovery =
  | { state: "trusted"; identity: OsaurusRuntimeIdentity }
  | { state: "not_running"; identity: null }
  | {
      state: "untrusted";
      identity: null;
      reasonCode?: OsaurusRuntimeTrustFailureCode;
    };

export type OsaurusRuntimeTrustFailureCode =
  | "OSAURUS_RUNTIME_LISTENER_MISMATCH"
  | "OSAURUS_RUNTIME_EXECUTABLE_UNTRUSTED"
  | "OSAURUS_RUNTIME_APP_PATH_UNTRUSTED"
  | "OSAURUS_RUNTIME_SIGNATURE_INVALID"
  | "OSAURUS_RUNTIME_SIGNATURE_MISMATCH";

class OsaurusRuntimeTrustError extends Error {
  readonly reasonCode: OsaurusRuntimeTrustFailureCode;

  constructor(reasonCode: OsaurusRuntimeTrustFailureCode) {
    super(reasonCode);
    this.name = "OsaurusRuntimeTrustError";
    this.reasonCode = reasonCode;
  }
}

export interface OsaurusRuntimeIdentitySystem {
  listenerPids(port: number): Promise<number[]>;
  establishedServerPids(serverPort: number, clientPort: number): Promise<number[]>;
  executablePath(pid: number): Promise<string>;
  verifySignature(appPath: string): Promise<{
    bundleIdentifier: string;
    teamIdentifier: string;
    codeDirectoryHash: string;
  }>;
  readBundleValue(appPath: string, key: string): Promise<string | null>;
}

export interface OsaurusRuntimeIdentityVerifierOptions {
  runtimeRoot?: string;
  homeDirectory?: string;
  now?: () => Date;
  system?: OsaurusRuntimeIdentitySystem;
}

interface OsaurusRuntimeConfiguration {
  instanceId: string;
  updatedAt: string;
  port: number;
  endpoint: string;
}

/**
 * Binds an Osaurus shared configuration entry to the actual TCP listener, the
 * accepted connection, and the signed app bundle that owns their PID.
 */
export class OsaurusRuntimeIdentityVerifier implements LoopbackRuntimeIdentityVerifier {
  private readonly runtimeRoot: string;
  private readonly homeDirectory: string;
  private readonly now: () => Date;
  private readonly system: OsaurusRuntimeIdentitySystem;

  constructor(options: OsaurusRuntimeIdentityVerifierOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.runtimeRoot = options.runtimeRoot
      ?? join(this.homeDirectory, ".osaurus", "runtime");
    this.now = options.now ?? (() => new Date());
    this.system = options.system ?? createMacOsaurusRuntimeIdentitySystem();
  }

  async discoverLatestTrustedRuntime(): Promise<OsaurusRuntimeIdentity | null> {
    return (await this.discoverRuntime()).identity;
  }

  async discoverRuntime(): Promise<OsaurusRuntimeDiscovery> {
    const configurations = await this.readConfigurations();
    if (configurations.length === 0) return { state: "not_running", identity: null };
    let reasonCode: OsaurusRuntimeTrustFailureCode | undefined;
    for (const configuration of configurations) {
      try {
        return { state: "trusted", identity: await this.inspectListener(configuration) };
      } catch (error) {
        reasonCode ??= runtimeTrustFailureCode(error);
        // A stale or spoofed instance must not hide a later valid instance.
      }
    }
    return {
      state: "untrusted",
      identity: null,
      ...(reasonCode ? { reasonCode } : {})
    };
  }

  async verifyListener(input: {
    endpoint: string;
    runtimeInstanceId: string;
    listenerPid: number;
    codeIdentityHash: string;
  }): Promise<void> {
    try {
      const configuration = await this.readConfiguration(input.runtimeInstanceId);
      if (!configuration || configuration.endpoint !== input.endpoint) throw new Error("config");
      const identity = await this.inspectListener(configuration);
      if (identity.listenerPid !== input.listenerPid
        || identity.codeIdentityHash !== input.codeIdentityHash) {
        throw new Error("identity");
      }
    } catch {
      throw new LoopbackRuntimeIdentityError();
    }
  }

  async verifyConnectedSocket(input: {
    endpoint: string;
    runtimeInstanceId: string;
    listenerPid: number;
    codeIdentityHash: string;
    clientPort: number;
    serverPort: number;
  }): Promise<void> {
    try {
      const configuration = await this.readConfiguration(input.runtimeInstanceId);
      if (!configuration
        || configuration.endpoint !== input.endpoint
        || configuration.port !== input.serverPort) {
        throw new Error("config");
      }
      const establishedPids = await this.system.establishedServerPids(
        input.serverPort,
        input.clientPort
      );
      if (establishedPids.length !== 1 || establishedPids[0] !== input.listenerPid) {
        throw new Error("socket-owner");
      }
      const identity = await this.inspectProcess(configuration, input.listenerPid);
      if (identity.codeIdentityHash !== input.codeIdentityHash) throw new Error("signature");
    } catch {
      throw new LoopbackRuntimeIdentityError();
    }
  }

  private async inspectListener(
    configuration: OsaurusRuntimeConfiguration
  ): Promise<OsaurusRuntimeIdentity> {
    const pids = [...new Set(await this.system.listenerPids(configuration.port))];
    if (pids.length !== 1) throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_LISTENER_MISMATCH");
    return this.inspectProcess(configuration, pids[0]);
  }

  private async inspectProcess(
    configuration: OsaurusRuntimeConfiguration,
    pid: number
  ): Promise<OsaurusRuntimeIdentity> {
    let executablePath: string;
    try {
      executablePath = await realpath(await this.system.executablePath(pid));
    } catch {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_EXECUTABLE_UNTRUSTED");
    }
    if (basename(executablePath).toLowerCase() !== "osaurus") {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_EXECUTABLE_UNTRUSTED");
    }
    const marker = "/osaurus.app/contents/macos/osaurus";
    if (!executablePath.toLowerCase().endsWith(marker)) {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_EXECUTABLE_UNTRUSTED");
    }
    const appPath = executablePath.slice(0, -"/Contents/MacOS/osaurus".length);
    const appParent = dirname(appPath);
    const allowedSystemPath = appParent === await canonicalPathIfPresent("/Applications");
    const allowedUserPath = appParent === await canonicalPathIfPresent(
      join(this.homeDirectory, "Applications")
    );
    if (basename(appPath).toLowerCase() !== "osaurus.app"
      || (!allowedSystemPath && !allowedUserPath)) {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_APP_PATH_UNTRUSTED");
    }
    try {
      if (!(await stat(appPath)).isDirectory()) {
        throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_APP_PATH_UNTRUSTED");
      }
    } catch (error) {
      if (error instanceof OsaurusRuntimeTrustError) throw error;
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_APP_PATH_UNTRUSTED");
    }

    let signature: Awaited<ReturnType<OsaurusRuntimeIdentitySystem["verifySignature"]>>;
    try {
      signature = await this.system.verifySignature(appPath);
    } catch {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_SIGNATURE_INVALID");
    }
    const plistIdentifier = await this.system.readBundleValue(appPath, "CFBundleIdentifier");
    if (signature.bundleIdentifier !== OSAURUS_BUNDLE_IDENTIFIER
      || plistIdentifier !== OSAURUS_BUNDLE_IDENTIFIER
      || signature.teamIdentifier !== OSAURUS_DEVELOPER_TEAM_ID
      || !CD_HASH_PATTERN.test(signature.codeDirectoryHash)) {
      throw new OsaurusRuntimeTrustError("OSAURUS_RUNTIME_SIGNATURE_MISMATCH");
    }
    const appVersion = safeVersion(
      await this.system.readBundleValue(appPath, "CFBundleShortVersionString")
    );
    const codeIdentityHash = `sha256:${createHash("sha256").update(JSON.stringify({
      appPath,
      executablePath,
      bundleIdentifier: signature.bundleIdentifier,
      teamIdentifier: signature.teamIdentifier,
      codeDirectoryHash: signature.codeDirectoryHash.toLowerCase()
    })).digest("hex")}`;
    return {
      instanceId: configuration.instanceId,
      endpoint: configuration.endpoint,
      listenerPid: pid,
      appPath,
      executablePath,
      bundleIdentifier: OSAURUS_BUNDLE_IDENTIFIER,
      teamIdentifier: OSAURUS_DEVELOPER_TEAM_ID,
      codeDirectoryHash: signature.codeDirectoryHash.toLowerCase(),
      codeIdentityHash,
      appVersion,
      observedAt: this.now().toISOString()
    };
  }

  private async readConfigurations(): Promise<OsaurusRuntimeConfiguration[]> {
    let entries;
    try {
      entries = await readdir(this.runtimeRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const configurations = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && INSTANCE_ID_PATTERN.test(entry.name))
      .map((entry) => this.readConfiguration(entry.name))))
      .filter((value): value is OsaurusRuntimeConfiguration => value !== null);
    return configurations.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
  }

  private async readConfiguration(instanceId: string): Promise<OsaurusRuntimeConfiguration | null> {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return null;
    const instancePath = join(this.runtimeRoot, instanceId);
    const configPath = join(instancePath, "configuration.json");
    try {
      const instanceInfo = await lstat(instancePath);
      const configInfo = await lstat(configPath);
      if (!instanceInfo.isDirectory()
        || instanceInfo.isSymbolicLink()
        || !configInfo.isFile()
        || configInfo.isSymbolicLink()
        || configInfo.size <= 0
        || configInfo.size > OSAURUS_RUNTIME_CONFIG_MAX_BYTES) {
        return null;
      }
      const value = record(JSON.parse(await readFile(configPath, "utf8")));
      if (!value
        || value.instanceId !== instanceId
        || value.health !== "running"
        || value.address !== "127.0.0.1"
        || value.exposeToNetwork !== false
        || typeof value.updatedAt !== "string"
        || !Number.isSafeInteger(value.port)
        || value.port < 1_024
        || value.port > 65_535) {
        return null;
      }
      const observedAt = Date.parse(value.updatedAt);
      if (!Number.isFinite(observedAt)
        || observedAt - this.now().getTime() > 30_000) {
        return null;
      }
      const endpoint = `http://127.0.0.1:${value.port}/v1/chat/completions`;
      if (value.url !== `http://127.0.0.1:${value.port}`) return null;
      return { instanceId, updatedAt: value.updatedAt, port: value.port, endpoint };
    } catch {
      return null;
    }
  }
}

function runtimeTrustFailureCode(error: unknown): OsaurusRuntimeTrustFailureCode | undefined {
  return error instanceof OsaurusRuntimeTrustError ? error.reasonCode : undefined;
}

export function createMacOsaurusRuntimeIdentitySystem(): OsaurusRuntimeIdentitySystem {
  return {
    async listenerPids(port) {
      const output = await execText("/usr/sbin/lsof", [
        "-nP",
        `-iTCP@127.0.0.1:${port}`,
        "-sTCP:LISTEN",
        "-Fp"
      ]);
      return parsePids(output.stdout);
    },
    async establishedServerPids(serverPort, clientPort) {
      const output = await execText("/usr/sbin/lsof", [
        "-nP",
        "-iTCP",
        "-sTCP:ESTABLISHED",
        "-Fpn"
      ]);
      return parseEstablishedServerPids(output.stdout, serverPort, clientPort);
    },
    async executablePath(pid) {
      const [processPath, mappedText] = await Promise.all([
        execText("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="]),
        execText("/usr/sbin/lsof", [
          "-nP",
          "-a",
          "-p",
          String(pid),
          "-d",
          "txt",
          "-Fn"
        ])
      ]);
      return selectProcessExecutablePath(processPath.stdout, mappedText.stdout);
    },
    async verifySignature(appPath) {
      await execText("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", appPath]);
      const details = await execText("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
      const text = `${details.stdout}\n${details.stderr}`;
      return {
        bundleIdentifier: readCodeSignField(text, "Identifier"),
        teamIdentifier: readCodeSignField(text, "TeamIdentifier"),
        codeDirectoryHash: readCodeSignField(text, "CDHash")
      };
    },
    async readBundleValue(appPath, key) {
      try {
        const output = await execText("/usr/bin/plutil", [
          "-extract",
          key,
          "raw",
          join(appPath, "Contents", "Info.plist")
        ]);
        return output.stdout.trim() || null;
      } catch {
        return null;
      }
    }
  };
}

export function selectProcessExecutablePath(
  processTableOutput: string,
  mappedTextOutput: string
): string {
  const processPaths = processTableOutput.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (processPaths.length !== 1 || !isAbsolute(processPaths[0])) {
    throw new LoopbackRuntimeIdentityError();
  }
  const mappedPaths = new Set(mappedTextOutput.split(/\r?\n/)
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1)));
  if (!mappedPaths.has(processPaths[0])) throw new LoopbackRuntimeIdentityError();
  return processPaths[0];
}

function parsePids(value: string): number[] {
  return value.split(/\r?\n/)
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function parseEstablishedServerPids(
  value: string,
  serverPort: number,
  clientPort: number
): number[] {
  let pid: number | null = null;
  const matches: number[] = [];
  const expected = `127.0.0.1:${serverPort}->127.0.0.1:${clientPort}`;
  for (const line of value.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line.startsWith("n")) {
      const socketName = line.slice(1);
      if (socketName === expected || socketName === `${expected} (ESTABLISHED)`) {
        matches.push(pid);
      }
    }
  }
  return [...new Set(matches)];
}

function readCodeSignField(value: string, key: string): string {
  const prefix = `${key}=`;
  return value.split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? "";
}

function execText(
  executable: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new LoopbackRuntimeIdentityError());
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function safeVersion(value: string | null): string | null {
  if (!value
    || value.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value)
    || !/\d/.test(value)) {
    return null;
  }
  return value;
}

async function canonicalPathIfPresent(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}
