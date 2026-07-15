import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
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
  architecture?: "arm64" | "x86_64" | "unknown";
  appleSiliconCompatible: boolean;
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
  diagnostics.fileOutput = await readFileOutput(resolvedPath, errors);
  diagnostics.architecture = classifyArchitecture(diagnostics.fileOutput);
  diagnostics.appleSiliconCompatible = diagnostics.architecture === "arm64";
  if (!diagnostics.appleSiliconCompatible) {
    errors.push(`RPC executable is not an arm64 Mach-O binary: ${diagnostics.fileOutput ?? "unknown"}`);
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
  for (const base of paths) {
    const candidate = join(base, commandPath);
    if (await canExecute(candidate)) {
      return candidate;
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

async function readFileOutput(path: string, errors: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("file", [path], { timeout: 5000 });
    return String(stdout).trim();
  } catch (error) {
    errors.push(`Unable to inspect RPC architecture: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
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
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
