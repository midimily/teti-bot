import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { validateTetiDisplayName } from "../../../core/account/display-name.ts";
import { inspectChatmailRpcRuntime } from "../../../integrations/chatmail/runtime-diagnostics.ts";
import {
  resolveWindowsRuntimePaths,
  verifyWindowsRuntime
} from "./windows-runtime.ts";

interface LifecycleResponse {
  version: 1;
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; diagnosticCode?: string; message?: string };
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The Windows Runtime exit gate must run on a real Windows x64 host.");
  }

  const artifacts = await verifyWindowsRuntime(repoRoot);
  if (!artifacts.ok) throw new Error(`Windows Runtime artifacts failed verification:\n${artifacts.errors.join("\n")}`);
  const paths = resolveWindowsRuntimePaths(repoRoot);
  const profileRoot = readArgument("--profile")
    ?? await mkdtemp(join(tmpdir(), "teti-real-provisioning-windows-"));
  const requestedDisplayName = readArgument("--display-name")
    ?? `TetiWin${Date.now().toString(36).slice(-3)}`;
  const displayNameValidation = validateTetiDisplayName(requestedDisplayName);
  if (!displayNameValidation.ok) {
    throw new Error(
      `--display-name must contain 1-10 Unicode characters (${displayNameValidation.reason}).`
    );
  }
  const displayName = displayNameValidation.value;

  const rpc = await inspectChatmailRpcRuntime({
  rpcServerPath: paths.rpc,
  accountsPath: join(profileRoot, "rpc-health-accounts"),
  workingDirectory: profileRoot
});
if (!rpc.targetCompatible || !rpc.jsonRpcHealth || !rpc.cleanShutdown || rpc.errors.length > 0) {
  throw new Error(`DeltaChat JSON-RPC health failed:\n${rpc.errors.join("\n")}`);
}

  const sidecar = spawn(paths.node, [
  "--experimental-strip-types",
  join(repoRoot, "apps", "desktop", "lifecycle-sidecar", "main.ts")
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    TETI_DESKTOP_PLATFORM: "windows",
    TETI_PROFILE_DIR: profileRoot,
    TETI_PROVISIONING_MODE: "real",
    TETI_ALLOW_REAL_PROVISIONING: "1",
    TETI_PROFILE_SECURITY: "isolated-validation",
    TETI_DELTACHAT_RPC_PATH: paths.rpc
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
  const client = new LifecycleLineClient(sidecar);
  const stderr: string[] = [];
  sidecar.stderr.setEncoding("utf8");
  sidecar.stderr.on("data", (value: string) => {
  stderr.push(...value.split(/\r?\n/).filter(Boolean).slice(-20));
  if (stderr.length > 40) stderr.splice(0, stderr.length - 40);
  });

  try {
  const health = await client.request("lifecycle.health", {});
  assertSuccessful(health, "lifecycle.health");
  const initialLoad = await client.request("account.load", {});
  assertSuccessful(initialLoad, "account.load before create");
  let account = initialLoad.result;
  let created = false;
  if (account === null) {
    const creation = await client.request("account.create", { name: displayName }, 150_000);
    assertSuccessful(creation, "account.create");
    account = creation.result;
    created = true;
  }
  const loaded = await client.request("account.load", {});
  assertSuccessful(loaded, "account.load after create");
  if (!isAccount(account) || !isAccount(loaded.result) || account.id !== loaded.result.id) {
    throw new Error("The isolated Windows Profile did not reload the controlled identity.");
  }

  console.log(JSON.stringify({
    ok: true,
    profileRoot,
    created,
    accountReloaded: true,
    jsonRpcHealth: true,
    rpcVersion: rpc.version,
    runtimeTarget: artifacts.target
  }, null, 2));
  } catch (error) {
  const diagnosticCodes = stderr
    .map((line) => line.match(/\b(?:code|diagnosticCode)=([^ ]+)/)?.[1])
    .filter(Boolean);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}`
      + (diagnosticCodes.length > 0 ? `\nRuntime diagnostics: ${diagnosticCodes.slice(-5).join(", ")}` : "")
  );
  } finally {
    await client.close();
  }
}

class LifecycleLineClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly pending = new Map<string, {
    resolve(value: LifecycleResponse): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let response: LifecycleResponse;
      try {
        response = JSON.parse(line) as LifecycleResponse;
      } catch {
        return;
      }
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
    });
    child.once("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Lifecycle sidecar exited with code ${code ?? "null"}.`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<LifecycleResponse> {
    const id = `windows-exit-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ version: 1, id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 6_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) this.child.kill();
  }
}

function assertSuccessful(response: LifecycleResponse, operation: string): void {
  if (!response.ok) {
    const code = response.error?.diagnosticCode ?? response.error?.code ?? "UNKNOWN";
    throw new Error(`${operation} failed (${code}).`);
  }
}

function isAccount(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value
    && typeof value.id === "string";
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

await main();
