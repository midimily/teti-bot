import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import type {
  ExecutionExit,
  ExecutionTransportHandle,
  ExecutionSpec,
  ExecutionTransport
} from "../../../../../../core/callability/agent-core.ts";

const FORCE_KILL_WAIT_MS = 1_000;

export class ProcessTransport implements ExecutionTransport {
  readonly kind = "process" as const;

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
      detached: process.platform !== "win32",
      env: minimalEnvironment(input.spec.environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return new ManagedProcessExecution(child);
  }
}

class ManagedProcessExecution implements ExecutionTransportHandle {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly completion: Promise<ExecutionExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private running = true;
  private terminationPromise: Promise<void> | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
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
    this.signalProcessTree("SIGKILL");
  }

  private async performTermination(graceMs: number): Promise<void> {
    if (!this.running) {
      await this.completion.catch(() => undefined);
      return;
    }
    this.signalProcessTree("SIGTERM");
    if (await settlesWithin(this.completion, graceMs)) return;

    this.signalProcessTree("SIGKILL");
    if (await settlesWithin(this.completion, FORCE_KILL_WAIT_MS)) return;
    throw new Error("Child Agent process did not exit after SIGKILL.");
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    if (!this.running) return;
    const pid = this.child.pid;
    try {
      if (pid && process.platform !== "win32") {
        process.kill(-pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch (error) {
      if (readErrorCode(error) !== "ESRCH") throw error;
    }
  }
}

function minimalEnvironment(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...extra
  };
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
