export const TETI_OBSERVATION_SCHEMA_VERSION = 1;
export const TETI_EXPOSURE_POLICY_VERSION = 1;

export type ObservationConfidence = "low" | "medium" | "high";
export type ObservationAssurance =
  | "inferred"
  | "locally_observed"
  | "provider_observed"
  | "provider_verified";
export type ObservationSource =
  | "filesystem"
  | "app_bundle"
  | "executable"
  | "process"
  | "official_hook"
  | "official_sdk"
  | "agent_declared"
  | "provider_api"
  | "provider_observed"
  | "user_declared";

export interface ObservationEvidence {
  source: ObservationSource;
  confidence: ObservationConfidence;
  assurance: ObservationAssurance;
  adapterId: string;
  adapterRevision: number;
  observedAt: string;
  expiresAt?: string;
}

export type AgentSurface = "cli" | "desktop" | "ide_extension" | "local_service";
export type AgentInstallationState = "installed" | "not_installed" | "unknown";
export type AgentRuntimeState = "running" | "not_running" | "unknown";
export type AgentActivityState =
  | "idle"
  | "active"
  | "waiting_approval"
  | "completed"
  | "error"
  | "unknown";

export interface AgentInstallationObservation {
  state: AgentInstallationState;
  version?: string;
  evidence: ObservationEvidence[];
}

export interface AgentRuntimeObservation {
  state: AgentRuntimeState;
  processCount?: number;
  lastSeenAt?: string;
  evidence: ObservationEvidence[];
}

export interface AgentActivityObservation {
  state: AgentActivityState;
  sessionCount?: number;
  model?: string;
  since?: string;
  evidence: ObservationEvidence[];
}

export interface ObservationSafeError {
  code: string;
  recoverable: boolean;
}

/**
 * An Agent observation is intentionally sparse. Unsupported levels are absent;
 * an `unknown` value means the level is supported but this observation could
 * not establish a reliable value.
 */
export interface AgentObservation {
  schemaVersion: 1;
  observationId: string;
  agentId: string;
  provider: string;
  displayName: string;
  surfaces: AgentSurface[];
  supportedLevels: Array<1 | 2 | 3>;
  installation?: AgentInstallationObservation;
  runtime?: AgentRuntimeObservation;
  activity?: AgentActivityObservation;
  observedAt: string;
  errors: ObservationSafeError[];
}

export type AgentObservationSnapshotState =
  | "idle"
  | "discovering"
  | "ready"
  | "degraded"
  | "disabled";

export interface AgentObservationSnapshot {
  schemaVersion: 1;
  revision: number;
  state: AgentObservationSnapshotState;
  generatedAt: string;
  startedAt?: string;
  completedAt?: string;
  agents: AgentObservation[];
  errors: ObservationSafeError[];
}

export type ResourceAvailability = "available" | "unavailable" | "stale" | "unknown";
export type ResourceBillingModel = "subscription" | "api" | "local" | "unknown";
export type ResourceLoginState = "signed_in" | "signed_out" | "unknown";

export interface EntitlementObservation {
  planKey: string | null;
  displayName: string | null;
  billingModel: ResourceBillingModel;
  loginState: ResourceLoginState;
  evidence: ObservationEvidence[];
}

export interface QuotaObservation {
  period: string;
  remainingPercent: number | null;
  resetAt: string | null;
  windowSeconds: number | null;
  identification: "exact" | "inferred" | "unknown";
  evidence: ObservationEvidence[];
}

export interface ResourceObservation {
  schemaVersion: 1;
  observationId: string;
  resourceId: string;
  provider: string;
  product: string;
  availability: ResourceAvailability;
  entitlement?: EntitlementObservation;
  quotas: QuotaObservation[];
  observedAt: string;
  expiresAt?: string;
  errors: ObservationSafeError[];
}

/**
 * Discovery, Agent self-reporting, and peer exposure are independent grants.
 * Phase 0 freezes this contract without changing the existing Passport policy.
 */
export interface ExposurePolicy {
  version: 1;
  discoveryEnabled: boolean;
  agentReportingEnabled: boolean;
  audience: "none" | "confirmed_peers" | "selected_peers";
  selectedPeerIds?: string[];
  fields: {
    productName: boolean;
    installation: boolean;
    version: boolean;
    runtime: boolean;
    activity: boolean;
    model: boolean;
    entitlement: boolean;
    quota: boolean;
    resetAt: boolean;
  };
}

export const DEFAULT_EXPOSURE_POLICY: Readonly<ExposurePolicy> = Object.freeze({
  version: TETI_EXPOSURE_POLICY_VERSION,
  discoveryEnabled: true,
  agentReportingEnabled: false,
  audience: "none",
  fields: Object.freeze({
    productName: false,
    installation: false,
    version: false,
    runtime: false,
    activity: false,
    model: false,
    entitlement: false,
    quota: false,
    resetAt: false
  })
});
