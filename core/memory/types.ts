export const TETI_CHILD_MEMORY_SCHEMA_VERSION = 1;

export const CHILD_MEMORY_LIMITS = Object.freeze({
  maximumRecords: 32,
  maximumAuthorizations: 64,
  maximumContentBytes: 4 * 1_024,
  maximumContextRecords: 4,
  maximumContextBytes: 8 * 1_024,
  maximumPreviewCharacters: 240,
  defaultRetentionMs: 90 * 24 * 60 * 60 * 1_000,
  maximumRetentionMs: 365 * 24 * 60 * 60 * 1_000
});

export type MemoryScope = "task" | "workspace" | "child_agent";
export type DurableMemoryScope = Exclude<MemoryScope, "task">;

export interface MemoryProvenance {
  kind: "task_artifact_user_saved";
  actor: "local_user";
  sourceArtifactId: string;
  authorizedAt: string;
}

/** Receiver-local content. It never enters Task, Passport, or Peer messages. */
export interface MemoryRecord {
  schemaVersion: 1;
  memoryId: string;
  scope: MemoryScope;
  workspaceId: string;
  childAgentId: string;
  sourceTaskId: string;
  sourcePeerId: string;
  content: string;
  contentDigest: string;
  createdAt: string;
  expiresAt: string;
  provenance: MemoryProvenance;
}

export interface MemoryAuthorization {
  schemaVersion: 1;
  scope: DurableMemoryScope;
  workspaceId: string | null;
  childAgentId: string;
  authorizedAt: string;
}

export interface MemoryRecordSummary extends Omit<MemoryRecord, "content"> {
  contentPreview: string;
}

export interface ChildMemorySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  records: MemoryRecordSummary[];
  authorizations: MemoryAuthorization[];
}

export interface MemoryContextRecord {
  memoryId: string;
  scope: DurableMemoryScope;
  contentDigest: string;
  content: string;
}

export interface MemoryContextSelection {
  schemaVersion: 1;
  records: MemoryContextRecord[];
  byteLength: number;
}

export interface SelectChildMemoryInput {
  taskId: string;
  workspaceId: string;
  childAgentId: string;
}

export interface ChildMemoryProvider {
  selectContext(input: SelectChildMemoryInput): Promise<MemoryContextSelection>;
}

export interface SaveTaskMemoryInput {
  taskId: string;
  scope: DurableMemoryScope;
  confirmed: true;
}

export interface MemoryExportResult {
  schemaVersion: 1;
  fileName: string;
  path: string;
  recordCount: number;
  createdAt: string;
}

export function emptyChildMemorySnapshot(now = new Date(0)): ChildMemorySnapshot {
  return {
    schemaVersion: TETI_CHILD_MEMORY_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    records: [],
    authorizations: []
  };
}
