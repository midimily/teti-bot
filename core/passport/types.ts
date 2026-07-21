export const TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION = 1;
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

export type AiAgentType = "cli" | "desktop" | "local_service";
export type AiAgentInstallationStatus = "installed" | "not_installed" | "unknown";
export type AiAgentDetectionSource = "command" | "application";

export interface AiAgent {
  id: string;
  name: string;
  type: AiAgentType;
  installationStatus: AiAgentInstallationStatus;
  detectionSource?: AiAgentDetectionSource;
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

export interface TetiCapabilityPassport {
  schemaVersion: 1;
  generatedAt: string;
  resources: AiResource[];
  agents: AiAgent[];
  capabilities: TetiCapability[];
  bindings: CapabilityBinding[];
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
