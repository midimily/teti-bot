export const TETI_STRUCTURED_MEMORY_RECOVERY_SCHEMA_VERSION = 1;

export const STRUCTURED_MEMORY_STORE_LIMITS = Object.freeze({
  maximumDatabaseBytes: 64 * 1_024 * 1_024,
  warningDatabaseBytes: Math.floor(64 * 1_024 * 1_024 * 0.8),
  walAutoCheckpointPages: 256,
  expiredPreviewRetentionMs: 24 * 60 * 60 * 1_000
});

export type StructuredMemoryMigrationStatus =
  | "created"
  | "current"
  | "migrated"
  | "future_schema_read_only"
  | "integrity_failure_read_only";

export interface StructuredMemoryLocalMetrics {
  candidateCount: number;
  selectedCount: number;
  budgetRejectedCount: number;
  scopeRejectedCount: number;
  deletionSuccessCount: number;
  expirationSuccessCount: number;
  safeErrorCount: number;
}

/**
 * Text-free local health evidence. Paths, Task IDs, Peer IDs, item names and
 * query content are deliberately absent so this object is safe for diagnostics.
 */
export interface StructuredMemoryStoreHealth {
  schemaVersion: 1;
  mode: "ready" | "read_only";
  databaseSchemaVersion: number;
  supportedSchemaVersion: number;
  migrationStatus: StructuredMemoryMigrationStatus;
  integrity: "ok" | "failed" | "unknown";
  foreignKeys: "ok" | "failed" | "unknown";
  journalMode: "wal" | "read_only" | "unknown";
  databaseBytes: number;
  quotaBytes: number;
  quotaStatus: "ok" | "warning" | "exceeded";
  recoveryBackupAvailable: boolean;
  metrics: StructuredMemoryLocalMetrics;
}

export interface StructuredMemoryMaintenanceInput {
  schemaVersion: 1;
  confirmed: true;
  executedAt: string;
}

export interface StructuredMemoryMaintenanceReport {
  schemaVersion: 1;
  executedAt: string;
  expiredItemCount: number;
  expiredPreviewCount: number;
  invalidPreviewCount: number;
  checkpointed: boolean;
  integrity: "ok";
  databaseBytes: number;
  quotaStatus: "ok" | "warning" | "exceeded";
}

export interface StructuredMemoryBackupReport {
  schemaVersion: 1;
  sourceSchemaVersion: number;
  integrity: "ok";
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface StructuredMemoryRestoreReport {
  schemaVersion: 1;
  restoredSchemaVersion: number;
  safetyBackupCreated: boolean;
  integrity: "ok";
  restoredAt: string;
}
