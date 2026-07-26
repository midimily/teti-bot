import type {
  CallablePassportAgent,
  CapabilityBinding,
  TetiCapability
} from "../passport/types.ts";

export const TETI_AI_STATUS_LEGACY_SCHEMA_VERSION = 1;
export const TETI_AI_STATUS_AGENT_SCHEMA_VERSION = 2;
export const TETI_AI_STATUS_SCHEMA_VERSION = 3;

export type AiToolStatusKind = "ready" | "stale" | "unavailable";
export type AiQuotaIdentification = "exact" | "inferred";
export type AiStatusSharing = "enabled" | "disabled";

export interface AiToolPlanStatus {
  key: string | null;
  membershipVerified: boolean;
}

export interface AiToolQuotaStatus {
  period: string;
  remainingPercent: number;
  resetAt: string | null;
  windowSeconds: number | null;
  identification: AiQuotaIdentification;
}

export interface AiToolStatusSnapshot {
  toolId: string;
  status: AiToolStatusKind;
  plan: AiToolPlanStatus;
  quotas: AiToolQuotaStatus[];
  observedAt: string;
}

export interface AiAgentStatusSnapshot {
  agentId: string;
  name: string;
  provider: string | null;
  type: "cli" | "desktop" | "ide_extension" | "local_service";
  surfaces: Array<"cli" | "desktop" | "ide_extension" | "local_service">;
  installationStatus: "installed" | "not_installed" | "unknown";
  detectionSource: "command" | "application" | "process" | null;
  version: string | null;
  runtimeStatus: "running" | "not_running" | "unknown";
  processCount: number | null;
  confidence: "low" | "medium" | "high" | null;
  lastSeenAt: string | null;
  observedAt: string;
}

export interface LegacyAiStatusSyncPayload {
  schemaVersion: 1;
  sharing: AiStatusSharing;
  generatedAt: string;
  expiresAt: string;
  tools: AiToolStatusSnapshot[];
}

export interface PassportAiStatusSyncPayload {
  schemaVersion: 2;
  sharing: AiStatusSharing;
  generatedAt: string;
  expiresAt: string;
  tools: AiToolStatusSnapshot[];
  agents: AiAgentStatusSnapshot[];
}

/**
 * Callable Passport uses the existing teti.ai.status.sync envelope. Schema 3
 * replaces coarse Agent observation with only locally qualified, callable
 * Agents and their safe capability catalog.
 */
export interface CallablePassportAiStatusSyncPayload {
  schemaVersion: 3;
  sharing: AiStatusSharing;
  generatedAt: string;
  expiresAt: string;
  tools: AiToolStatusSnapshot[];
  agents: CallablePassportAgent[];
  capabilities: TetiCapability[];
  bindings: CapabilityBinding[];
}

export type AiStatusSyncPayload =
  | LegacyAiStatusSyncPayload
  | PassportAiStatusSyncPayload
  | CallablePassportAiStatusSyncPayload;

export type RemoteAiStatusSnapshot = AiStatusSyncPayload & {
  receivedAt: string;
};

export interface AiStatusSharingSettings {
  statusSharing: boolean;
}
