import type { TetiConnectionDirection, TetiConnectionState } from "../connection/types.ts";
import type { RegistryStatus } from "../account/model.ts";
import type {
  AiAgent,
  AiResource,
  CallablePassportAgent,
  CapabilityBinding,
  ComputeOffer,
  PassportSharingPolicy,
  TetiCapability,
  TetiCapabilityPassport
} from "./types.ts";

export const RUNTIME_PASSPORT_SNAPSHOT_SCHEMA_VERSION = 2;

export interface PassportIdentity {
  tetiId: string;
  address: string;
  displayName?: string;
}

export type RemotePassportState = "fresh" | "stale" | "disabled" | "unknown";
export type PeerCompatibility = "compatible" | "upgrade_required" | "unknown";

export type NetworkPeerPresenceSnapshot =
  | { state: "checking" }
  | {
      state: "online";
      mode: "collaborating" | "viewing_connect" | "online" | "background";
      reportedAt: string;
      observedAt: string;
      expiresAt: string;
    }
  | { state: "offline"; observedAt: string }
  | { state: "unavailable"; checkedAt: string; errorCode: string };

export interface RemotePassportSnapshot {
  state: RemotePassportState;
  resources: AiResource[];
  agents: Array<AiAgent | CallablePassportAgent>;
  capabilities: TetiCapability[];
  bindings: CapabilityBinding[];
  computeOffers: ComputeOffer[];
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
  networkPresence?: NetworkPeerPresenceSnapshot;
  compatibility: PeerCompatibility;
  passport: RemotePassportSnapshot;
}

/**
 * The single Runtime-owned read model consumed by Desktop. `revision` and
 * `generatedAt` change only when the underlying content changes.
 */
export interface RuntimePassportSnapshot {
  schemaVersion: 2;
  revision: number;
  generatedAt: string;
  identity: PassportIdentity | null;
  registry: RegistryStatus;
  localPassport: TetiCapabilityPassport;
  connections: PassportConnectionSnapshot[];
  sharing: PassportSharingPolicy;
}
