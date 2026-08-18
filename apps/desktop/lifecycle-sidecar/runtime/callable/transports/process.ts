import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { win32 } from "node:path";
import type {
  ExecutionExit,
  ExecutionTransportHandle,
  ExecutionSpec,
  ExecutionTransport
} from "../../../../../../core/callability/agent-core.ts";

const FORCE_KILL_WAIT_MS = 1_000;

export interface ProcessTransportOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  windowsTreeKiller?: (pid: number, force: boolean) => Promise<void>;
}

export class ProcessTreeTerminationError extends Error {
  readonly code = "PROCESS_TREE_TERMINATION_FAILED";

  constructor() {
    super("PROCESS_TREE_TERMINATION_FAILED");
    this.name = "ProcessTreeTerminationError";
  }
}

export class ProcessTransport implements ExecutionTransport {
  readonly kind = "process" as const;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly windowsTreeKiller: (pid: number, force: boolean) => Promise<void>;

  constructor(options: ProcessTransportOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.windowsTreeKiller = options.windowsTreeKiller
      ?? ((pid, force) => terminateWindowsProcessTree(pid, force, this.environment));
  }

  start(input: {
    spec: ExecutionSpec;
    workspacePath: string | null;
  }): ExecutionTransportHandle {
    if (input.spec.kind !== this.kind) {
      throw new Error("ProcessTransport received a non-process execution specification.");
    }
    if (!input.workspacePath) {
      throw new Error("ProcessTransport requires a Host Workspace Snapshot.");
    }
    const child = spawn(input.spec.executable, input.spec.args, {
      cwd: input.workspacePath,
      detached: this.platform !== "win32",
      env: minimalEnvironment(input.spec.environment, this.platform, this.environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return new ManagedProcessExecution(child, this.platform, this.windowsTreeKiller);
  }
}

class ManagedProcessExecution implements ExecutionTransportHandle {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly completion: Promise<ExecutionExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private running = true;
  private terminationPromise: Promise<void> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly windowsTreeKiller: (pid: number, force: boolean) => Promise<void>;

  constructor(
    child: ChildProcessWithoutNullStreams,
    platform: NodeJS.Platform,
    windowsTreeKiller: (pid: number, force: boolean) => Promise<void>
  ) {
    this.child = child;
    this.platform = platform;
    this.windowsTreeKiller = windowsTreeKiller;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.completion = new Promise<ExecutionExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.running = false;
        resolve({ code, signal });
      });
    });
    void this.completion.catch(() => {
      this.running = false;
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  writeInput(text: string): Promise<void> {
    if (!this.running || this.child.stdin.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onError = (error: Error & { code?: string }) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
          resolve();
          return;
        }
        reject(error);
      };
      this.child.stdin.once("error", onError);
      this.child.stdin.end(text, "utf8", () => {
        this.child.stdin.off("error", onError);
        resolve();
      });
    });
  }

  terminate(graceMs: number): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = this.performTermination(graceMs);
    return this.terminationPromise;
  }

  forceKill(): void {
    if (this.platform === "win32" && this.child.pid) {
      void this.windowsTreeKiller(this.child.pid, true).catch(() => {
        this.child.kill("SIGKILL");
      });
      return;
    }
    this.signalPosixProcessTree("SIGKILL");
  }

  private async performTermination(graceMs: number): Promise<void> {
    if (!this.running) {
      await this.completion.catch(() => undefined);
      return;
    }
    if (this.platform === "win32") {
      const pid = this.child.pid;
      if (!pid) throw new ProcessTreeTerminationError();
      await this.windowsTreeKiller(pid, false).catch(() => undefined);
      if (await settlesWithin(this.completion, graceMs)) return;
      await this.windowsTreeKiller(pid, true).catch(() => {
        throw new ProcessTreeTerminationError();
      });
      if (await settlesWithin(this.completion, FORCE_KILL_WAIT_MS)) return;
      throw new ProcessTreeTerminationError();
    }

    this.signalPosixProcessTree("SIGTERM");
    if (await settlesWithin(this.completion, graceMs)) return;

    this.signalPosixProcessTree("SIGKILL");
    if (await settlesWithin(this.completion, FORCE_KILL_WAIT_MS)) return;
    throw new Error("Child Agent process did not exit after SIGKILL.");
  }

  private signalPosixProcessTree(signal: NodeJS.Signals): void {
    if (!this.running) return;
    const pid = this.child.pid;
    try {
      if (pid) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if (readErrorCode(error) !== "ESRCH") throw error;
    }
  }
}

function minimalEnvironment(
  extra: Record<string, string> | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  if (platform === "win32") {
    return {
      ...copyEnvironmentKeys(environment, [
        "SystemRoot", "SYSTEMROOT", "ComSpec", "USERPROFILE", "HOME",
        "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "PATHEXT"
      ]),
      ...extra
    };
  }
  return {
    HOME: homedir(),
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: environment.TMPDIR ?? tmpdir(),
    ...extra
  };
}

export function windowsTaskkillCommand(
  pid: number,
  force: boolean,
  environment: NodeJS.ProcessEnv = process.env
): { executable: string; args: string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new ProcessTreeTerminationError();
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  if (!/^[A-Za-z]:\\[^\u0000-\u001f]+$/.test(systemRoot)) {
    throw new ProcessTreeTerminationError();
  }
  return {
    executable: win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])]
  };
}

export function terminateWindowsProcessTree(
  pid: number,
  force: boolean,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const command = windowsTaskkillCommand(pid, force, environment);
  return new Promise((resolve, reject) => {
    execFile(command.executable, command.args, {
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 16 * 1024,
      env: copyEnvironmentKeys(environment, ["SystemRoot", "SYSTEMROOT", "ComSpec", "TEMP", "TMP"])
    }, (error) => error ? reject(new ProcessTreeTerminationError()) : resolve());
  });
}

function copyEnvironmentKeys(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[]
): NodeJS.ProcessEnv {
  return Object.fromEntries(keys.flatMap((key) =>
    environment[key] === undefined ? [] : [[key, environment[key]!]]
  ));
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}
