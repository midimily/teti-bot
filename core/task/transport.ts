import type {
  CollaborationTaskArtifact,
  CollaborationTaskRequest,
  CollaborationTaskState,
  TaskImagePart,
  TaskApprovalState
} from "./types.ts";

export const TETI_TASK_TRANSPORT_SCHEMA_VERSION = 1;
export const TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS = [1, 2, 3] as const;
export const DEFAULT_TASK_REQUEST_TTL_MS = 60 * 60 * 1_000;
export const MAX_TASK_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MAX_TASK_PROTOCOL_VERSIONS = 8;
export const MAX_TASK_TRANSPORT_RECORDS = 512;

export type TetiTaskProtocolVersion = 1 | 2 | 3;

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
}

export interface TetiTaskStatusPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  revision: number;
  state: Exclude<CollaborationTaskState, "unknown" | "submitted">;
  updatedAt: string;
  safeErrorCode?: string;
}

export interface TetiTaskCancelPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  requestedAt: string;
}

export interface TetiTaskArtifactPayload {
  schemaVersion: 1;
  taskId: string;
  requesterTetiId: string;
  targetTetiId: string;
  artifact: CollaborationTaskArtifact;
  createdAt: string;
}

export interface SendCollaborationTaskInput {
  connectionRequestId: string;
  taskId?: string;
  offerId?: string;
  capabilityId: string;
  text: string;
  attachments?: TaskImagePart[];
  ttlMs?: number;
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
 * path, workspace, prompt transcript, credential, or execution grant.
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
  artifactAttachmentsReady?: boolean;
  attachmentsReady?: boolean;
  artifacts?: CollaborationTaskArtifact[];
  safeErrorCode?: string;
}

export interface CollaborationTaskSummary {
  taskId: string;
  direction: TaskTransportDirection;
  peerTetiId: string;
  connectionRequestId?: string;
  capabilityId: string;
  textPreview: string;
  imageCount: number;
  artifactCount: number;
  state: CollaborationTaskState;
  approval: TaskApprovalState;
  delivery: TaskDeliveryState;
  attachmentsReady: boolean;
  cancelPending: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  safeErrorCode?: string;
}

export interface CollaborationTaskSummarySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  pendingIncomingCount: number;
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
  schemaVersion: 1;
  records: CollaborationTaskTransportRecord[];
  peers: TetiTaskPeerProtocolCapability[];
}
