import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CodexImageOutputError,
  persistCodexGeneratedImages
} from "./codex-image-output.ts";
import {
  encodeCodexImageRunnerDiagnostic,
  type CodexImageRunnerStage
} from "./codex-image-diagnostics.ts";
import { isSafeAbsoluteLocalPath } from "../../../../../core/application/local-path.ts";

const MAX_INPUT_BYTES = 24 * 1024;
// imageGeneration.result carries the generated image as a string in addition
// to savedPath. Eight MiB admits Teti's bounded 5 MiB image after base64
// expansion while still failing closed on unexpectedly large protocol lines.
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_RESULTS = 4;
const DEFAULT_COMPLETION_TIMEOUT_MS = 8 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_SERVER_STDERR_TAIL_BYTES = 2_048;

const options = parseArguments(process.argv.slice(2));
const prompt = await readStdin();
const server = spawn(options.codex, [
  "app-server",
  "--stdio",
  "--strict-config",
  "-c", 'approval_policy="never"',
  "-c", 'web_search="disabled"',
  "-c", "mcp_servers={}",
  "--disable", "apps",
  "--disable", "hooks",
  "--disable", "multi_agent",
  "--disable", "remote_plugin",
  "--disable", "shell_snapshot",
  "--disable", "shell_tool",
  "--disable", "unified_exec"
], {
  cwd: options.workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});

let nextRequestId = 1;
const pending = new Map<number, {
  resolve(value: unknown): void;
  reject(error: Error): void;
}>();
const completedItems: ProjectedCompletedItem[] = [];
let hasImageResultSignal = false;
let hasTurnCompletionSignal = false;
let imageReadySignal: (() => void) | undefined;
const imageReady = new Promise<void>((resolve) => { imageReadySignal = resolve; });
let turnCompletion: ((value: unknown) => void) | undefined;
let protocolFailed: ((error: Error) => void) | undefined;
const protocolFailure = new Promise<never>((_resolve, reject) => { protocolFailed = reject; });
let serverExitCode: number | null = null;
let serverStderrTail: Buffer = Buffer.alloc(0);

const lines = createInterface({ input: server.stdout, crlfDelay: Infinity, terminal: false });
lines.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
    protocolFailed?.(runnerError("CODEX_IMAGE_PROTOCOL_LIMIT"));
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    protocolFailed?.(runnerError("CODEX_IMAGE_PROTOCOL_INVALID"));
    return;
  }
  if (!isRecord(message)) return;
  debugProtocol(typeof message.method === "string" ? message.method : `response:${String(message.id ?? "unknown")}`);
  if (typeof message.id === "number" && pending.has(message.id)) {
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (isRecord(message.error)) waiter.reject(runnerError("CODEX_IMAGE_REQUEST_FAILED"));
    else waiter.resolve(message.result);
    return;
  }
  if ((typeof message.id === "number" || typeof message.id === "string")
    && typeof message.method === "string") {
    server.stdin.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32601, message: "Teti image Adapter does not expose interactive methods." }
    })}\n`, "utf8");
    return;
  }
  if (message.method === "item/completed" && isRecord(message.params)) {
    const item = projectCompletedItem(message.params.item);
    if (item) completedItems.push(item);
    if (item?.type === "imageGeneration") {
      debugProtocol(`item:${item.type}:${item.status}:saved=true`);
      hasImageResultSignal = true;
      imageReadySignal?.();
    }
  }
  if (message.method === "turn/completed" && isRecord(message.params)) {
    hasTurnCompletionSignal = true;
    // Retain only the fields needed by the Artifact boundary. In particular,
    // imageGeneration.result is never kept after this line handler returns.
    turnCompletion?.(projectTurn(message.params.turn));
  }
});

let stderrBytes = 0;
server.stderr.on("data", (chunk: Buffer | string) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  stderrBytes += buffer.byteLength;
  serverStderrTail = appendBoundedTail(
    serverStderrTail,
    buffer,
    MAX_SERVER_STDERR_TAIL_BYTES
  );
  if (process.env.TETI_CODEX_IMAGE_DEBUG === "1" && stderrBytes <= MAX_PROTOCOL_LINE_BYTES) {
    process.stderr.write(chunk);
  }
  if (stderrBytes > MAX_PROTOCOL_LINE_BYTES) protocolFailed?.(runnerError("CODEX_IMAGE_STDERR_LIMIT"));
});
server.once("error", () => protocolFailed?.(runnerError("CODEX_IMAGE_SERVER_FAILED")));
server.once("close", (code) => {
  serverExitCode = code;
  const error = runnerError("CODEX_IMAGE_SERVER_EXITED");
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  // imageGeneration.savedPath is the authoritative result candidate. Once
  // observed, Teti can finish stabilizing and validating the local file even
  // if app-server exits before its final turn notification. A clean early exit
  // is still a failure: previously it left Windows requests pending until the
  // outer Adapter timeout.
  if (!hasImageResultSignal && !hasTurnCompletionSignal) protocolFailed?.(error);
});
server.stdin.once("error", () => protocolFailed?.(runnerError("CODEX_IMAGE_SERVER_FAILED")));

const terminate = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);

try {
  await runStage("initialize", () => requestWithTimeout("initialize", {
    clientInfo: { name: "teti-image-connector", title: "Teti", version: "0.5.3" },
    capabilities: { experimentalApi: true }
  }, "CODEX_IMAGE_INITIALIZE_TIMEOUT"));
  notify("initialized", {});
  const thread = await runStage("thread/start", () => requestWithTimeout("thread/start", {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    baseInstructions: [
      "Execute one bounded image editing task for Teti.",
      "You must use the built-in image generation capability and return at least one generated image.",
      "Do not run shell commands, edit source files, browse the web, or access paths beyond the supplied images.",
      "Do not claim completion unless an actual image is generated."
    ].join(" "),
    cwd: options.workspace,
    ephemeral: true,
    runtimeWorkspaceRoots: [options.workspace],
    sandbox: "read-only",
    config: {
      approval_policy: "never",
      web_search: "disabled",
      mcp_servers: {},
      features: {
        image_generation: true,
        apps: false,
        hooks: false,
        multi_agent: false,
        shell_tool: false,
        unified_exec: false
      }
    }
  }, "CODEX_IMAGE_THREAD_START_TIMEOUT"));
  const threadId = readThreadId(thread);
  const completed = new Promise<unknown>((resolve) => { turnCompletion = resolve; });
  await runStage("turn/start", () => requestWithTimeout("turn/start", {
    threadId,
    approvalPolicy: "never",
    cwd: options.workspace,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    runtimeWorkspaceRoots: [options.workspace],
    input: [
      ...options.images.map((path) => ({ type: "localImage", path, detail: "original" })),
      {
        type: "text",
        text: `$imagegen\n${prompt}\nReturn an actual edited/generated image based on the supplied image references.`
      }
    ]
  }, "CODEX_IMAGE_TURN_START_TIMEOUT"));
  const output = await runStage("image-result", async () => {
    const turn = await withTimeout(
      Promise.race<unknown>([
        completed,
        imageReady.then(() => null),
        protocolFailure
      ]),
      completionTimeoutMs(),
      "CODEX_IMAGE_COMPLETION_TIMEOUT"
    );
    const result = collectResult([...completedItems, ...readTurnItems(turn)]);
    const copied = await persistCodexGeneratedImages({
      workspacePath: options.workspace,
      savedPaths: result.savedPaths
    });
    return { result, copied };
  });
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    text: output.result.text || "图片编辑已完成。",
    images: output.copied
  }));
  terminate();
} catch (error) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    error: { code: safeFailureCode(error) }
  }));
  terminate();
  process.exitCode = 2;
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const response = new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8");
  });
  return Promise.race([response, protocolFailure]);
}

function requestWithTimeout(
  method: string,
  params: unknown,
  timeoutCode: string
): Promise<unknown> {
  return withTimeout(request(method, params), requestTimeoutMs(), timeoutCode);
}

function notify(method: string, params: unknown): void {
  server.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");
}

function parseArguments(values: string[]): { codex: string; workspace: string; images: string[] } {
  let codex = "";
  let workspace = "";
  const images: string[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1] ?? "";
    if (name === "--codex") codex = value;
    else if (name === "--workspace") workspace = value;
    else if (name === "--image") images.push(value);
    else throw new Error("CODEX_IMAGE_ARGUMENT_INVALID");
  }
  if (!isSafeAbsoluteLocalPath(codex)
    || !isSafeAbsoluteLocalPath(workspace)
    || images.length > 4
    || images.some((path) => !isSafeAbsoluteLocalPath(path))) {
    throw new Error("CODEX_IMAGE_ARGUMENT_INVALID");
  }
  return { codex, workspace, images };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("CODEX_IMAGE_INPUT_LIMIT");
    chunks.push(buffer);
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim();
  if (!value) throw new Error("CODEX_IMAGE_INPUT_INVALID");
  return value;
}

function readThreadId(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string") {
    throw new Error("CODEX_IMAGE_THREAD_INVALID");
  }
  return value.thread.id;
}

function readTurnItems(value: unknown): ProjectedCompletedItem[] {
  return isRecord(value) && Array.isArray(value.items)
    ? value.items.map(projectCompletedItem).filter(isProjectedCompletedItem)
    : [];
}

function collectResult(items: ProjectedCompletedItem[]): { text: string; savedPaths: string[] } {
  let text = "";
  const savedPaths: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      text = item.text.trim();
    }
    if (item.type === "imageGeneration"
      && typeof item.savedPath === "string"
      && isSafeAbsoluteLocalPath(item.savedPath)) {
      savedPaths.push(item.savedPath);
    }
  }
  const unique = [...new Set(savedPaths)].slice(0, MAX_IMAGE_RESULTS);
  if (unique.length === 0) throw runnerError("CODEX_IMAGE_RESULT_MISSING");
  return { text, savedPaths: unique };
}

type ProjectedCompletedItem =
  | { type: "agentMessage"; text: string }
  | { type: "imageGeneration"; status: string; savedPath: string };

function projectCompletedItem(value: unknown): ProjectedCompletedItem | null {
  if (!isRecord(value)) return null;
  if (value.type === "agentMessage" && typeof value.text === "string") {
    return { type: "agentMessage", text: value.text };
  }
  if (value.type === "imageGeneration"
    && typeof value.status === "string"
    && typeof value.savedPath === "string"
    && isSafeAbsoluteLocalPath(value.savedPath)) {
    return {
      type: "imageGeneration",
      status: value.status,
      savedPath: value.savedPath
    };
  }
  return null;
}

function projectTurn(value: unknown): { items: ProjectedCompletedItem[] } {
  return { items: readTurnItems(value) };
}

function isProjectedCompletedItem(
  value: ProjectedCompletedItem | null
): value is ProjectedCompletedItem {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionTimeoutMs(): number {
  const configured = Number(process.env.TETI_CODEX_IMAGE_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 10_000 && configured <= DEFAULT_COMPLETION_TIMEOUT_MS
    ? configured
    : DEFAULT_COMPLETION_TIMEOUT_MS;
}

function requestTimeoutMs(): number {
  const configured = Number(process.env.TETI_CODEX_IMAGE_REQUEST_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 10 && configured <= DEFAULT_REQUEST_TIMEOUT_MS
    ? configured
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(runnerError(code)), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runStage<T>(stage: CodexImageRunnerStage, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  emitStageDiagnostic(stage, "started", 0);
  try {
    const result = await action();
    emitStageDiagnostic(stage, "completed", Date.now() - startedAt);
    return result;
  } catch (error) {
    emitStageDiagnostic(stage, "failed", Date.now() - startedAt, safeFailureCode(error));
    throw error;
  }
}

function emitStageDiagnostic(
  stage: CodexImageRunnerStage,
  state: "started" | "completed" | "failed",
  elapsedMs: number,
  failureCode?: string
): void {
  const stderrTail = state === "failed" ? decodeServerStderrTail() : "";
  process.stderr.write(`${encodeCodexImageRunnerDiagnostic({
    schemaVersion: 1,
    stage,
    state,
    elapsedMs,
    exitCode: serverExitCode,
    ...(failureCode ? { failureCode } : {}),
    ...(stderrTail ? { stderrTail } : {})
  })}\n`);
}

function appendBoundedTail(current: Buffer, chunk: Buffer, maximumBytes: number): Buffer {
  if (chunk.byteLength >= maximumBytes) return chunk.subarray(chunk.byteLength - maximumBytes);
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= maximumBytes
    ? combined
    : combined.subarray(combined.byteLength - maximumBytes);
}

function decodeServerStderrTail(): string {
  return new TextDecoder("utf-8").decode(serverStderrTail).slice(-2_048);
}

function runnerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function safeFailureCode(error: unknown): string {
  if (error instanceof CodexImageOutputError) return error.code;
  if (isRecord(error) && typeof error.code === "string" && /^CODEX_IMAGE_[A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  return "CODEX_IMAGE_INTERNAL_ERROR";
}

function debugProtocol(event: string): void {
  if (process.env.TETI_CODEX_IMAGE_DEBUG === "1") {
    process.stderr.write(`codex-image-protocol:${event}\n`);
  }
}
