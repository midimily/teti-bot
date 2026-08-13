import type {
  TaskWorkspaceRequest,
  WorkspaceAccess
} from "../workspace/types.ts";

export const TETI_COLLABORATION_TASK_SCHEMA_VERSION = 7;
export const TETI_TASK_ARTIFACT_SCHEMA_VERSION = 2;
export const TETI_EXECUTION_GRANT_SCHEMA_VERSION = 2;

export const MAX_TASK_REQUEST_BYTES = 32 * 1024;
export const MAX_TASK_INPUT_TEXT_BYTES = 24 * 1024;
export const MAX_TASK_INPUT_PARTS = 5;
export const MAX_TASK_IMAGE_PARTS = 4;
export const MAX_TASK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TASK_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_TASK_IMAGE_DIMENSION = 4_096;
export const MAX_TASK_ARTIFACT_BYTES = 64 * 1024;
export const MAX_TASK_ARTIFACT_TEXT_BYTES = 56 * 1024;
export const MAX_TASK_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_EXECUTION_GRANT_TTL_MS = 5 * 60 * 1_000;

/**
 * These states intentionally mirror the A2A Task lifecycle vocabulary. Local
 * user approval is represented separately and must not create another network
 * task state machine.
 */
export type CollaborationTaskState =
  | "unknown"
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export type CollaborationExecutionMode = "single_stage" | "long_horizon";

export type TaskApprovalState =
  | "pending"
  | "approved_once"
  | "rejected"
  | "expired"
  | "consumed";

export interface TaskTextPart {
  kind: "text";
  text: string;
}

export type TaskImageMimeType = "image/jpeg" | "image/png";

/**
 * Network-safe image metadata. Image bytes and local paths are deliberately
 * carried outside the JSON Application Envelope by Chatmail file messages.
 */
export interface TaskImagePart {
  kind: "image";
  attachmentId: string;
  mimeType: TaskImageMimeType;
  byteLength: number;
  width: number;
  height: number;
  sha256: string;
}

export interface TaskMultipartInput {
  kind: "parts";
  parts: [TaskTextPart, ...Array<TaskTextPart | TaskImagePart>];
}

export type CollaborationTaskInput = TaskTextPart | TaskMultipartInput;

/**
 * Beta 0.2 planning boundary: the requester selects an advertised offer and
 * Capability and an abstract Workspace request, never a local executable,
 * Adapter, path, command, or host filesystem location.
 */
export interface CollaborationTaskRequest {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  offerId: string;
  capabilityId: string;
  input: CollaborationTaskInput;
  workspace?: TaskWorkspaceRequest;
  /** Required by Task v6+. Older schemas are parsed only for local rejection. */
  executionMode?: CollaborationExecutionMode;
  createdAt: string;
  expiresAt: string;
}

export interface TaskTextArtifact {
  schemaVersion: 1;
  taskId: string;
  artifactId: string;
  kind: "text";
  text: string;
  createdAt: string;
}

export interface TaskArtifactV2 {
  schemaVersion: 2;
  taskId: string;
  artifactId: string;
  parts: Array<TaskTextPart | TaskImagePart>;
  createdAt: string;
}

export type CollaborationTaskArtifact = TaskTextArtifact | TaskArtifactV2;

/**
 * An Execution Grant is local-only, short-lived, single-use, and bound to the
 * exact approved task input. It is not part of Passport or a Chatmail payload.
 */
export interface ExecutionGrant {
  schemaVersion: 2;
  grantId: string;
  taskId: string;
  requesterTetiId: string;
  capabilityId: string;
  agentId: string;
  adapterId: string;
  inputDigest: string;
  issuedAt: string;
  expiresAt: string;
  singleUse: true;
  workspaceId: string;
  workspaceRevision: number;
  workspaceAccess: WorkspaceAccess[];
  userFileAccess: "none";
  commandPolicy: "fixed_adapter_entrypoint";
  networkPolicy: "agent_managed";
}

export interface CollaborationTaskSnapshot {
  schemaVersion: 1;
  request: CollaborationTaskRequest;
  state: CollaborationTaskState;
  approval: TaskApprovalState;
  artifacts: CollaborationTaskArtifact[];
  updatedAt: string;
  safeErrorCode?: string;
}

export function taskInputText(input: CollaborationTaskInput): string {
  return input.kind === "text"
    ? input.text
    : input.parts.find((part): part is TaskTextPart => part.kind === "text")?.text ?? "";
}

export function taskInputImages(input: CollaborationTaskInput): TaskImagePart[] {
  return input.kind === "text"
    ? []
    : input.parts.filter((part): part is TaskImagePart => part.kind === "image");
}

export function taskArtifactImages(artifact: CollaborationTaskArtifact): TaskImagePart[] {
  return artifact.schemaVersion === 1
    ? []
    : artifact.parts.filter((part): part is TaskImagePart => part.kind === "image");
}
