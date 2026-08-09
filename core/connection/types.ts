import type { TetiPublicProfile } from "../account/model.ts";

export const TETI_CONNECTION_VERSION = 1;

export const TetiConnectionState = {
  Requested: "Requested",
  PendingApproval: "PendingApproval",
  Accepted: "Accepted",
  Confirmed: "Confirmed",
  Rejected: "Rejected",
  Blocked: "Blocked"
} as const;

export type TetiConnectionState =
  (typeof TetiConnectionState)[keyof typeof TetiConnectionState];

export type TetiConnectionDirection = "incoming" | "outgoing";

export interface TetiConnectionRequest {
  version: 1;
  requestId: string;
  fromTetiId: string;
  fromAddress: string;
  publicKey?: string;
  profile: TetiPublicProfile;
  createdAt: string;
  nonce: string;
}

export interface TetiConnectionAccept {
  version: 1;
  requestId: string;
  fromTetiId: string;
  fromAddress: string;
  createdAt: string;
  nonce: string;
}

export interface TetiConnectionReject {
  requestId: string;
  reason?: string;
}

export interface TetiConnectionRecord {
  version: 1;
  requestId: string;
  state: TetiConnectionState;
  direction: TetiConnectionDirection;
  remoteTetiId: string;
  remoteAddress: string;
  request: TetiConnectionRequest;
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  rejectedAt?: string;
  confirmedAt?: string;
  /** Network is authoritative; the enclosing record remains the local Chatmail recovery projection. */
  networkRelationship?: {
    schemaVersion: 1;
    id: string;
    revision: number;
    state: "requested" | "confirmed" | "rejected" | "blocked" | "revoked";
    etag: `"relationship-r${number}"`;
    blockedBy: "self" | "peer" | null;
    stateChangedAt: string;
  };
}

export interface TetiConnectionStore {
  version: 1;
  connections: TetiConnectionRecord[];
}

export function isTetiConnectionArchived(connection: TetiConnectionRecord): boolean {
  return connection.networkRelationship?.state === "revoked";
}

export function isTetiConnectionConfirmed(connection: TetiConnectionRecord): boolean {
  return connection.state === TetiConnectionState.Confirmed
    && !isTetiConnectionArchived(connection);
}

export type TetiConnectionEnvelopeType =
  | "teti.connection.request"
  | "teti.connection.accept"
  | "teti.connection.reject"
  | "teti.profile.update";

export interface TetiConnectionEnvelope<TPayload = unknown> {
  type: TetiConnectionEnvelopeType;
  version: 1;
  payload: TPayload;
}
