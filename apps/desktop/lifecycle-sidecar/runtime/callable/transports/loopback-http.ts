import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import type { CallableAdapterSafeErrorCode } from "../../../../../../core/callability/adapter.ts";
import type {
  ExecutionExit,
  ExecutionTransportHandle,
  ExecutionSpec,
  ExecutionTransport,
  LoopbackHttpExecutionSpec,
  OsaurusAgentExecutionSpec
} from "../../../../../../core/callability/agent-core.ts";

const MAX_HTTP_ERROR_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const MAX_SSE_CONTENT_BYTES = 512 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;

export interface LoopbackRuntimeIdentityVerifier {
  verifyListener(input: {
    endpoint: string;
    runtimeInstanceId: string;
    listenerPid: number;
    codeIdentityHash: string;
  }): Promise<void>;
  verifyConnectedSocket(input: {
    endpoint: string;
    runtimeInstanceId: string;
    listenerPid: number;
    codeIdentityHash: string;
    clientPort: number;
    serverPort: number;
  }): Promise<void>;
}

export class LoopbackRuntimeIdentityError extends Error {
  constructor() {
    super("Loopback Runtime identity verification failed.");
    this.name = "LoopbackRuntimeIdentityError";
  }
}

export interface LoopbackHttpTransportOptions {
  identityVerifier: LoopbackRuntimeIdentityVerifier;
  userAgent?: string;
}

export interface OsaurusAgentAuthorityVerifier {
  verifyAgentAuthority(input: {
    agentId: string;
    agentConfigurationDigest: string;
  }): Promise<void>;
}

/**
 * HTTP backend for an already-running, locally qualified Runtime facade.
 * It never starts a service, follows a redirect, reads a Workspace, supplies
 * tools/agent identity, or reuses a socket across executions.
 */
export class LoopbackHttpTransport implements ExecutionTransport {
  readonly kind = "loopback_http" as const;
  private readonly identityVerifier: LoopbackRuntimeIdentityVerifier;
  private readonly userAgent: string;

  constructor(options: LoopbackHttpTransportOptions) {
    this.identityVerifier = options.identityVerifier;
    this.userAgent = options.userAgent ?? "Teti/0.3.8";
  }

  start(input: { spec: ExecutionSpec; workspacePath: string | null }): ExecutionTransportHandle {
    if (input.spec.kind !== this.kind) {
      throw new Error("LoopbackHttpTransport received a non-HTTP execution specification.");
    }
    if (input.workspacePath !== null) {
      throw new Error("LoopbackHttpTransport refuses Host Workspace access.");
    }
    return new ManagedLoopbackHttpExecution(
      input.spec,
      this.identityVerifier,
      this.userAgent
    );
  }
}

export class OsaurusAgentTransport implements ExecutionTransport {
  readonly kind = "osaurus_agent" as const;
  private readonly identityVerifier: LoopbackRuntimeIdentityVerifier;
  private readonly authorityVerifier: OsaurusAgentAuthorityVerifier;
  private readonly userAgent: string;

  constructor(options: LoopbackHttpTransportOptions & {
    authorityVerifier: OsaurusAgentAuthorityVerifier;
  }) {
    this.identityVerifier = options.identityVerifier;
    this.authorityVerifier = options.authorityVerifier;
    this.userAgent = options.userAgent ?? "Teti/0.3.8";
  }

  start(input: { spec: ExecutionSpec; workspacePath: string | null }): ExecutionTransportHandle {
    if (input.spec.kind !== this.kind) {
      throw new Error("OsaurusAgentTransport received a non-Agent execution specification.");
    }
    if (input.workspacePath !== null) {
      throw new Error("OsaurusAgentTransport refuses direct Host Workspace access.");
    }
    return new ManagedLoopbackHttpExecution(
      input.spec,
      this.identityVerifier,
      this.userAgent,
      this.authorityVerifier
    );
  }
}

class ManagedLoopbackHttpExecution implements ExecutionTransportHandle {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly completion: Promise<ExecutionExit>;
  private readonly spec: LoopbackHttpExecutionSpec | OsaurusAgentExecutionSpec;
  private readonly identityVerifier: LoopbackRuntimeIdentityVerifier;
  private readonly userAgent: string;
  private readonly authorityVerifier?: OsaurusAgentAuthorityVerifier;
  private resolveCompletion!: (exit: ExecutionExit) => void;
  private request: ClientRequest | null = null;
  private response: IncomingMessage | null = null;
  private socket: Socket | null = null;
  private started = false;
  private settled = false;
  private terminated = false;

  constructor(
    spec: LoopbackHttpExecutionSpec | OsaurusAgentExecutionSpec,
    identityVerifier: LoopbackRuntimeIdentityVerifier,
    userAgent: string,
    authorityVerifier?: OsaurusAgentAuthorityVerifier
  ) {
    this.spec = spec;
    this.identityVerifier = identityVerifier;
    this.userAgent = userAgent;
    this.authorityVerifier = authorityVerifier;
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  writeInput(text: string): Promise<void> {
    if (this.started || this.settled) return Promise.resolve();
    this.started = true;
    void this.performRequest(text).catch((error) => {
      if (this.terminated || this.settled) return;
      this.fail(error instanceof LoopbackTransportFailure
        ? error.code
        : error instanceof LoopbackRuntimeIdentityError
          ? "ADAPTER_RUNTIME_UNTRUSTED"
          : "ADAPTER_RUNTIME_UNAVAILABLE");
    });
    return Promise.resolve();
  }

  async terminate(_graceMs: number): Promise<void> {
    if (this.settled) return;
    this.terminated = true;
    this.request?.destroy();
    this.response?.destroy();
    this.socket?.destroy();
    this.finish({ code: null, signal: "SIGTERM" });
    await this.completion;
  }

  forceKill(): void {
    if (this.settled) return;
    this.terminated = true;
    this.request?.destroy();
    this.response?.destroy();
    this.socket?.destroy();
    this.finish({ code: null, signal: "SIGKILL" });
  }

  private async performRequest(text: string): Promise<void> {
    if (this.spec.kind === "osaurus_agent") {
      if (!this.authorityVerifier) throw new LoopbackRuntimeIdentityError();
      await this.authorityVerifier.verifyAgentAuthority({
        agentId: this.spec.agentId,
        agentConfigurationDigest: this.spec.agentConfigurationDigest
      });
    }
    await this.identityVerifier.verifyListener(identityInput(this.spec));
    if (this.terminated) return;

    const endpoint = new URL(this.spec.endpoint);
    const serverPort = Number(endpoint.port);
    const nativeAgent = this.spec.kind === "osaurus_agent";
    const model = nativeAgent ? this.spec.effectiveModel : this.spec.model;
    const body = Buffer.from(JSON.stringify(nativeAgent ? {
      messages: [{ role: "user", content: text }],
      stream: true
    } : {
      model,
      messages: [{ role: "user", content: text }],
      stream: true,
      tools: []
    }), "utf8");

    await new Promise<void>((resolve, reject) => {
      if (this.terminated) {
        resolve();
        return;
      }
      let sent = false;
      const client = request({
        protocol: "http:",
        hostname: "127.0.0.1",
        port: serverPort,
        path: nativeAgent
          ? `/agents/${encodeURIComponent(this.spec.agentId)}/run`
          : "/v1/chat/completions",
        method: "POST",
        agent: false,
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "close",
          "Content-Type": "application/json",
          "Content-Length": String(body.byteLength),
          "User-Agent": this.userAgent,
          "X-Persist": "false",
          "Idempotency-Key": this.spec.requestId
        }
      });
      this.request = client;
      client.setTimeout(CONNECT_TIMEOUT_MS, () => {
        client.destroy(new LoopbackTransportFailure("ADAPTER_RUNTIME_UNAVAILABLE"));
      });
      client.once("socket", (socket) => {
        this.socket = socket;
        const verifyAndSend = async () => {
          if (this.terminated || sent) return;
          const clientPort = socket.localPort;
          if (!clientPort
            || socket.remoteAddress !== "127.0.0.1"
            || socket.remotePort !== serverPort) {
            throw new LoopbackRuntimeIdentityError();
          }
          await this.identityVerifier.verifyConnectedSocket({
            ...identityInput(this.spec),
            clientPort,
            serverPort
          });
          if (this.terminated || sent) return;
          client.setTimeout(0);
          sent = true;
          client.end(body);
        };
        if (socket.connecting) {
          socket.once("connect", () => { void verifyAndSend().catch(rejectAndDestroy); });
        } else {
          void verifyAndSend().catch(rejectAndDestroy);
        }
      });
      client.once("response", (response) => {
        this.response = response;
        void this.consumeResponse(response).then(resolve, reject);
      });
      client.once("error", (error) => {
        if (this.terminated) resolve();
        else reject(error);
      });

      const rejectAndDestroy = (error: unknown) => {
        client.destroy(error instanceof Error ? error : new LoopbackRuntimeIdentityError());
        reject(error);
      };
    });
  }

  private async consumeResponse(response: IncomingMessage): Promise<void> {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      response.resume();
      throw new LoopbackTransportFailure("ADAPTER_RUNTIME_UNTRUSTED");
    }
    if (status !== 200) {
      const body = await readBoundedResponse(response, MAX_HTTP_ERROR_BYTES);
      throw new LoopbackTransportFailure(classifyOsaurusHttpFailure(status, body));
    }
    const contentType = response.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("text/event-stream")) {
      response.resume();
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }

    const decoder = new OpenAiChatSseDecoder(
      this.spec.kind === "osaurus_agent" ? this.spec.effectiveModel : this.spec.model
    );
    await new Promise<void>((resolve, reject) => {
      response.on("data", (chunk: Buffer | string) => {
        try {
          decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      response.once("end", () => {
        try {
          const content = decoder.finish();
          if (!this.terminated) this.stdout.write(content, "utf8");
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      response.once("aborted", () => {
        if (this.terminated) resolve();
        else reject(new LoopbackTransportFailure("ADAPTER_STREAM_INVALID"));
      });
      response.once("error", (error) => {
        if (this.terminated) resolve();
        else reject(error);
      });
    });
    if (!this.terminated) this.finish({ code: 0, signal: null });
  }

  private fail(code: CallableAdapterSafeErrorCode): void {
    if (this.settled) return;
    this.stdout.write(encodeLoopbackFailure(code), "utf8");
    this.finish({ code: 1, signal: null });
  }

  private finish(exit: ExecutionExit): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveCompletion(exit);
  }
}

function identityInput(spec: LoopbackHttpExecutionSpec | OsaurusAgentExecutionSpec) {
  return {
    endpoint: spec.endpoint,
    runtimeInstanceId: spec.runtimeInstanceId,
    listenerPid: spec.listenerPid,
    codeIdentityHash: spec.codeIdentityHash
  };
}

class LoopbackTransportFailure extends Error {
  readonly code: CallableAdapterSafeErrorCode;

  constructor(code: CallableAdapterSafeErrorCode) {
    super(code);
    this.name = "LoopbackTransportFailure";
    this.code = code;
  }
}

class OpenAiChatSseDecoder {
  private readonly model: string;
  private readonly content: string[] = [];
  private buffer = "";
  private finishedReason = false;
  private done = false;
  private contentBytes = 0;

  constructor(model: string) {
    this.model = model;
  }

  push(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    this.drain(false);
  }

  finish(): string {
    this.drain(true);
    if (this.buffer.trim() || !this.done || !this.finishedReason || this.contentBytes === 0) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    return this.content.join("");
  }

  private drain(final: boolean): void {
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const event = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.consumeEvent(event);
    }
    if (final && this.buffer) {
      const event = this.buffer;
      this.buffer = "";
      if (event.trim()) this.consumeEvent(event);
    }
  }

  private consumeEvent(event: string): void {
    if (this.done) throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    const lines = event.split("\n").filter((line) => !line.startsWith(":"));
    if (lines.length === 0) return;
    if (lines.length !== 1 || !lines[0].startsWith("data:")) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    const data = lines[0].slice(5).trimStart();
    if (data === "[DONE]") {
      if (!this.finishedReason) throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
      this.done = true;
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    const root = record(value);
    if (root?.error !== undefined) {
      throw new LoopbackTransportFailure(classifyOpenAiError(root.error, 200));
    }
    if (!root
      || root.object !== "chat.completion.chunk"
      || root.model !== this.model
      || !Array.isArray(root.choices)
      || root.choices.length !== 1) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    const choice = record(root.choices[0]);
    const delta = record(choice?.delta);
    if (!choice || choice.index !== 0 || !delta) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    if ("tool_calls" in delta || "function_call" in delta) {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    if (delta.role !== undefined && delta.role !== "assistant") {
      throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
    }
    if (delta.content !== undefined) {
      if (typeof delta.content !== "string") {
        throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
      }
      this.contentBytes += Buffer.byteLength(delta.content, "utf8");
      if (this.contentBytes > MAX_SSE_CONTENT_BYTES) {
        throw new LoopbackTransportFailure("ADAPTER_OUTPUT_LIMIT");
      }
      this.content.push(delta.content);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (choice.finish_reason !== "stop" && choice.finish_reason !== "length") {
        throw new LoopbackTransportFailure("ADAPTER_STREAM_INVALID");
      }
      this.finishedReason = true;
    }
  }
}

function classifyOsaurusHttpFailure(status: number, body: string): CallableAdapterSafeErrorCode {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
  }
  const root = record(value);
  if (root?.error !== undefined) return classifyOpenAiError(root.error, status);
  if (status === 503) return "ADAPTER_RUNTIME_BUSY";
  if (status >= 500) return "ADAPTER_MODEL_LOAD_FAILED";
  return "ADAPTER_UPSTREAM_FAILED";
}

function classifyOpenAiError(error: unknown, status: number): CallableAdapterSafeErrorCode {
  const root = record(error);
  const type = typeof root?.type === "string" ? root.type.toLowerCase() : "";
  const message = typeof root?.message === "string" ? root.message.toLowerCase() : "";
  if (type === "insufficient_resources" || /(?:out of memory|not enough memory|insufficient memory)/.test(message)) {
    return "ADAPTER_INSUFFICIENT_MEMORY";
  }
  if (type === "server_overloaded" || status === 503) return "ADAPTER_RUNTIME_BUSY";
  if (type === "invalid_request_error" && /model.*(?:not found|unknown|unavailable)/.test(message)) {
    return "ADAPTER_MODEL_UNAVAILABLE";
  }
  if (type === "internal_error" || status >= 500) return "ADAPTER_MODEL_LOAD_FAILED";
  return status === 200 ? "ADAPTER_STREAM_INVALID" : "ADAPTER_UPSTREAM_FAILED";
}

function readBoundedResponse(response: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        response.destroy();
        reject(new LoopbackTransportFailure("ADAPTER_UPSTREAM_FAILED"));
        return;
      }
      chunks.push(buffer);
    });
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function encodeLoopbackFailure(code: CallableAdapterSafeErrorCode): string {
  return JSON.stringify({ schemaVersion: 1, tetiLoopbackFailure: code });
}

export function decodeLoopbackFailure(stdout: string): CallableAdapterSafeErrorCode | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = record(value);
  const code = root?.schemaVersion === 1 ? root.tetiLoopbackFailure : null;
  return typeof code === "string" && /^ADAPTER_[A-Z0-9_]{1,56}$/.test(code)
    ? code as CallableAdapterSafeErrorCode
    : null;
}
