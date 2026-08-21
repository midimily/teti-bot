import type {
  MemoryShadowRetrievalInput,
  MemoryShadowSelectionManifest
} from "./shadow-retrieval.ts";
import type {
  CreateStructuredMemoryItemInput,
  StructuredMemoryAuthorizationInput,
  StructuredMemoryContextPreview,
  StructuredMemoryExecutionInput,
  StructuredMemoryExecutionSelection,
  StructuredMemoryInjectionManifest,
  StructuredMemoryItemDetail,
  StructuredMemoryItemSummary,
  StructuredMemorySourceDraft,
  StructuredMemoryPreviewApproval,
  StructuredMemoryPreviewInput,
  UpdateStructuredMemoryItemInput
} from "./context-injection.ts";
import type {
  StructuredMemoryMaintenanceInput,
  StructuredMemoryMaintenanceReport,
  StructuredMemoryStoreHealth
} from "./recovery-quality.ts";

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
  status: "ready" | "read_only" | "unavailable";
  recordCount: number;
  latestStageIndex: number | null;
  updatedAt: string | null;
  records: LongHorizonStageMemorySummary[];
  items?: StructuredMemoryItemSummary[];
  latestShadowManifest?: MemoryShadowSelectionManifest | null;
  latestInjectionManifest?: StructuredMemoryInjectionManifest | null;
  safeErrorCode?: "MEMORY_STORE_UNAVAILABLE" | "MEMORY_STORE_READ_ONLY";
}

export interface StructuredTaskMemoryStore {
  initialize(): Promise<void>;
  saveStage(input: LongHorizonStageMemoryInput): Promise<void>;
  createShadowManifest(input: MemoryShadowRetrievalInput): Promise<MemoryShadowSelectionManifest>;
  getLatestShadowManifest(taskId: string): Promise<MemoryShadowSelectionManifest | null>;
  getStructuredMemoryItem(input: {
    memoryId?: string;
    sourceMemoryId?: string;
  }): Promise<StructuredMemoryItemDetail | null>;
  getStructuredMemorySourceDraft(sourceMemoryId: string): Promise<StructuredMemorySourceDraft | null>;
  createStructuredMemoryItem(
    input: CreateStructuredMemoryItemInput
  ): Promise<StructuredMemoryItemDetail>;
  updateStructuredMemoryItem(
    input: UpdateStructuredMemoryItemInput
  ): Promise<StructuredMemoryItemDetail>;
  deleteStructuredMemoryItem(input: {
    memoryId: string;
    confirmed: true;
    deletedAt: string;
  }): Promise<boolean>;
  setStructuredMemoryAuthorization(
    input: StructuredMemoryAuthorizationInput
  ): Promise<void>;
  createContextPreview(
    input: StructuredMemoryPreviewInput
  ): Promise<StructuredMemoryContextPreview>;
  approveContextPreview(input: {
    taskId: string;
    previewId: string;
    approvedAt: string;
  }): Promise<StructuredMemoryPreviewApproval>;
  createExecutionContext(
    input: StructuredMemoryExecutionInput
  ): Promise<StructuredMemoryExecutionSelection>;
  getTaskSnapshot(taskId: string): Promise<LongHorizonTaskMemorySnapshot>;
  getHealth(): Promise<StructuredMemoryStoreHealth>;
  runMaintenance(
    input: StructuredMemoryMaintenanceInput
  ): Promise<StructuredMemoryMaintenanceReport>;
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
