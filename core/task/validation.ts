import { isCanonicalTetiPublicId } from "../identity/public-id.ts";
import {
  validateTaskWorkspaceRequest,
  validateWorkspaceAccess
} from "../workspace/validation.ts";
import {
  MAX_EXECUTION_GRANT_TTL_MS,
  MAX_TASK_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_TEXT_BYTES,
  MAX_TASK_IMAGE_BYTES,
  MAX_TASK_IMAGE_DIMENSION,
  MAX_TASK_IMAGE_PARTS,
  MAX_TASK_IMAGE_TOTAL_BYTES,
  MAX_TASK_INPUT_TEXT_BYTES,
  MAX_TASK_INPUT_PARTS,
  MAX_TASK_REQUEST_BYTES,
  MAX_TASK_REQUEST_TTL_MS,
  TETI_COLLABORATION_TASK_SCHEMA_VERSION,
  TETI_EXECUTION_GRANT_SCHEMA_VERSION,
  TETI_TASK_ARTIFACT_SCHEMA_VERSION,
  type CollaborationTaskRequest,
  type CollaborationTaskArtifact,
  type ExecutionGrant,
  type TaskArtifactV2,
  type TaskImagePart,
  type TaskTextArtifact
} from "./types.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class TaskContractError extends Error {}

export function validateCollaborationTaskRequest(
  value: unknown
): asserts value is CollaborationTaskRequest {
  if (encodedSize(value, "Task request") > MAX_TASK_REQUEST_BYTES) {
    throw new TaskContractError("Task request exceeds the allowed size.");
  }
  if (!isRecord(value)) throw new TaskContractError("Task request must be an object.");
  const schemaVersion = value.schemaVersion;
  const request = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "requesterTetiId",
    "targetTetiId",
    "offerId",
    "capabilityId",
    "input",
    ...(schemaVersion === TETI_COLLABORATION_TASK_SCHEMA_VERSION ? ["workspace"] : []),
    "createdAt",
    "expiresAt"
  ], "Task request");
  if (request.schemaVersion !== 1
    && request.schemaVersion !== 2
    && request.schemaVersion !== 3
    && request.schemaVersion !== 4
    && request.schemaVersion !== TETI_COLLABORATION_TASK_SCHEMA_VERSION) {
    throw new TaskContractError("Unsupported Task request schema version.");
  }
  safeId(request.taskId, "taskId");
  canonicalTetiId(request.requesterTetiId, "requesterTetiId");
  canonicalTetiId(request.targetTetiId, "targetTetiId");
  if (request.requesterTetiId === request.targetTetiId) {
    throw new TaskContractError("Task requester and target must be different Tetis.");
  }
  safeId(request.offerId, "offerId");
  safeSlug(request.capabilityId, "capabilityId");
  if (request.schemaVersion === 1) {
    validateTextPart(request.input, MAX_TASK_INPUT_TEXT_BYTES, "Task input");
  } else {
    validateMultipartInput(request.input);
  }
  if (request.schemaVersion === TETI_COLLABORATION_TASK_SCHEMA_VERSION) {
    validateTaskWorkspaceRequest(request.workspace);
  }
  const createdAt = timestamp(request.createdAt, "createdAt");
  const expiresAt = timestamp(request.expiresAt, "expiresAt");
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_TASK_REQUEST_TTL_MS) {
    throw new TaskContractError("Task request expiry is invalid.");
  }
}

export function validateTaskArtifact(
  value: unknown
): asserts value is CollaborationTaskArtifact {
  if (typeof value === "object" && value !== null
    && (value as Record<string, unknown>).schemaVersion === 1) {
    validateTaskTextArtifact(value);
    return;
  }
  validateTaskArtifactV2(value);
}

export function validateTaskArtifactV2(
  value: unknown
): asserts value is TaskArtifactV2 {
  if (encodedSize(value, "Task artifact") > MAX_TASK_ARTIFACT_BYTES) {
    throw new TaskContractError("Task artifact exceeds the allowed size.");
  }
  const artifact = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "artifactId",
    "parts",
    "createdAt"
  ], "Task artifact");
  if (artifact.schemaVersion !== TETI_TASK_ARTIFACT_SCHEMA_VERSION) {
    throw new TaskContractError("Unsupported Task artifact schema version.");
  }
  safeId(artifact.taskId, "taskId");
  safeId(artifact.artifactId, "artifactId");
  validateParts(artifact.parts, "Task artifact", false, MAX_TASK_ARTIFACT_TEXT_BYTES);
  timestamp(artifact.createdAt, "createdAt");
}

export function validateTaskTextArtifact(
  value: unknown
): asserts value is TaskTextArtifact {
  if (encodedSize(value, "Task artifact") > MAX_TASK_ARTIFACT_BYTES) {
    throw new TaskContractError("Task artifact exceeds the allowed size.");
  }
  const artifact = exactRecord(value, [
    "schemaVersion",
    "taskId",
    "artifactId",
    "kind",
    "text",
    "createdAt"
  ], "Task artifact");
  if (artifact.schemaVersion !== 1) {
    throw new TaskContractError("Unsupported Task artifact schema version.");
  }
  safeId(artifact.taskId, "taskId");
  safeId(artifact.artifactId, "artifactId");
  validateTextPart(
    { kind: artifact.kind, text: artifact.text },
    MAX_TASK_ARTIFACT_TEXT_BYTES,
    "Task artifact"
  );
  timestamp(artifact.createdAt, "createdAt");
}

export function validateExecutionGrant(
  value: unknown
): asserts value is ExecutionGrant {
  const grant = exactRecord(value, [
    "schemaVersion",
    "grantId",
    "taskId",
    "requesterTetiId",
    "capabilityId",
    "agentId",
    "adapterId",
    "inputDigest",
    "issuedAt",
    "expiresAt",
    "singleUse",
    "workspaceId",
    "workspaceRevision",
    "workspaceAccess",
    "userFileAccess",
    "commandPolicy",
    "networkPolicy"
  ], "Execution Grant");
  if (grant.schemaVersion !== TETI_EXECUTION_GRANT_SCHEMA_VERSION) {
    throw new TaskContractError("Unsupported Execution Grant schema version.");
  }
  safeId(grant.grantId, "grantId");
  safeId(grant.taskId, "taskId");
  canonicalTetiId(grant.requesterTetiId, "requesterTetiId");
  safeSlug(grant.capabilityId, "capabilityId");
  safeSlug(grant.agentId, "agentId");
  safeSlug(grant.adapterId, "adapterId");
  if (typeof grant.inputDigest !== "string" || !SHA256_PATTERN.test(grant.inputDigest)) {
    throw new TaskContractError("Execution Grant inputDigest is invalid.");
  }
  const issuedAt = timestamp(grant.issuedAt, "issuedAt");
  const expiresAt = timestamp(grant.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_EXECUTION_GRANT_TTL_MS) {
    throw new TaskContractError("Execution Grant expiry is invalid.");
  }
  safeId(grant.workspaceId, "workspaceId");
  if (!Number.isSafeInteger(grant.workspaceRevision) || Number(grant.workspaceRevision) <= 0) {
    throw new TaskContractError("Execution Grant workspaceRevision is invalid.");
  }
  validateWorkspaceAccess(grant.workspaceAccess);
  if (grant.singleUse !== true
    || grant.userFileAccess !== "none"
    || grant.commandPolicy !== "fixed_adapter_entrypoint"
    || grant.networkPolicy !== "agent_managed") {
    throw new TaskContractError("Execution Grant scope is invalid.");
  }
}

function validateTextPart(value: unknown, maxBytes: number, label: string): void {
  const part = exactRecord(value, ["kind", "text"], label);
  if (part.kind !== "text" || typeof part.text !== "string" || !part.text.trim()) {
    throw new TaskContractError(`${label} must contain non-empty text.`);
  }
  if (new TextEncoder().encode(part.text).byteLength > maxBytes) {
    throw new TaskContractError(`${label} text exceeds the allowed size.`);
  }
}

function validateMultipartInput(value: unknown): void {
  const input = exactRecord(value, ["kind", "parts"], "Task input");
  if (input.kind !== "parts") {
    throw new TaskContractError("Task input must contain ordered parts.");
  }
  validateParts(input.parts, "Task input", true, MAX_TASK_INPUT_TEXT_BYTES);
}

function validateParts(
  value: unknown,
  label: string,
  requireLeadingText: boolean,
  maximumTextBytes: number
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASK_INPUT_PARTS) {
    throw new TaskContractError(`${label} parts are invalid.`);
  }
  let textCount = 0;
  let imageCount = 0;
  let imageBytes = 0;
  const attachmentIds = new Set<string>();
  value.forEach((part, index) => {
    if (!isRecord(part)) throw new TaskContractError(`${label} part is invalid.`);
    if (part.kind === "text") {
      validateTextPart(part, maximumTextBytes, `${label} text part`);
      textCount += 1;
      if (requireLeadingText && index !== 0) {
        throw new TaskContractError(`${label} text must be the first part.`);
      }
      return;
    }
    validateTaskImagePart(part, `${label} image part`);
    imageCount += 1;
    imageBytes += part.byteLength as number;
    if (attachmentIds.has(part.attachmentId as string)) {
      throw new TaskContractError(`${label} attachment IDs must be unique.`);
    }
    attachmentIds.add(part.attachmentId as string);
  });
  if ((requireLeadingText && textCount !== 1) || (!requireLeadingText && textCount > 1)) {
    throw new TaskContractError(`${label} text part count is invalid.`);
  }
  if (imageCount > MAX_TASK_IMAGE_PARTS || imageBytes > MAX_TASK_IMAGE_TOTAL_BYTES) {
    throw new TaskContractError(`${label} images exceed the allowed limit.`);
  }
}

export function validateTaskImagePart(
  value: unknown,
  label = "Task image part"
): asserts value is TaskImagePart {
  const part = exactRecord(value, [
    "kind",
    "attachmentId",
    "mimeType",
    "byteLength",
    "width",
    "height",
    "sha256"
  ], label);
  if (part.kind !== "image") throw new TaskContractError(`${label} kind is invalid.`);
  safeId(part.attachmentId, "attachmentId");
  if (part.mimeType !== "image/jpeg" && part.mimeType !== "image/png") {
    throw new TaskContractError(`${label} MIME type is invalid.`);
  }
  if (!Number.isSafeInteger(part.byteLength)
    || Number(part.byteLength) <= 0
    || Number(part.byteLength) > MAX_TASK_IMAGE_BYTES) {
    throw new TaskContractError(`${label} byte length is invalid.`);
  }
  for (const dimension of [part.width, part.height]) {
    if (!Number.isSafeInteger(dimension)
      || Number(dimension) <= 0
      || Number(dimension) > MAX_TASK_IMAGE_DIMENSION) {
      throw new TaskContractError(`${label} dimensions are invalid.`);
    }
  }
  if (typeof part.sha256 !== "string" || !SHA256_PATTERN.test(part.sha256)) {
    throw new TaskContractError(`${label} digest is invalid.`);
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskContractError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  const missing = keys.find((key) => !(key in record));
  if (extra) throw new TaskContractError(`${label} contains an unsupported field.`);
  if (missing) throw new TaskContractError(`${label} is missing a required field.`);
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTetiId(value: unknown, label: string): asserts value is string {
  if (!isCanonicalTetiPublicId(value)) {
    throw new TaskContractError(`${label} must be a canonical lowercase Teti ID.`);
  }
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new TaskContractError(`${label} is invalid.`);
  }
}

function safeSlug(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 128 || !SAFE_SLUG_PATTERN.test(value)) {
    throw new TaskContractError(`${label} is invalid.`);
  }
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskContractError(`${label} is required.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TaskContractError(`${label} is invalid.`);
  return parsed;
}

function encodedSize(value: unknown, label: string): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new TaskContractError(`${label} is not serializable.`);
  }
}
