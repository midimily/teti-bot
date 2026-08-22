import { isCanonicalTetiPublicId } from "../identity/public-id.ts";
import {
  MAX_TASK_PROTOCOL_VERSIONS,
  TETI_TASK_TRANSPORT_SCHEMA_VERSION,
  TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS,
  type TetiTaskProtocolVersion,
  type TetiTaskArtifactPayload,
  type TetiTaskArtifactFilePayload,
  type TetiTaskArtifactReceiptPayload,
  type TetiTaskAttachmentReceiptPayload,
  type TetiTaskAttachmentPayload,
  type TetiTaskCancelPayload,
  type TetiTaskApplicationReceiptPayload,
  type TetiTaskReceiptPayload,
  type TetiTaskStatusPayload,
  type TetiTaskInputPayload,
  type TetiTaskLongHorizonStatus
} from "./transport.ts";
import type { CollaborationTaskRequest, TaskImagePart, TaskTextPart } from "./types.ts";
import { validateTaskArtifact, validateTaskImagePart } from "./validation.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_STATUSES = ["received", "duplicate", "expired", "conflict", "rejected"] as const;
const TASK_UPDATE_STATES = [
  "working",
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected"
] as const;

export class TaskTransportContractError extends Error {}

export function validateTaskReceiptPayload(
  value: unknown
): asserts value is TetiTaskReceiptPayload {
  const receipt = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "status",
    "receivedAt",
    "supportedTaskVersions"
  ], "Task receipt");
  if (receipt.schemaVersion !== TETI_TASK_TRANSPORT_SCHEMA_VERSION) {
    throw new TaskTransportContractError("Unsupported Task receipt schema version.");
  }
  safeId(receipt.taskId, "taskId");
  canonicalTetiId(receipt.requesterTetiId, "requesterTetiId");
  canonicalTetiId(receipt.targetTetiId, "targetTetiId");
  if (receipt.requesterTetiId === receipt.targetTetiId) {
    throw new TaskTransportContractError("Task requester and target must be different Tetis.");
  }
  if (typeof receipt.status !== "string" || !RECEIPT_STATUSES.includes(
    receipt.status as (typeof RECEIPT_STATUSES)[number]
  )) {
    throw new TaskTransportContractError("Task receipt status is invalid.");
  }
  timestamp(receipt.receivedAt, "receivedAt");
  validateTaskProtocolVersions(receipt.supportedTaskVersions);
}

export function validateTaskProtocolVersions(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASK_PROTOCOL_VERSIONS) {
    throw new TaskTransportContractError("Task protocol versions are invalid.");
  }
  const seen = new Set<number>();
  for (const version of value) {
    if (!Number.isSafeInteger(version) || version < 1 || version > 255 || seen.has(version)) {
      throw new TaskTransportContractError("Task protocol versions are invalid.");
    }
    seen.add(version);
  }
}

export function validateTaskAttachmentPayload(
  value: unknown
): asserts value is TetiTaskAttachmentPayload {
  const payload = exactOptionalRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "purpose",
    "part",
    "createdAt",
    "expiresAt"
  ], ["artifactId", "deliveryReceiptRequested"], "Task attachment");
  if (payload.schemaVersion !== 1) throw new TaskTransportContractError("Unsupported Task attachment version.");
  taskIdentity(payload);
  if (payload.purpose !== "input" && payload.purpose !== "artifact") {
    throw new TaskTransportContractError("Task attachment purpose is invalid.");
  }
  if (payload.purpose === "artifact") safeId(payload.artifactId, "artifactId");
  if (payload.purpose === "input" && payload.artifactId !== undefined) {
    throw new TaskTransportContractError("Task input attachment cannot name an Artifact.");
  }
  if (payload.deliveryReceiptRequested !== undefined && payload.deliveryReceiptRequested !== true) {
    throw new TaskTransportContractError("Task attachment receipt request is invalid.");
  }
  validateTaskImagePart(payload.part);
  const createdAt = timestamp(payload.createdAt, "createdAt");
  const expiresAt = timestamp(payload.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new TaskTransportContractError("Task attachment expiry is invalid.");
}

export function validateTaskAttachmentReceiptPayload(
  value: unknown
): asserts value is TetiTaskAttachmentReceiptPayload {
  const payload = exactOptionalRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "purpose",
    "attachmentId",
    "receivedAt"
  ], ["artifactId"], "Task attachment receipt");
  if (payload.schemaVersion !== 1) {
    throw new TaskTransportContractError("Unsupported Task attachment receipt version.");
  }
  taskIdentity(payload);
  if (payload.purpose !== "input" && payload.purpose !== "artifact") {
    throw new TaskTransportContractError("Task attachment receipt purpose is invalid.");
  }
  safeId(payload.attachmentId, "attachmentId");
  if (payload.purpose === "artifact") safeId(payload.artifactId, "artifactId");
  if (payload.purpose === "input" && payload.artifactId !== undefined) {
    throw new TaskTransportContractError("Task input attachment receipt cannot name an Artifact.");
  }
  timestamp(payload.receivedAt, "receivedAt");
}

export function validateTaskStatusPayload(
  value: unknown
): asserts value is TetiTaskStatusPayload {
  const schemaVersion = isRecord(value) ? value.schemaVersion : undefined;
  const payload = exactOptionalRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "revision",
    "state",
    "updatedAt"
  ], ["safeErrorCode", ...(schemaVersion === 2 ? ["longHorizon"] : [])], "Task status");
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw new TaskTransportContractError("Unsupported Task status version.");
  }
  taskIdentity(payload);
  if (!Number.isSafeInteger(payload.revision) || Number(payload.revision) <= 0) {
    throw new TaskTransportContractError("Task status revision is invalid.");
  }
  if (typeof payload.state !== "string"
    || !TASK_UPDATE_STATES.includes(payload.state as (typeof TASK_UPDATE_STATES)[number])) {
    throw new TaskTransportContractError("Task status state is invalid.");
  }
  timestamp(payload.updatedAt, "updatedAt");
  if (payload.safeErrorCode !== undefined
    && (typeof payload.safeErrorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(payload.safeErrorCode))) {
    throw new TaskTransportContractError("Task status safe error code is invalid.");
  }
  if (payload.schemaVersion === 2) validateLongHorizonStatus(payload.longHorizon);
}

export function validateTaskInputPayload(value: unknown): asserts value is TetiTaskInputPayload {
  const payload = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "inputId",
    "expectedStageIndex",
    "instruction",
    "createdAt"
  ], "Task supplemental input");
  if (payload.schemaVersion !== 1) throw new TaskTransportContractError("Unsupported Task input version.");
  taskIdentity(payload);
  safeId(payload.inputId, "inputId");
  if (!Number.isSafeInteger(payload.expectedStageIndex) || Number(payload.expectedStageIndex) < 1) {
    throw new TaskTransportContractError("Task input stage is invalid.");
  }
  if (typeof payload.instruction !== "string" || !payload.instruction.trim()
    || new TextEncoder().encode(payload.instruction).byteLength > 8 * 1024) {
    throw new TaskTransportContractError("Task supplemental instruction is invalid.");
  }
  timestamp(payload.createdAt, "createdAt");
}

export function validateTaskCancelPayload(
  value: unknown
): asserts value is TetiTaskCancelPayload {
  const payload = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "controlId",
    "requestedAt"
  ], "Task cancel");
  if (payload.schemaVersion !== 1) throw new TaskTransportContractError("Unsupported Task cancel version.");
  taskIdentity(payload);
  safeId(payload.controlId, "controlId");
  timestamp(payload.requestedAt, "requestedAt");
}

export function validateTaskApplicationReceiptPayload(
  value: unknown
): asserts value is TetiTaskApplicationReceiptPayload {
  const payload = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "kind",
    "referenceId",
    "receivedAt"
  ], "Task application receipt");
  if (payload.schemaVersion !== 1) {
    throw new TaskTransportContractError("Unsupported Task application receipt version.");
  }
  taskIdentity(payload);
  if (payload.kind !== "status" && payload.kind !== "input" && payload.kind !== "control") {
    throw new TaskTransportContractError("Task application receipt kind is invalid.");
  }
  safeId(payload.referenceId, "referenceId");
  if (payload.kind === "status"
    && (!/^\d+$/.test(String(payload.referenceId)) || Number(payload.referenceId) < 1)) {
    throw new TaskTransportContractError("Task status receipt reference is invalid.");
  }
  timestamp(payload.receivedAt, "receivedAt");
}

export function validateTaskArtifactPayload(
  value: unknown
): asserts value is TetiTaskArtifactPayload {
  const schemaVersion = isRecord(value) ? value.schemaVersion : undefined;
  const payload = exactOptionalRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "artifact",
    "createdAt"
  ], schemaVersion === 2 ? ["stageIndex", "role"] : [], "Task Artifact payload");
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw new TaskTransportContractError("Unsupported Task Artifact payload version.");
  }
  taskIdentity(payload);
  validateTaskArtifact(payload.artifact);
  if ((payload.artifact as { taskId: string }).taskId !== payload.taskId) {
    throw new TaskTransportContractError("Task Artifact identity is invalid.");
  }
  timestamp(payload.createdAt, "createdAt");
  if (payload.schemaVersion === 2) {
    if (!Number.isSafeInteger(payload.stageIndex) || Number(payload.stageIndex) < 1
      || (payload.role !== "intermediate" && payload.role !== "final")) {
      throw new TaskTransportContractError("Task Artifact stage metadata is invalid.");
    }
  }
}

export function validateTaskArtifactFilePayload(
  value: unknown
): asserts value is TetiTaskArtifactFilePayload {
  const schemaVersion = isRecord(value) ? value.schemaVersion : undefined;
  const payload = exactOptionalRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "artifactId",
    "byteLength",
    "sha256",
    "createdAt",
    "expiresAt",
    "deliveryReceiptRequested"
  ], schemaVersion === 2 ? ["stageIndex", "role"] : [], "Task Artifact file");
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw new TaskTransportContractError("Unsupported Task Artifact file version.");
  }
  taskIdentity(payload);
  safeId(payload.artifactId, "artifactId");
  if (!Number.isSafeInteger(payload.byteLength)
    || Number(payload.byteLength) <= 0
    || Number(payload.byteLength) > 64 * 1024
    || typeof payload.sha256 !== "string"
    || !SHA256_PATTERN.test(payload.sha256)
    || payload.deliveryReceiptRequested !== true) {
    throw new TaskTransportContractError("Task Artifact file integrity metadata is invalid.");
  }
  const createdAt = timestamp(payload.createdAt, "createdAt");
  const expiresAt = timestamp(payload.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) throw new TaskTransportContractError("Task Artifact file expiry is invalid.");
  if (payload.schemaVersion === 2
    && (!Number.isSafeInteger(payload.stageIndex)
      || Number(payload.stageIndex) < 1
      || (payload.role !== "intermediate" && payload.role !== "final"))) {
    throw new TaskTransportContractError("Task Artifact file stage metadata is invalid.");
  }
}

export function validateTaskArtifactReceiptPayload(
  value: unknown
): asserts value is TetiTaskArtifactReceiptPayload {
  const payload = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "artifactId",
    "sha256",
    "receivedAt"
  ], "Task Artifact receipt");
  if (payload.schemaVersion !== 1) {
    throw new TaskTransportContractError("Unsupported Task Artifact receipt version.");
  }
  taskIdentity(payload);
  safeId(payload.artifactId, "artifactId");
  if (typeof payload.sha256 !== "string" || !SHA256_PATTERN.test(payload.sha256)) {
    throw new TaskTransportContractError("Task Artifact receipt digest is invalid.");
  }
  timestamp(payload.receivedAt, "receivedAt");
}

/** Beta 0.4.0 never speculatively downgrades or sends before a v7 advertisement. */
export function selectTaskProtocolVersion(
  remoteVersions?: readonly number[]
): TetiTaskProtocolVersion | null {
  if (!remoteVersions) return null;
  const supported = [...TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS]
    .sort((left, right) => right - left)
    .find((version) => remoteVersions.includes(version));
  return supported ?? null;
}

export function canonicalTaskRequestJson(value: CollaborationTaskRequest): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    taskId: value.taskId,
    requesterTetiId: value.requesterTetiId,
    targetTetiId: value.targetTetiId,
    offerId: value.offerId,
    capabilityId: value.capabilityId,
    input: canonicalInput(value.input),
    ...(value.workspace ? { workspace: canonicalWorkspace(value.workspace) } : {}),
    ...(value.executionMode ? { executionMode: value.executionMode } : {}),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt
  });
}

function validateLongHorizonStatus(value: unknown): asserts value is TetiTaskLongHorizonStatus {
  const status = exactOptionalRecord(value, [
    "schemaVersion",
    "phase",
    "currentStageIndex",
    "workspaceRevision",
    "completedUnits",
    "totalUnits",
    "progressMessage",
    "continuationExpiresAt"
  ], ["inputRequestId", "finalArtifactId"], "Long-horizon Task status");
  if (status.schemaVersion !== 1
    || !["working", "input_required", "paused", "completed", "failed", "canceled", "expired"].includes(String(status.phase))
    || !Number.isSafeInteger(status.currentStageIndex) || Number(status.currentStageIndex) < 0
    || !Number.isSafeInteger(status.workspaceRevision) || Number(status.workspaceRevision) < 1
    || !nullableUnit(status.completedUnits)
    || !nullableUnit(status.totalUnits)
    || (status.progressMessage !== null
      && (typeof status.progressMessage !== "string" || status.progressMessage.length > 240))) {
    throw new TaskTransportContractError("Long-horizon Task status is invalid.");
  }
  timestamp(status.continuationExpiresAt, "continuationExpiresAt");
  if (status.inputRequestId !== undefined) safeId(status.inputRequestId, "inputRequestId");
  if (status.finalArtifactId !== undefined) safeId(status.finalArtifactId, "finalArtifactId");
}

function nullableUnit(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalWorkspace(workspace: NonNullable<CollaborationTaskRequest["workspace"]>): unknown {
  return workspace.kind === "temporary"
    ? { kind: "temporary", access: [...workspace.access] }
    : {
        kind: "reference",
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.workspaceRevision,
        access: [...workspace.access]
      };
}

function canonicalInput(input: CollaborationTaskRequest["input"]): unknown {
  if (input.kind === "text") return { kind: "text", text: input.text };
  return {
    kind: "parts",
    parts: input.parts.map((part) => part.kind === "text"
      ? canonicalTextPart(part)
      : canonicalImagePart(part))
  };
}

function canonicalTextPart(part: TaskTextPart): unknown {
  return { kind: "text", text: part.text };
}

function canonicalImagePart(part: TaskImagePart): unknown {
  return {
    kind: "image",
    attachmentId: part.attachmentId,
    mimeType: part.mimeType,
    byteLength: part.byteLength,
    width: part.width,
    height: part.height,
    sha256: part.sha256
  };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskTransportContractError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !(key in record));
  if (extra) throw new TaskTransportContractError(`${label} contains an unsupported field.`);
  if (missing) throw new TaskTransportContractError(`${label} is missing a required field.`);
  return record;
}

function exactOptionalRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskTransportContractError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  const missing = required.find((key) => !(key in record));
  if (extra) throw new TaskTransportContractError(`${label} contains an unsupported field.`);
  if (missing) throw new TaskTransportContractError(`${label} is missing a required field.`);
  return record;
}

function taskIdentity(value: Record<string, unknown>): void {
  safeId(value.taskId, "taskId");
  canonicalTetiId(value.requesterTetiId, "requesterTetiId");
  canonicalTetiId(value.targetTetiId, "targetTetiId");
  if (value.requesterTetiId === value.targetTetiId) {
    throw new TaskTransportContractError("Task requester and target must be different Tetis.");
  }
}

function canonicalTetiId(value: unknown, label: string): asserts value is string {
  if (!isCanonicalTetiPublicId(value)) {
    throw new TaskTransportContractError(`${label} must be a canonical lowercase Teti ID.`);
  }
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new TaskTransportContractError(`${label} is invalid.`);
  }
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskTransportContractError(`${label} is required.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TaskTransportContractError(`${label} is invalid.`);
  return parsed;
}
