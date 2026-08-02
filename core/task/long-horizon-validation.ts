import { validateExecutionProgress } from "../callability/execution.ts";
import {
  LONG_HORIZON_LIMITS,
  type LongHorizonTaskState
} from "./transport.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;

export function validateLongHorizonTaskState(
  value: unknown
): asserts value is LongHorizonTaskState {
  const session = exact(value, [
    "schemaVersion",
    "phase",
    "currentStageIndex",
    "workspaceRevision",
    "progress",
    "continuationExpiresAt",
    "renewalCount",
    "pauseRequested",
    "pendingInput",
    "inputRequest",
    "availableChildAgents",
    "stages",
    "checkpoints",
    "artifacts",
    "audit",
    "updatedAt"
  ], "Long-horizon Task");
  if (session.schemaVersion !== 1
    || !["pending_approval", "working", "input_required", "paused", "completed", "failed", "canceled", "expired"].includes(String(session.phase))
    || !positiveOrZero(session.currentStageIndex)
    || !positive(session.workspaceRevision)
    || !positiveOrZero(session.renewalCount)
    || Number(session.renewalCount) > LONG_HORIZON_LIMITS.maximumRenewals
    || typeof session.pauseRequested !== "boolean") {
    throw new Error("Long-horizon Task state is invalid.");
  }
  validateExecutionProgress(session.progress);
  timestamp(session.continuationExpiresAt, "continuationExpiresAt");
  timestamp(session.updatedAt, "updatedAt");
  if (session.pendingInput !== null) validateInput(session.pendingInput);
  if (session.inputRequest !== null) validateInputRequest(session.inputRequest);
  if (!Array.isArray(session.availableChildAgents) || session.availableChildAgents.length > 32) {
    throw new Error("Long-horizon Child targets are invalid.");
  }
  const targets = new Set<string>();
  for (const value of session.availableChildAgents) {
    const target = exact(value, ["childAgentId", "connectorId"], "Long-horizon Child target");
    slug(target.childAgentId, "childAgentId");
    slug(target.connectorId, "connectorId");
    const key = `${String(target.childAgentId)}:${String(target.connectorId)}`;
    if (targets.has(key)) throw new Error("Long-horizon Child targets are duplicated.");
    targets.add(key);
  }
  validateStages(session.stages, Number(session.currentStageIndex));
  validateCheckpoints(session.checkpoints);
  validateLongHorizonArtifactEntries(session.artifacts);
  validateAudit(session.audit);
}

function validateStages(value: unknown, currentStageIndex: number): void {
  if (!Array.isArray(value) || value.length > LONG_HORIZON_LIMITS.maximumStages) {
    throw new Error("Long-horizon stages are invalid.");
  }
  const indexes = new Set<number>();
  for (const item of value) {
    const stage = exactOptional(item, [
      "stageId",
      "stageIndex",
      "executionTaskId",
      "childAgentId",
      "connectorId",
      "state",
      "workspaceRevision",
      "workspaceMutation",
      "inputId",
      "instructionDigest",
      "progress",
      "artifactIds",
      "checkpointAvailable",
      "startedAt",
      "updatedAt"
    ], ["completedAt", "safeErrorCode"], "Long-horizon stage");
    id(stage.stageId, "stageId");
    id(stage.executionTaskId, "executionTaskId");
    slug(stage.childAgentId, "childAgentId");
    slug(stage.connectorId, "connectorId");
    if (!positive(stage.stageIndex)
      || Number(stage.stageIndex) > LONG_HORIZON_LIMITS.maximumStages
      || indexes.has(Number(stage.stageIndex))
      || !["queued", "working", "completed", "failed", "canceled", "interrupted"].includes(String(stage.state))
      || !positive(stage.workspaceRevision)
      || (stage.workspaceMutation !== "none" && stage.workspaceMutation !== "snapshot_commit")
      || (stage.inputId !== null && !SAFE_ID.test(String(stage.inputId)))
      || typeof stage.instructionDigest !== "string" || !DIGEST.test(stage.instructionDigest)
      || typeof stage.checkpointAvailable !== "boolean") {
      throw new Error("Long-horizon stage is invalid.");
    }
    indexes.add(Number(stage.stageIndex));
    validateExecutionProgress(stage.progress);
    validateIdArray(stage.artifactIds, LONG_HORIZON_LIMITS.maximumArtifacts, "stage artifact IDs");
    timestamp(stage.startedAt, "startedAt");
    timestamp(stage.updatedAt, "updatedAt");
    if (stage.completedAt !== undefined) timestamp(stage.completedAt, "completedAt");
    safeCode(stage.safeErrorCode);
  }
  if (value.length > 0 && !indexes.has(currentStageIndex)) {
    throw new Error("Long-horizon current stage is unavailable.");
  }
}

function validateInput(value: unknown): void {
  const input = exactOptional(value, [
    "inputId",
    "instruction",
    "instructionDigest",
    "source",
    "createdAt"
  ], ["consumedAt"], "Long-horizon input");
  id(input.inputId, "inputId");
  if (typeof input.instruction !== "string" || !input.instruction.trim()
    || new TextEncoder().encode(input.instruction).byteLength > LONG_HORIZON_LIMITS.maximumInstructionBytes
    || typeof input.instructionDigest !== "string" || !DIGEST.test(input.instructionDigest)
    || (input.source !== "remote_requester" && input.source !== "local_user")) {
    throw new Error("Long-horizon input is invalid.");
  }
  timestamp(input.createdAt, "createdAt");
  if (input.consumedAt !== undefined) timestamp(input.consumedAt, "consumedAt");
}

function validateInputRequest(value: unknown): void {
  const request = exact(value, ["requestId", "prompt", "createdAt"], "Long-horizon input request");
  id(request.requestId, "requestId");
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 240) {
    throw new Error("Long-horizon input request is invalid.");
  }
  timestamp(request.createdAt, "createdAt");
}

function validateCheckpoints(value: unknown): void {
  if (!Array.isArray(value) || value.length > LONG_HORIZON_LIMITS.maximumStages) {
    throw new Error("Long-horizon checkpoints are invalid.");
  }
  for (const item of value) {
    const checkpoint = exact(item, [
      "checkpointId",
      "stageIndex",
      "workspaceRevision",
      "artifactIds",
      "digest",
      "createdAt"
    ], "Long-horizon checkpoint");
    id(checkpoint.checkpointId, "checkpointId");
    if (!positive(checkpoint.stageIndex) || !positive(checkpoint.workspaceRevision)
      || typeof checkpoint.digest !== "string" || !DIGEST.test(checkpoint.digest)) {
      throw new Error("Long-horizon checkpoint is invalid.");
    }
    validateIdArray(checkpoint.artifactIds, LONG_HORIZON_LIMITS.maximumArtifacts, "checkpoint artifact IDs");
    timestamp(checkpoint.createdAt, "createdAt");
  }
}

export function validateLongHorizonArtifactEntries(value: unknown): void {
  if (!Array.isArray(value) || value.length > LONG_HORIZON_LIMITS.maximumArtifacts) {
    throw new Error("Long-horizon Artifact entries are invalid.");
  }
  const ids = new Set<string>();
  for (const item of value) {
    const artifact = exact(item, ["artifactId", "stageIndex", "role", "createdAt"], "Long-horizon Artifact entry");
    id(artifact.artifactId, "artifactId");
    if (ids.has(String(artifact.artifactId)) || !positive(artifact.stageIndex)
      || Number(artifact.stageIndex) > LONG_HORIZON_LIMITS.maximumStages
      || (artifact.role !== "intermediate" && artifact.role !== "final")) {
      throw new Error("Long-horizon Artifact entry is invalid.");
    }
    ids.add(String(artifact.artifactId));
    timestamp(artifact.createdAt, "createdAt");
  }
  if (value.filter((item) => (item as { role?: unknown }).role === "final").length > 1) {
    throw new Error("Long-horizon Task has multiple final Artifacts.");
  }
}

function validateAudit(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > LONG_HORIZON_LIMITS.maximumAuditEvents) {
    throw new Error("Long-horizon audit is invalid.");
  }
  const actions = [
    "session_created", "stage_started", "progress_updated", "artifact_published",
    "checkpoint_created", "input_requested", "input_received", "pause_requested",
    "paused", "resumed", "child_selected", "stage_failed", "renewed", "completed",
    "canceled", "expired", "restart_reconciled"
  ];
  value.forEach((item, index) => {
    const event = exactOptional(item, [
      "eventId", "sequence", "action", "actor", "stageIndex", "timestamp"
    ], ["childAgentId", "artifactId", "inputId", "workspaceRevision", "safeErrorCode"], "Long-horizon audit event");
    id(event.eventId, "eventId");
    if (event.sequence !== index + 1 || !actions.includes(String(event.action))
      || !["host", "local_user", "remote_peer", "child_agent"].includes(String(event.actor))
      || (event.stageIndex !== null && !positive(event.stageIndex))) {
      throw new Error("Long-horizon audit event is invalid.");
    }
    timestamp(event.timestamp, "timestamp");
    if (event.childAgentId !== undefined) slug(event.childAgentId, "childAgentId");
    if (event.artifactId !== undefined) id(event.artifactId, "artifactId");
    if (event.inputId !== undefined) id(event.inputId, "inputId");
    if (event.workspaceRevision !== undefined && !positive(event.workspaceRevision)) {
      throw new Error("Long-horizon audit Workspace revision is invalid.");
    }
    safeCode(event.safeErrorCode);
  });
}

function validateIdArray(value: unknown, maximum: number, label: string): void {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => typeof item !== "string" || !SAFE_ID.test(item))
    || new Set(value).size !== value.length) throw new Error(`Long-horizon ${label} are invalid.`);
}

function exact(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  return exactOptional(value, required, [], label);
}

function exactOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  return record;
}

function id(value: unknown, label: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
}

function slug(value: unknown, label: string): void {
  if (typeof value !== "string" || !SAFE_SLUG.test(value)) throw new Error(`${label} is invalid.`);
}

function timestamp(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

function safeCode(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !SAFE_CODE.test(value))) {
    throw new Error("Long-horizon safe error code is invalid.");
  }
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveOrZero(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
