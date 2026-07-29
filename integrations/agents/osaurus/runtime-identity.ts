import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  | { state: "untrusted"; identity: null };

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
    for (const configuration of configurations) {
      try {
        return { state: "trusted", identity: await this.inspectListener(configuration) };
      } catch {
        // A stale or spoofed instance must not hide a later valid instance.
      }
    }
    return { state: "untrusted", identity: null };
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
    if (pids.length !== 1) throw new LoopbackRuntimeIdentityError();
    return this.inspectProcess(configuration, pids[0]);
  }

  private async inspectProcess(
    configuration: OsaurusRuntimeConfiguration,
    pid: number
  ): Promise<OsaurusRuntimeIdentity> {
    const executablePath = await realpath(await this.system.executablePath(pid));
    if (basename(executablePath) !== "osaurus") throw new LoopbackRuntimeIdentityError();
    const marker = "/Osaurus.app/Contents/MacOS/osaurus";
    if (!executablePath.endsWith(marker)) throw new LoopbackRuntimeIdentityError();
    const appPath = executablePath.slice(0, -"/Contents/MacOS/osaurus".length);
    const allowedSystemPath = appPath === await canonicalPathIfPresent("/Applications/Osaurus.app");
    const allowedUserPath = appPath === await canonicalPathIfPresent(
      join(this.homeDirectory, "Applications", "Osaurus.app")
    );
    if (!allowedSystemPath && !allowedUserPath) throw new LoopbackRuntimeIdentityError();
    if (!(await stat(appPath)).isDirectory()) throw new LoopbackRuntimeIdentityError();

    const signature = await this.system.verifySignature(appPath);
    const plistIdentifier = await this.system.readBundleValue(appPath, "CFBundleIdentifier");
    if (signature.bundleIdentifier !== OSAURUS_BUNDLE_IDENTIFIER
      || plistIdentifier !== OSAURUS_BUNDLE_IDENTIFIER
      || signature.teamIdentifier !== OSAURUS_DEVELOPER_TEAM_ID
      || !CD_HASH_PATTERN.test(signature.codeDirectoryHash)) {
      throw new LoopbackRuntimeIdentityError();
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
      const output = await execText("/usr/sbin/lsof", [
        "-nP",
        "-a",
        "-p",
        String(pid),
        "-d",
        "txt",
        "-Fn"
      ]);
      const paths = output.stdout.split(/\r?\n/)
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1));
      if (paths.length !== 1) throw new LoopbackRuntimeIdentityError();
      return paths[0];
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
