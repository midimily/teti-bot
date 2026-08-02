import type { AiStatusSyncPayload } from "../ai-status/types.ts";
import type { CollaborationTaskRequest } from "../task/types.ts";
import type {
  TetiTaskArtifactPayload,
  TetiTaskAttachmentReceiptPayload,
  TetiTaskAttachmentPayload,
  TetiTaskCancelPayload,
  TetiTaskInputPayload,
  TetiTaskReceiptPayload,
  TetiTaskStatusPayload
} from "../task/transport.ts";

export const TETI_COLLABORATION_PROTOCOL_EPOCH = 2;
export const TETI_APPLICATION_PROTOCOL_VERSION = 2;
export const MAX_TETI_APPLICATION_ENVELOPE_BYTES = 128 * 1024;
export const MAX_TETI_APPLICATION_MESSAGE_ID_BYTES = 128;
export const MAX_TETI_APPLICATION_TIMESTAMP_BYTES = 64;

export type TetiApplicationMessageType =
  | "teti.profile.sync"
  | "teti.capability.offer"
  | "teti.presence"
  | "teti.ai.status.sync"
  | "teti.task.request"
  | "teti.task.receipt"
  | "teti.task.attachment"
  | "teti.task.attachment.receipt"
  | "teti.task.status"
  | "teti.task.cancel"
  | "teti.task.input"
  | "teti.task.artifact";

export interface TetiApplicationEnvelope<TPayload = unknown> {
  version: 2;
  type: TetiApplicationMessageType;
  messageId: string;
  fromTetiId: string;
  createdAt: string;
  payload: TPayload;
}

export interface TetiProfileSyncPayload {
  displayName?: string;
  platform: string;
  aiEnvironment: string[];
}

export interface TetiCapabilityOfferPayload {
  capabilities: string[];
}

export interface TetiPresencePayload {
  status: string;
  timestamp: string;
  collaborationProtocolEpoch: 2;
  taskProtocolVersions: [6];
  /** Explicit Passport capability; independent from the latest shared snapshot. */
  passportSchemaVersions: [4];
}

export type TetiKnownApplicationEnvelope =
  | TetiApplicationEnvelope<TetiProfileSyncPayload>
  | TetiApplicationEnvelope<TetiCapabilityOfferPayload>
  | TetiApplicationEnvelope<TetiPresencePayload>
  | TetiApplicationEnvelope<AiStatusSyncPayload>
  | TetiApplicationEnvelope<CollaborationTaskRequest>
  | TetiApplicationEnvelope<TetiTaskReceiptPayload>
  | TetiApplicationEnvelope<TetiTaskAttachmentPayload>
  | TetiApplicationEnvelope<TetiTaskAttachmentReceiptPayload>
  | TetiApplicationEnvelope<TetiTaskStatusPayload>
  | TetiApplicationEnvelope<TetiTaskCancelPayload>
  | TetiApplicationEnvelope<TetiTaskInputPayload>
  | TetiApplicationEnvelope<TetiTaskArtifactPayload>;

export interface TetiProcessedMessageStore {
  version: 2;
  messageIds: string[];
}
