import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcConnection,
  JsonRpcRequest,
  JsonRpcResponse
} from "./rpc-client.ts";
import type { ChatmailRuntimeConfig } from "./runtime-config.ts";

export interface StdioTransportOptions {
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

export class StdioJsonRpcTransport implements JsonRpcConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs?: number;
  private readonly onStderr?: (line: string) => void;
  private readonly pending = new Map<number | string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: StdioTransportOptions = {}
  ) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onStderr = options.onStderr;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(`deltachat-rpc-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`)
      );
    });
  }

  static spawn(
    config: ChatmailRuntimeConfig,
    options: StdioTransportOptions = {}
  ): StdioJsonRpcTransport {
    const child = spawn(config.rpcServerPath, {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        ...config.env,
        DC_ACCOUNTS_PATH: config.accountsPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    return new StdioJsonRpcTransport(child, options);
  }

  async send(payload: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) {
      throw new Error("deltachat-rpc-server transport is closed.");
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (this.requestTimeoutMs && this.requestTimeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pending.delete(payload.id);
          reject(new Error(`JSON-RPC request ${payload.id} timed out.`));
        }, this.requestTimeoutMs);
      }

      this.pending.set(payload.id, pending);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }

        this.pending.delete(payload.id);
        this.clearPendingTimeout(pending);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }

      const forceKill = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, 2000);

      this.child.once("close", () => {
        clearTimeout(forceKill);
        resolve();
      });

      this.child.stdin.end();
      this.child.kill("SIGTERM");
    });

    await this.closePromise;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    this.stdoutBuffer = this.drainLines(this.stdoutBuffer, (line) => {
      if (!line.trim()) {
        return;
      }

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        this.rejectAll(new Error(`Invalid JSON-RPC response from deltachat-rpc-server: ${String(error)}`));
        return;
      }

      if (response.id === undefined || response.id === null) {
        return;
      }

      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }

      this.pending.delete(response.id);
      this.clearPendingTimeout(pending);
      pending.resolve(response);
    });
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    this.stderrBuffer = this.drainLines(this.stderrBuffer, (line) => {
      if (line.trim()) {
        this.onStderr?.(line);
      }
    });
  }

  private drainLines(buffer: string, onLine: (line: string) => void): string {
    let start = 0;
    let newlineIndex = buffer.indexOf("\n", start);

    while (newlineIndex !== -1) {
      onLine(buffer.slice(start, newlineIndex));
      start = newlineIndex + 1;
      newlineIndex = buffer.indexOf("\n", start);
    }

    return buffer.slice(start);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearPendingTimeout(pending);
      pending.reject(error);
    }

    this.pending.clear();
  }

  private clearPendingTimeout(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
  }
}

