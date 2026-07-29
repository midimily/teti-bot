export const TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION = 3;
export const TETI_PASSPORT_SHARING_POLICY_VERSION = 1;

export type TetiAvailability = "available" | "unavailable" | "stale" | "unknown";

export type AiResourceKind = "subscription" | "account" | "local_model" | "compute";
export type AiResourceAssurance = "provider_observed" | "local_observed" | "self_declared";
export type AiResourceQuotaIdentification = "exact" | "inferred";

export interface AiResourcePlan {
  key: string | null;
  displayName: string | null;
}

export interface AiResourceQuota {
  period: string;
  remainingPercent: number;
  resetAt: string | null;
  windowSeconds: number | null;
  identification: AiResourceQuotaIdentification;
}

export interface AiResource {
  id: string;
  provider: string;
  product: string;
  kind: AiResourceKind;
  plan?: AiResourcePlan;
  availability: TetiAvailability;
  quotas: AiResourceQuota[];
  assurance: AiResourceAssurance;
  observedAt: string;
  expiresAt?: string;
}

export type AiAgentType = "cli" | "desktop" | "ide_extension" | "local_service";
export type AiAgentInstallationStatus = "installed" | "not_installed" | "unknown";
export type AiAgentDetectionSource = "command" | "application" | "process";
export type AiAgentRuntimeStatus = "running" | "not_running" | "unknown";

export interface AiAgent {
  id: string;
  name: string;
  provider?: string;
  type: AiAgentType;
  surfaces?: AiAgentType[];
  installationStatus: AiAgentInstallationStatus;
  detectionSource?: AiAgentDetectionSource;
  version?: string;
  runtimeStatus?: AiAgentRuntimeStatus;
  processCount?: number;
  confidence?: "low" | "medium" | "high";
  lastSeenAt?: string;
  observedAt: string;
}

/**
 * The Agent shape exposed by Callable Passport v2. Observation details such as
 * process state, executable path, command, version and installation evidence
 * deliberately do not cross this boundary. An entry exists only while a
 * locally qualified Adapter is registered in Runtime.
 */
export interface CallablePassportAgent {
  id: string;
  name: string;
  provider: string;
  capabilityIds: string[];
  inputModes: Array<"text" | "image">;
  outputModes: Array<"text" | "image">;
  availability: TetiAvailability;
  observedAt: string;
}

export interface TetiCapability {
  id: string;
  name: string;
  category: string;
  description: string;
  availability: TetiAvailability;
  observedAt: string;
}

/**
 * A binding is the relationship used by the deterministic capability resolver.
 * Every referenced agent and resource is required; this is deliberately not a
 * general-purpose rule or inference language.
 */
export interface CapabilityBinding {
  capabilityId: string;
  agentIds: string[];
  resourceIds: string[];
}

/**
 * Privacy-minimized compute advertisement. It intentionally carries no local
 * model identifier, Runtime endpoint, hardware detail, credential, path, or
 * Connector binding. The receiver resolves the offer to local resources only
 * after an explicit one-task approval.
 */
export interface ComputeOffer {
  offerId: string;
  capability: "general-text-assistance";
  resourceClass: "local_model" | "native_agent";
  executionLocation: "receiver_local";
  inputModes: readonly ["text"];
  outputModes: readonly ["text"];
  concurrency: 1;
  approval: "allow_once";
  observedAt: string;
}

export interface TetiCapabilityPassport {
  schemaVersion: 3;
  generatedAt: string;
  resources: AiResource[];
  agents: CallablePassportAgent[];
  capabilities: TetiCapability[];
  bindings: CapabilityBinding[];
  computeOffers: ComputeOffer[];
}

/**
 * Beta 1.0 has one field-level policy for every confirmed peer. Per-peer and
 * execution permissions are explicitly outside this schema.
 */
export interface PassportSharingPolicy {
  version: 1;
  audience: "confirmed_peers";
  resourceSummary: boolean;
  resourceQuota: boolean;
  agents: boolean;
  capabilities: boolean;
}

export const DEFAULT_PASSPORT_SHARING_POLICY: Readonly<PassportSharingPolicy> = Object.freeze({
  version: TETI_PASSPORT_SHARING_POLICY_VERSION,
  audience: "confirmed_peers",
  resourceSummary: false,
  resourceQuota: false,
  agents: false,
  capabilities: false
});
