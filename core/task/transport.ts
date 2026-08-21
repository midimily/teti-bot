import type {
  CollaborationTaskArtifact,
  CollaborationTaskRequest,
  CollaborationTaskState,
  TaskImagePart,
  TaskApprovalState
} from "./types.ts";
import type {
  TaskWorkspaceBinding,
  TaskWorkspaceRequest
} from "../workspace/types.ts";
import type { ExecutionProgress } from "../callability/execution.ts";
import type { DelegationPlanState } from "../delegation/types.ts";

export const TETI_TASK_TRANSPORT_SCHEMA_VERSION = 1;
export const TETI_TASK_TRANSPORT_STORE_SCHEMA_VERSION = 5;
export const TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS = [7] as const;
export const DEFAULT_TASK_REQUEST_TTL_MS = 60 * 60 * 1_000;
export const MAX_TASK_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MAX_TASK_PROTOCOL_VERSIONS = 8;
export const MAX_TASK_TRANSPORT_RECORDS = 512;

export type TetiTaskProtocolVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const LONG_HORIZON_LIMITS = {
  maximumStages: 16,
  maximumArtifacts: 32,
  maximumAuditEvents: 256,
  /** Supplemental instructions after the initial stage. */
  maximumInputs: 15,
  maximumInstructionBytes: 8 * 1024,
  maximumRenewals: 8,
  maximumRenewalMs: 24 * 60 * 60 * 1_000,
  maximumLifetimeMs: 7 * 24 * 60 * 60 * 1_000
} as const;

export type LongHorizonPhase =
  | "pending_approval"
  | "working"
  | "input_required"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "expired";

export type LongHorizonStageState =
  | "queued"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export interface LongHorizonChildTarget {
  childAgentId: string;
  connectorId: string;
}

export interface LongHorizonStage {
  stageId: string;
  stageIndex: number;
  executionTaskId: string;
  childAgentId: string;
  connectorId: string;
  state: LongHorizonStageState;
  workspaceRevision: number;
  workspaceMutation: "none" | "snapshot_commit";
  inputId: string | null;
  instructionDigest: string;
  progress: ExecutionProgress;
  artifactIds: string[];
  checkpointAvailable: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  safeErrorCode?: string;
}

export interface LongHorizonInput {
  inputId: string;
  instruction: string;
  instructionDigest: string;
  source: "remote_requester" | "local_user";
  createdAt: string;
  consumedAt?: string;
}

export interface LongHorizonInputRequest {
  requestId: string;
  prompt: string;
  createdAt: string;
}

export interface LongHorizonCheckpoint {
  checkpointId: string;
  stageIndex: number;
  workspaceRevision: number;
  artifactIds: string[];
  digest: string;
  createdAt: string;
}

export interface LongHorizonArtifactEntry {
  artifactId: string;
  stageIndex: number;
  role: "intermediate" | "final";
  createdAt: string;
}

export interface LongHorizonAuditEvent {
  eventId: string;
  sequence: number;
  action:
    | "session_created"
    | "stage_started"
    | "progress_updated"
    | "artifact_published"
    | "checkpoint_created"
    | "input_requested"
    | "input_received"
    | "pause_requested"
    | "paused"
    | "resumed"
    | "child_selected"
    | "stage_failed"
    | "renewed"
    | "completed"
    | "canceled"
    | "expired"
    | "restart_reconciled";
  actor: "host" | "local_user" | "remote_peer" | "child_agent";
  stageIndex: number | null;
  timestamp: string;
  childAgentId?: string;
  artifactId?: string;
  inputId?: string;
  workspaceRevision?: number;
  safeErrorCode?: string;
}

/** Receiver-local durable orchestration record; instructions never enter Passport. */
export interface LongHorizonTaskState {
  schemaVersion: 1;
  phase: LongHorizonPhase;
  currentStageIndex: number;
  workspaceRevision: number;
  progress: ExecutionProgress;
  continuationExpiresAt: string;
  renewalCount: number;
  pauseRequested: boolean;
  pendingInput: LongHorizonInput | null;
  inputRequest: LongHorizonInputRequest | null;
  availableChildAgents: LongHorizonChildTarget[];
  stages: LongHorizonStage[];
  checkpoints: LongHorizonCheckpoint[];
  artifacts: LongHorizonArtifactEntry[];
  audit: LongHorizonAuditEvent[];
  updatedAt: string;
}

/** Privacy-minimized peer projection. Audit and Child bindings stay receiver-local. */
export interface TetiTaskLongHorizonStatus {
  schemaVersion: 1;
  phase: Exclude<LongHorizonPhase, "pending_approval">;
  currentStageIndex: number;
  workspaceRevision: number;
  completedUnits: number | null;
  totalUnits: number | null;
  progressMessage: string | null;
  continuationExpiresAt: string;
  inputRequestId?: string;
  finalArtifactId?: string;
}

export type TetiTaskReceiptStatus =
  | "received"
  | "duplicate"
  | "expired"
  | "conflict"
  | "rejected";

/**
 * A transport receipt confirms durable ingestion, not user approval and not
 * Agent execution. Approval remains a separate explicit local action in Beta
 * 0.1.12 and is never implied by this receipt.
 */
export interface TetiTaskReceiptPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  status: TetiTaskReceiptStatus;
  receivedAt: string;
  supportedTaskVersions: number[];
}

export type TetiTaskAttachmentPurpose = "input" | "artifact";

/**
 * The descriptor travels in the Application Envelope while the bytes travel as
 * the file attached to that same Chatmail message.
 */
export interface TetiTaskAttachmentPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  purpose: TetiTaskAttachmentPurpose;
  artifactId?: string;
  part: TaskImagePart;
  createdAt: string;
  expiresAt: string;
  /** Task v4+ requests a durable per-attachment receipt. Omitted by v1-v3. */
  deliveryReceiptRequested?: true;
}

/**
 * Task v4+ end-to-end delivery receipt. The receiver sends this only after the
 * attachment bytes have been validated and durably copied into the local Task
 * store. Chatmail queueing or download completion alone is not an ACK.
 */
export interface TetiTaskAttachmentReceiptPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  purpose: TetiTaskAttachmentPurpose;
  artifactId?: string;
  attachmentId: string;
  receivedAt: string;
}

export interface TaskAttachmentDeliveryAttempt {
  attachmentId: string;
  attempts: number;
  lastSentAt: string;
  nextRetryAt: string;
}

export type TaskAttachmentDiagnosticState =
  | "expected"
  | "sent"
  | "stored"
  | "acknowledged"
  | "expired"
  | "failed";

/** Local-only delivery evidence. It never crosses the Application Envelope. */
export interface TaskAttachmentDiagnostic {
  attachmentId: string;
  purpose: TetiTaskAttachmentPurpose;
  ordinal: number;
  expectedCount: number;
  byteLength: number;
  sha256: string;
  attempts: number;
  state: TaskAttachmentDiagnosticState;
  firstSentAt?: string;
  lastSentAt?: string;
  storedAt?: string;
  receiptReceivedAt?: string;
  safeErrorCode?: string;
}

export interface TetiTaskStatusPayload {
  schemaVersion: 1 | 2;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  revision: number;
  state: Exclude<CollaborationTaskState, "unknown" | "submitted">;
  updatedAt: string;
  safeErrorCode?: string;
  longHorizon?: TetiTaskLongHorizonStatus;
}

export interface TetiTaskInputPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  inputId: string;
  expectedStageIndex: number;
  instruction: string;
  createdAt: string;
}

export interface TetiTaskCancelPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  requestedAt: string;
}

export interface TetiTaskArtifactPayload {
  schemaVersion: 1 | 2;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  artifact: CollaborationTaskArtifact;
  createdAt: string;
  stageIndex?: number;
  role?: "intermediate" | "final";
}

/**
 * Task v7 moves every Artifact document into a Chatmail file attachment. The
 * caption stays comfortably below Delta Chat's text normalization boundary;
 * the receiver verifies the immutable byte length and digest before parsing.
 */
export interface TetiTaskArtifactFilePayload {
  schemaVersion: 1 | 2;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  artifactId: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  deliveryReceiptRequested: true;
  stageIndex?: number;
  role?: "intermediate" | "final";
}

/** Application-level proof that an Artifact was validated and durably stored. */
export interface TetiTaskArtifactReceiptPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  artifactId: string;
  sha256: string;
  receivedAt: string;
}

export interface TaskArtifactDeliveryAttempt {
  artifactId: string;
  attempts: number;
  lastSentAt: string;
  nextRetryAt: string;
}

export interface SendCollaborationTaskInput {
  connectionRequestId: string;
  taskId?: string;
  offerId?: string;
  capabilityId: string;
  text: string;
  attachments?: TaskImagePart[];
  workspace?: TaskWorkspaceRequest;
  ttlMs?: number;
  executionMode?: "single_stage" | "long_horizon";
}

export type TaskTransportDirection = "incoming" | "outgoing";
export type TaskDeliveryState =
  | "queued"
  | "sent"
  | "send_failed"
  | "received"
  | "acknowledged"
  | "expired"
  | "conflict"
  | "rejected";

/**
 * Local transport read model. It deliberately contains no Adapter, command,
 * host path, Workspace Snapshot path, prompt transcript, credential, or
 * execution grant. The optional Workspace binding is local-only metadata.
 */
export interface CollaborationTaskTransportRecord {
  schemaVersion: 1;
  direction: TaskTransportDirection;
  peerTetiId: string;
  protocolVersion: TetiTaskProtocolVersion;
  envelopeMessageId?: string;
  chatmailMessageId?: number;
  sentAttachmentIds?: string[];
  sentArtifactAttachmentIds?: string[];
  acknowledgedAttachmentIds?: string[];
  acknowledgedArtifactAttachmentIds?: string[];
  attachmentDeliveryAttempts?: TaskAttachmentDeliveryAttempt[];
  artifactAttachmentDeliveryAttempts?: TaskAttachmentDeliveryAttempt[];
  attachmentDiagnostics?: TaskAttachmentDiagnostic[];
  workspaceBinding?: TaskWorkspaceBinding;
  request: CollaborationTaskRequest;
  state: CollaborationTaskState;
  approval: TaskApprovalState;
  delivery: TaskDeliveryState;
  createdAt: string;
  updatedAt: string;
  receipt?: TetiTaskReceiptPayload;
  receiptPending?: boolean;
  statusRevision?: number;
  statusPending?: boolean;
  cancelPending?: boolean;
  cancelSentAt?: string;
  artifactPending?: boolean;
  sentArtifactIds?: string[];
  acknowledgedArtifactIds?: string[];
  artifactDeliveryAttempts?: TaskArtifactDeliveryAttempt[];
  artifactAttachmentsReady?: boolean;
  attachmentsReady?: boolean;
  artifacts?: CollaborationTaskArtifact[];
  longHorizon?: LongHorizonTaskState;
  /** Receiver-local deterministic Host delegation; never enters Task or Passport. */
  delegationPlan?: DelegationPlanState;
  /** Requester-local projection received from the Host; never contains Child bindings or audit. */
  peerLongHorizon?: TetiTaskLongHorizonStatus;
  /** Requester-local stage labels for append-only Artifacts; safe under message reordering. */
  peerArtifactMetadata?: LongHorizonArtifactEntry[];
  inputPending?: TetiTaskInputPayload;
  inputSentAt?: string;
  /** Local-only read marker; never enters Task, Passport, Chatmail, or Connector input. */
  viewedStageResultIndex?: number;
  safeErrorCode?: string;
}

export interface CollaborationTaskSummary {
  taskId: string;
  direction: TaskTransportDirection;
  peerTetiId: string;
  connectionRequestId?: string;
  capabilityId: string;
  executionMode: "single_stage" | "long_horizon";
  currentStageIndex: number | null;
  textPreview: string;
  imageCount: number;
  receivedImageCount: number;
  artifactCount: number;
  state: CollaborationTaskState;
  approval: TaskApprovalState;
  delivery: TaskDeliveryState;
  attachmentsReady: boolean;
  cancelPending: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  hasUnreadStageResult?: boolean;
  safeErrorCode?: string;
}

export interface CollaborationTaskSummarySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  pendingIncomingCount: number;
  unreadStageResultCount?: number;
  tasks: CollaborationTaskSummary[];
}

export interface TetiTaskPeerProtocolCapability {
  tetiId: string;
  supportedVersions: number[];
  observedAt: string;
}

export interface CollaborationTaskTransportSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  records: CollaborationTaskTransportRecord[];
  peers: TetiTaskPeerProtocolCapability[];
}

export interface TetiTaskTransportStoreState {
  schemaVersion: 5;
  records: CollaborationTaskTransportRecord[];
  peers: TetiTaskPeerProtocolCapability[];
}

export function latestAvailableLongHorizonStageResultIndex(
  record: CollaborationTaskTransportRecord
): number {
  if (record.request.executionMode !== "long_horizon") return 0;
  const availableArtifactIds = new Set((record.artifacts ?? []).map((artifact) => artifact.artifactId));
  const entries = record.direction === "incoming"
    ? record.longHorizon?.artifacts ?? []
    : record.peerArtifactMetadata ?? [];
  return entries.reduce((latest, entry) =>
    availableArtifactIds.has(entry.artifactId) ? Math.max(latest, entry.stageIndex) : latest, 0
  );
}
