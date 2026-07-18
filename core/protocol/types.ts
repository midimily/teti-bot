import type { AiStatusSyncPayload } from "../ai-status/types.ts";

export const TETI_APPLICATION_PROTOCOL_VERSION = 1;

export type TetiApplicationMessageType =
  | "teti.profile.sync"
  | "teti.capability.offer"
  | "teti.presence"
  | "teti.ai.status.sync";

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
}

export type TetiKnownApplicationEnvelope =
  | TetiApplicationEnvelope<TetiProfileSyncPayload>
  | TetiApplicationEnvelope<TetiCapabilityOfferPayload>
  | TetiApplicationEnvelope<TetiPresencePayload>
  | TetiApplicationEnvelope<AiStatusSyncPayload>;

export interface TetiProcessedMessageStore {
  version: 1;
  messageIds: string[];
}
