import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { JsonRpcClientTransport } from "./rpc-client.ts";
import { resolveChatmailRuntimeConfig, type ChatmailRuntimeConfigInput } from "./runtime-config.ts";
import { StdioJsonRpcTransport } from "./stdio-transport.ts";

const execFileAsync = promisify(execFile);

export interface ChatmailRpcRuntimeDiagnostics {
  requestedPath: string;
  resolvedPath?: string;
  exists: boolean;
  executable: boolean;
  version?: string;
  fileOutput?: string;
  binaryPlatform?: "macos" | "windows" | "unknown";
  architecture?: "arm64" | "x86_64" | "unknown";
  appleSiliconCompatible: boolean;
  targetCompatible: boolean;
  accountsPath: string;
  accountsPathWritable: boolean;
  jsonRpcHealth: boolean;
  systemInfoKeys: string[];
  cleanShutdown: boolean;
  stderrLines: string[];
  errors: string[];
}

export async function inspectChatmailRpcRuntime(
  input: ChatmailRuntimeConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<ChatmailRpcRuntimeDiagnostics> {
  const runtime = resolveChatmailRuntimeConfig(input, env);
  const errors: string[] = [];
  const resolvedPath = await resolveExecutablePath(runtime.rpcServerPath, env);
  const diagnostics: ChatmailRpcRuntimeDiagnostics = {
    requestedPath: runtime.rpcServerPath,
    resolvedPath,
    exists: false,
    executable: false,
    appleSiliconCompatible: false,
    targetCompatible: false,
    accountsPath: runtime.accountsPath,
    accountsPathWritable: false,
    jsonRpcHealth: false,
    systemInfoKeys: [],
    cleanShutdown: false,
    stderrLines: [],
    errors
  };

  if (!resolvedPath) {
    errors.push(`RPC executable was not found: ${runtime.rpcServerPath}`);
    return diagnostics;
  }

  diagnostics.exists = await fileExists(resolvedPath);
  if (!diagnostics.exists) {
    errors.push(`RPC executable was not found: ${resolvedPath}`);
  }
  diagnostics.executable = await canExecute(resolvedPath);
  if (!diagnostics.executable) {
    errors.push(`RPC executable is not executable: ${resolvedPath}`);
  }

  diagnostics.version = await readVersion(resolvedPath, errors);
  const binary = await inspectBinary(resolvedPath, errors);
  diagnostics.fileOutput = binary.description;
  diagnostics.binaryPlatform = binary.platform;
  diagnostics.architecture = binary.architecture;
  diagnostics.appleSiliconCompatible = binary.platform === "macos" && binary.architecture === "arm64";
  diagnostics.targetCompatible = isCurrentTargetCompatible(binary);
  if (binary.platform !== "unknown" && !diagnostics.targetCompatible) {
    errors.push(`RPC executable does not match ${process.platform}/${process.arch}: ${binary.description ?? "unknown"}`);
  }

  diagnostics.accountsPathWritable = await ensureWritableDirectory(runtime.accountsPath, errors);

  if (diagnostics.executable && diagnostics.accountsPathWritable) {
    await runJsonRpcHealth(resolvedPath, runtime.accountsPath, diagnostics, errors);
  }

  return diagnostics;
}

export async function resolveExecutablePath(
  commandPath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (isAbsolute(commandPath)) {
    return commandPath;
  }

  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" && !commandPath.toLowerCase().endsWith(".exe")
    ? [commandPath, `${commandPath}.exe`]
    : [commandPath];
  for (const base of paths) {
    for (const name of names) {
      const candidate = join(base, name);
      if (await canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function runJsonRpcHealth(
  rpcServerPath: string,
  accountsPath: string,
  diagnostics: ChatmailRpcRuntimeDiagnostics,
  errors: string[]
): Promise<void> {
  const transport = StdioJsonRpcTransport.spawn(
    {
      rpcServerPath,
      accountsPath
    },
    {
      requestTimeoutMs: 5000,
      onStderr: (line) => diagnostics.stderrLines.push(line)
    }
  );
  const client = new JsonRpcClientTransport(transport);

  try {
    const systemInfo = await client.request<Record<string, string>>("get_system_info", []);
    diagnostics.systemInfoKeys = Object.keys(systemInfo).sort();
    diagnostics.jsonRpcHealth = diagnostics.systemInfoKeys.length > 0;
  } catch (error) {
    errors.push(`JSON-RPC health failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await transport.close();
    diagnostics.cleanShutdown = true;
  }
}

async function readVersion(path: string, errors: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(path, ["--version"], { timeout: 5000 });
    return String(stdout || stderr).trim();
  } catch (error) {
    errors.push(`Unable to read RPC version: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

interface InspectedBinary {
  platform: "macos" | "windows" | "unknown";
  architecture: "arm64" | "x86_64" | "unknown";
  description?: string;
}

async function inspectBinary(path: string, errors: string[]): Promise<InspectedBinary> {
  const pe = await inspectPortableExecutable(path);
  if (pe) {
    return {
      platform: "windows",
      architecture: pe,
      description: `PE executable (${pe})`
    };
  }

  if (process.platform === "win32") {
    return { platform: "unknown", architecture: "unknown", description: "unknown executable format" };
  }

  try {
    const { stdout } = await execFileAsync("file", [path], { timeout: 5000 });
    const output = String(stdout).trim();
    return {
      platform: /Mach-O/i.test(output) ? "macos" : "unknown",
      architecture: classifyArchitecture(output),
      description: output
    };
  } catch (error) {
    errors.push(`Unable to inspect RPC architecture: ${error instanceof Error ? error.message : String(error)}`);
    return { platform: "unknown", architecture: "unknown" };
  }
}

async function inspectPortableExecutable(path: string): Promise<"x86_64" | "arm64" | "unknown" | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return undefined;
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > bytesRead || header.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
      return undefined;
    }
    const machine = header.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) return "x86_64";
    if (machine === 0xaa64) return "arm64";
    return "unknown";
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function isCurrentTargetCompatible(binary: InspectedBinary): boolean {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return binary.platform === "macos" && binary.architecture === "arm64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return binary.platform === "windows" && binary.architecture === "x86_64";
  }
  return false;
}

function classifyArchitecture(fileOutput: string | undefined): "arm64" | "x86_64" | "unknown" {
  if (!fileOutput) {
    return "unknown";
  }
  if (/\barm64\b/i.test(fileOutput)) {
    return "arm64";
  }
  if (/\bx86_64\b/i.test(fileOutput)) {
    return "x86_64";
  }
  return "unknown";
}

async function ensureWritableDirectory(path: string, errors: string[]): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    const probe = join(path, ".teti-preflight-write-test");
    await writeFile(probe, "ok\n", "utf8");
    await rm(probe, { force: true });
    return true;
  } catch (error) {
    errors.push(`Accounts directory is not writable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const value = await stat(path);
    return value.isFile();
  } catch {
    return false;
  }
}

async function canExecute(path: string): Promise<boolean> {
  try {
    if (process.platform === "win32") return (await stat(path)).isFile();
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
