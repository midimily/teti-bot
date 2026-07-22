import type { TetiConnectionDirection, TetiConnectionState } from "../connection/types.ts";
import type {
  AiResource,
  PassportSharingPolicy,
  TetiCapabilityPassport
} from "./types.ts";

export const RUNTIME_PASSPORT_SNAPSHOT_SCHEMA_VERSION = 1;

export interface PassportIdentity {
  tetiId: string;
  address: string;
  displayName?: string;
}

export type RemotePassportState = "fresh" | "stale" | "disabled" | "unknown";

export interface RemotePassportSnapshot {
  state: RemotePassportState;
  resources: AiResource[];
  generatedAt?: string;
  expiresAt?: string;
  receivedAt?: string;
}

/**
 * Presentation-neutral connection projection owned by Runtime. Command fields
 * stay available for explicit accept/reject operations, while remote Passport
 * data is no longer exposed as a legacy AI-status DTO.
 */
export interface PassportConnectionSnapshot {
  requestId: string;
  connectionState: TetiConnectionState;
  direction: TetiConnectionDirection;
  identity: PassportIdentity;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  lastSeen: string | null;
  passport: RemotePassportSnapshot;
}

/**
 * The single Runtime-owned read model consumed by Desktop. `revision` and
 * `generatedAt` change only when the underlying content changes.
 */
export interface RuntimePassportSnapshot {
  schemaVersion: 1;
  revision: number;
  generatedAt: string;
  identity: PassportIdentity | null;
  localPassport: TetiCapabilityPassport;
  connections: PassportConnectionSnapshot[];
  sharing: PassportSharingPolicy;
}
