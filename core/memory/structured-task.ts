export const TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION = 1;

export const STRUCTURED_TASK_MEMORY_LIMITS = Object.freeze({
  maximumContentBytes: 4 * 1_024,
  maximumPreviewCharacters: 240,
  maximumStagesPerTask: 16
});

/**
 * Receiver-local memory captured from one successfully committed stage of an
 * ongoing collaboration. This contract never enters Task, Passport, Chatmail,
 * or a Connector request.
 */
export interface LongHorizonStageMemoryInput {
  schemaVersion: 1;
  taskId: string;
  taskCreatedAt: string;
  peerTetiId: string;
  workspaceId: string | null;
  stageId: string;
  stageIndex: number;
  executionTaskId: string;
  executionEpoch: number | null;
  childAgentId: string;
  connectorId: string;
  artifactId: string;
  workspaceRevision: number;
  content: string;
  createdAt: string;
}

export interface LongHorizonStageMemorySummary {
  schemaVersion: 1;
  memoryId: string;
  taskId: string;
  stageId: string;
  stageIndex: number;
  childAgentId: string;
  connectorId: string;
  artifactId: string;
  workspaceRevision: number;
  kind: "stage_handoff";
  trust: "peer_originated_reference";
  contentDigest: string;
  contentPreview: string;
  createdAt: string;
}

export interface LongHorizonTaskMemorySnapshot {
  schemaVersion: 1;
  taskId: string;
  status: "ready" | "unavailable";
  recordCount: number;
  latestStageIndex: number | null;
  updatedAt: string | null;
  records: LongHorizonStageMemorySummary[];
  safeErrorCode?: "MEMORY_STORE_UNAVAILABLE";
}

export interface StructuredTaskMemoryStore {
  initialize(): Promise<void>;
  saveStage(input: LongHorizonStageMemoryInput): Promise<void>;
  getTaskSnapshot(taskId: string): Promise<LongHorizonTaskMemorySnapshot>;
  close(): Promise<void>;
}

export function unavailableLongHorizonTaskMemory(
  taskId: string
): LongHorizonTaskMemorySnapshot {
  return {
    schemaVersion: TETI_STRUCTURED_TASK_MEMORY_SCHEMA_VERSION,
    taskId,
    status: "unavailable",
    recordCount: 0,
    latestStageIndex: null,
    updatedAt: null,
    records: [],
    safeErrorCode: "MEMORY_STORE_UNAVAILABLE"
  };
}

export function boundStructuredTaskMemoryContent(content: string): string {
  const normalized = content.trim();
  if (new TextEncoder().encode(normalized).byteLength
    <= STRUCTURED_TASK_MEMORY_LIMITS.maximumContentBytes) return normalized;
  let result = "";
  for (const character of normalized) {
    const next = result + character;
    if (new TextEncoder().encode(next).byteLength
      > STRUCTURED_TASK_MEMORY_LIMITS.maximumContentBytes) break;
    result = next;
  }
  return result;
}
