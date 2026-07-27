import {
  MAX_TASK_ARTIFACT_TEXT_BYTES,
  MAX_TASK_IMAGE_PARTS,
  MAX_TASK_INPUT_TEXT_BYTES,
  type TaskImageMimeType,
  type TaskImagePart
} from "../task/types.ts";
import type { AgentTaskContentMode } from "./types.ts";

export const TETI_CALLABLE_ADAPTER_CONTRACT_VERSION = 2;
export const TETI_CALLABLE_TASK_SCHEMA_VERSION = 2;

export const CALLABLE_ADAPTER_LIMITS = {
  minimumTimeoutMs: 10,
  maximumTimeoutMs: 15 * 60 * 1_000,
  maximumCancelGraceMs: 5_000,
  minimumOutputBytes: 1_024,
  maximumOutputBytes: 4 * 1024 * 1024,
  maximumArgs: 64,
  maximumArgBytes: 2 * 1024,
  maximumEnvironmentEntries: 32,
  maximumEnvironmentValueBytes: 8 * 1024
} as const;

export type CallableAdapterTaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled";

export type CallableAdapterSafeErrorCode =
  | "ADAPTER_PREPARE_FAILED"
  | "ADAPTER_LAUNCH_FAILED"
  | "ADAPTER_EXIT_NONZERO"
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_CANCELED"
  | "ADAPTER_OUTPUT_LIMIT"
  | "ADAPTER_OUTPUT_INVALID"
  | "ADAPTER_AUTH_REQUIRED"
  | "ADAPTER_UPSTREAM_FAILED"
  | "ADAPTER_IMAGE_RESULT_MISSING"
  | "ADAPTER_IMAGE_RESULT_NOT_READY"
  | "ADAPTER_IMAGE_RESULT_INVALID"
  | "ADAPTER_IMAGE_SERVER_EXITED"
  | "ADAPTER_IMAGE_GENERATION_TIMEOUT"
  | "ADAPTER_IMAGE_PROTOCOL_LIMIT"
  | "ADAPTER_RUNTIME_SHUTDOWN"
  | "ADAPTER_INTERNAL_ERROR";

export interface CallableAdapterDescriptor {
  contractVersion: 1 | 2;
  adapterId: string;
  adapterRevision: number;
  agentId: string;
  capabilityIds: string[];
  /** v1 compatibility fields; v2 Adapters use the plural mode fields. */
  inputMode?: "text";
  outputMode?: "text";
  inputModes?: readonly AgentTaskContentMode[];
  outputModes?: readonly AgentTaskContentMode[];
  timeoutMs: number;
  cancelGraceMs: number;
  maxOutputBytes: number;
}

export interface CallableAdapterTaskRequest {
  schemaVersion: 1 | 2;
  taskId: string;
  adapterId: string;
  agentId: string;
  capabilityId: string;
  input: {
    kind: "text" | "parts";
    text: string;
    images?: CallableAdapterImageInput[];
  };
  createdAt: string;
}

export interface CallableAdapterImageInput {
  attachmentId: string;
  mimeType: TaskImageMimeType;
  path: string;
}

/**
 * The Adapter receives only local execution metadata. Task text is deliberately
 * absent so an Adapter cannot copy it into argv, environment values, or paths.
 * The Kernel delivers task text through UTF-8 stdin after spawning a fixed
 * local entrypoint.
 */
export interface CallableAdapterLaunchContext {
  taskId: string;
  capabilityId: string;
  workspacePath: string;
  images: CallableAdapterImageInput[];
}

export interface CallableAdapterLaunchSpec {
  executable: string;
  args: string[];
  environment?: Record<string, string>;
}

export interface CallableAdapter {
  readonly descriptor: CallableAdapterDescriptor;
  /** Local-only fixed executable; never projected into Passport metadata. */
  readonly entrypoint: string;
  createLaunchSpec(
    context: Readonly<CallableAdapterLaunchContext>
  ): CallableAdapterLaunchSpec | Promise<CallableAdapterLaunchSpec>;
  /** Convert bounded process stdout into the only text eligible for Artifact. */
  decodeArtifact?(
    stdout: string,
    context: Readonly<CallableAdapterLaunchContext>
  ): string | CallableAdapterDecodedArtifact;
  /** Classify a non-zero exit without exposing process output to callers. */
  classifyFailure?(stdout: string): CallableAdapterSafeErrorCode;
}

export interface CallableAdapterDecodedArtifact {
  kind: "parts";
  text: string;
  images: Array<{ path: string }>;
}

export type CallableAdapterTaskArtifact =
  | { kind: "text"; text: string }
  | { kind: "parts"; text: string; images: TaskImagePart[] };

export interface CallableAdapterTaskSnapshot {
  schemaVersion: 2;
  taskId: string;
  adapterId: string;
  agentId: string;
  capabilityId: string;
  state: CallableAdapterTaskState;
  submittedAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  artifact?: CallableAdapterTaskArtifact;
  safeErrorCode?: CallableAdapterSafeErrorCode;
}

export class CallableAdapterContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CallableAdapterContractError";
    this.code = code;
  }
}

export class CallableAdapterOutputError extends Error {
  readonly safeErrorCode: CallableAdapterSafeErrorCode;

  constructor(safeErrorCode: CallableAdapterSafeErrorCode, message: string) {
    super(message);
    this.name = "CallableAdapterOutputError";
    this.safeErrorCode = safeErrorCode;
  }
}

const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function validateCallableAdapterDescriptor(
  value: CallableAdapterDescriptor
): void {
  if (value.contractVersion !== 1 && value.contractVersion !== TETI_CALLABLE_ADAPTER_CONTRACT_VERSION) {
    throw contractError("ADAPTER_CONTRACT_VERSION", "Unsupported Callable Adapter contract version.");
  }
  safeSlug(value.adapterId, "adapterId");
  safeSlug(value.agentId, "agentId");
  if (!Number.isInteger(value.adapterRevision) || value.adapterRevision <= 0) {
    throw contractError("ADAPTER_REVISION", "Callable Adapter revision must be positive.");
  }
  if (value.capabilityIds.length === 0 || value.capabilityIds.length > 32) {
    throw contractError("ADAPTER_CAPABILITIES", "Callable Adapter capabilities are invalid.");
  }
  const uniqueCapabilities = new Set(value.capabilityIds);
  if (uniqueCapabilities.size !== value.capabilityIds.length) {
    throw contractError("ADAPTER_CAPABILITIES", "Callable Adapter capabilities must be unique.");
  }
  for (const capabilityId of value.capabilityIds) safeSlug(capabilityId, "capabilityId");
  const inputModes = callableAdapterInputModes(value);
  const outputModes = callableAdapterOutputModes(value);
  if (!inputModes.includes("text") || !outputModes.includes("text")) {
    throw contractError("ADAPTER_CONTENT_MODE", "Callable Adapters must support bounded text.");
  }
  integerInRange(
    value.timeoutMs,
    CALLABLE_ADAPTER_LIMITS.minimumTimeoutMs,
    CALLABLE_ADAPTER_LIMITS.maximumTimeoutMs,
    "timeoutMs"
  );
  integerInRange(
    value.cancelGraceMs,
    0,
    CALLABLE_ADAPTER_LIMITS.maximumCancelGraceMs,
    "cancelGraceMs"
  );
  integerInRange(
    value.maxOutputBytes,
    CALLABLE_ADAPTER_LIMITS.minimumOutputBytes,
    CALLABLE_ADAPTER_LIMITS.maximumOutputBytes,
    "maxOutputBytes"
  );
}

export function validateCallableAdapterTaskRequest(
  value: CallableAdapterTaskRequest,
  descriptor: CallableAdapterDescriptor
): void {
  if (value.schemaVersion !== 1 && value.schemaVersion !== TETI_CALLABLE_TASK_SCHEMA_VERSION) {
    throw contractError("ADAPTER_TASK_VERSION", "Unsupported local Adapter task version.");
  }
  if (!SAFE_TASK_ID_PATTERN.test(value.taskId)) {
    throw contractError("ADAPTER_TASK_ID", "Local Adapter task ID is invalid.");
  }
  if (value.adapterId !== descriptor.adapterId || value.agentId !== descriptor.agentId) {
    throw contractError("ADAPTER_TASK_TARGET", "Local Adapter task target does not match its Adapter.");
  }
  if (!descriptor.capabilityIds.includes(value.capabilityId)) {
    throw contractError("ADAPTER_TASK_CAPABILITY", "Local Adapter task capability is not supported.");
  }
  if ((value.input.kind !== "text" && value.input.kind !== "parts")
    || typeof value.input.text !== "string" || !value.input.text.trim()) {
    throw contractError("ADAPTER_TASK_INPUT", "Local Adapter task requires non-empty text input.");
  }
  if (utf8Size(value.input.text) > MAX_TASK_INPUT_TEXT_BYTES) {
    throw contractError("ADAPTER_TASK_INPUT", "Local Adapter task input exceeds the allowed size.");
  }
  const images = value.input.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_TASK_IMAGE_PARTS) {
    throw contractError("ADAPTER_TASK_INPUT", "Local Adapter task images are invalid.");
  }
  if (value.schemaVersion === 1 && (value.input.kind !== "text" || images.length > 0)) {
    throw contractError("ADAPTER_TASK_INPUT", "Local Adapter task v1 is text-only.");
  }
  if (images.length > 0 && !callableAdapterInputModes(descriptor).includes("image")) {
    throw contractError("ADAPTER_TASK_INPUT", "Local Adapter does not accept image input.");
  }
  const seenImages = new Set<string>();
  for (const image of images) {
    if (!SAFE_TASK_ID_PATTERN.test(image.attachmentId)
      || (image.mimeType !== "image/jpeg" && image.mimeType !== "image/png")
      || typeof image.path !== "string"
      || !image.path.startsWith("/")
      || image.path.includes("\0")
      || seenImages.has(image.attachmentId)) {
      throw contractError("ADAPTER_TASK_INPUT", "Local Adapter task image is invalid.");
    }
    seenImages.add(image.attachmentId);
  }
  if (!value.createdAt.trim() || !Number.isFinite(Date.parse(value.createdAt))) {
    throw contractError("ADAPTER_TASK_TIMESTAMP", "Local Adapter task timestamp is invalid.");
  }
}

export function callableAdapterInputModes(
  descriptor: CallableAdapterDescriptor
): AgentTaskContentMode[] {
  return descriptorModes(descriptor, "input");
}

export function callableAdapterOutputModes(
  descriptor: CallableAdapterDescriptor
): AgentTaskContentMode[] {
  return descriptorModes(descriptor, "output");
}

function descriptorModes(
  descriptor: CallableAdapterDescriptor,
  direction: "input" | "output"
): AgentTaskContentMode[] {
  if (descriptor.contractVersion === 1) {
    const mode = direction === "input" ? descriptor.inputMode : descriptor.outputMode;
    if (mode !== "text") {
      throw contractError("ADAPTER_CONTENT_MODE", "Callable Adapter v1 must be text-only.");
    }
    return ["text"];
  }
  const values = direction === "input" ? descriptor.inputModes : descriptor.outputModes;
  if (!Array.isArray(values)
    || values.length === 0
    || values.length > 2
    || new Set(values).size !== values.length
    || values.some((mode) => mode !== "text" && mode !== "image")) {
    throw contractError("ADAPTER_CONTENT_MODE", "Callable Adapter content modes are invalid.");
  }
  return [...values];
}

export function validateCallableAdapterLaunchSpec(
  value: CallableAdapterLaunchSpec,
  expectedEntrypoint?: string
): void {
  if (typeof value.executable !== "string"
    || !value.executable.startsWith("/")
    || value.executable.includes("\0")) {
    throw contractError("ADAPTER_EXECUTABLE", "Callable Adapter executable must be an absolute local path.");
  }
  if (expectedEntrypoint !== undefined && value.executable !== expectedEntrypoint) {
    throw contractError("ADAPTER_EXECUTABLE", "Callable Adapter executable does not match its fixed entrypoint.");
  }
  if (!Array.isArray(value.args) || value.args.length > CALLABLE_ADAPTER_LIMITS.maximumArgs) {
    throw contractError("ADAPTER_ARGS", "Callable Adapter arguments exceed the allowed count.");
  }
  for (const argument of value.args) {
    if (typeof argument !== "string"
      || argument.includes("\0")
      || utf8Size(argument) > CALLABLE_ADAPTER_LIMITS.maximumArgBytes) {
      throw contractError("ADAPTER_ARGS", "Callable Adapter argument is invalid.");
    }
  }
  const entries = Object.entries(value.environment ?? {});
  if (entries.length > CALLABLE_ADAPTER_LIMITS.maximumEnvironmentEntries) {
    throw contractError("ADAPTER_ENVIRONMENT", "Callable Adapter environment exceeds the allowed count.");
  }
  for (const [name, environmentValue] of entries) {
    if (!SAFE_ENVIRONMENT_NAME_PATTERN.test(name)
      || environmentValue.includes("\0")
      || utf8Size(environmentValue) > CALLABLE_ADAPTER_LIMITS.maximumEnvironmentValueBytes) {
      throw contractError("ADAPTER_ENVIRONMENT", "Callable Adapter environment entry is invalid.");
    }
  }
}

export function validateCallableAdapterArtifactText(value: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError("ADAPTER_ARTIFACT", "Callable Adapter Artifact must contain text.");
  }
  if (utf8Size(value) > MAX_TASK_ARTIFACT_TEXT_BYTES) {
    throw contractError("ADAPTER_ARTIFACT", "Callable Adapter Artifact exceeds the allowed size.");
  }
}

function safeSlug(value: string, label: string): void {
  if (typeof value !== "string" || value.length > 128 || !SAFE_SLUG_PATTERN.test(value)) {
    throw contractError("ADAPTER_IDENTIFIER", `Callable Adapter ${label} is invalid.`);
  }
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw contractError("ADAPTER_LIMIT", `Callable Adapter ${label} is outside the allowed range.`);
  }
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function contractError(code: string, message: string): CallableAdapterContractError {
  return new CallableAdapterContractError(code, message);
}
