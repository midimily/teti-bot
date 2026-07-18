export const TETI_AI_STATUS_SCHEMA_VERSION = 1;

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

export interface AiStatusSyncPayload {
  schemaVersion: 1;
  sharing: AiStatusSharing;
  generatedAt: string;
  expiresAt: string;
  tools: AiToolStatusSnapshot[];
}

export interface RemoteAiStatusSnapshot extends AiStatusSyncPayload {
  receivedAt: string;
}

export interface AiStatusSharingSettings {
  statusSharing: boolean;
}
