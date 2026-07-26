import type { AiStatusSyncPayload } from "../ai-status/types.ts";
import type { CollaborationTaskRequest } from "../task/types.ts";
import type {
  TetiTaskArtifactPayload,
  TetiTaskAttachmentPayload,
  TetiTaskCancelPayload,
  TetiTaskReceiptPayload,
  TetiTaskStatusPayload
} from "../task/transport.ts";

export const TETI_APPLICATION_PROTOCOL_VERSION = 1;

export type TetiApplicationMessageType =
  | "teti.profile.sync"
  | "teti.capability.offer"
  | "teti.presence"
  | "teti.ai.status.sync"
  | "teti.task.request"
  | "teti.task.receipt"
  | "teti.task.attachment"
  | "teti.task.status"
  | "teti.task.cancel"
  | "teti.task.artifact";

export interface TetiApplicationEnvelope<TPayload = unknown> {
  version: 1;
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
  /** Optional for compatibility with pre-0.1.11 peers. */
  taskProtocolVersions?: number[];
}

export type TetiKnownApplicationEnvelope =
  | TetiApplicationEnvelope<TetiProfileSyncPayload>
  | TetiApplicationEnvelope<TetiCapabilityOfferPayload>
  | TetiApplicationEnvelope<TetiPresencePayload>
  | TetiApplicationEnvelope<AiStatusSyncPayload>
  | TetiApplicationEnvelope<CollaborationTaskRequest>
  | TetiApplicationEnvelope<TetiTaskReceiptPayload>
  | TetiApplicationEnvelope<TetiTaskAttachmentPayload>
  | TetiApplicationEnvelope<TetiTaskStatusPayload>
  | TetiApplicationEnvelope<TetiTaskCancelPayload>
  | TetiApplicationEnvelope<TetiTaskArtifactPayload>;

export interface TetiProcessedMessageStore {
  version: 1;
  messageIds: string[];
}
