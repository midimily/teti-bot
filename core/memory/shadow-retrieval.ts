export const TETI_MEMORY_SHADOW_RETRIEVAL_SCHEMA_VERSION = 1;

export const MEMORY_SHADOW_RETRIEVAL_LIMITS = Object.freeze({
  maximumCandidates: 8,
  maximumContextBytes: 12 * 1_024,
  maximumQueryBytes: 8 * 1_024,
  maximumQueryTokens: 16,
  maximumManifestsPerTask: 256
});

export type MemoryShadowScope = "task" | "workspace" | "peer";

export type MemoryShadowCandidateReason =
  | "exact_task"
  | "exact_workspace"
  | "exact_peer"
  | "stage_handoff"
  | "keyword_match"
  | "recent";

/**
 * Receiver-local retrieval input. Shadow retrieval is evaluation-only in
 * Beta 0.5.1 and must never be attached to a Connector or CLI request.
 */
export interface MemoryShadowRetrievalInput {
  schemaVersion: 1;
  executionId: string;
  taskId: string;
  peerTetiId: string;
  workspaceId: string | null;
  childAgentId: string;
  queryText: string;
  generatedAt: string;
}

export interface MemoryShadowCandidate {
  schemaVersion: 1;
  memoryId: string;
  sourceTaskId: string;
  scope: MemoryShadowScope;
  kind: "stage_handoff";
  trust: "peer_originated_reference";
  version: 1;
  rank: number;
  score: number;
  reasons: MemoryShadowCandidateReason[];
  itemDigest: string;
  contentBytes: number;
  createdAt: string;
  eligibleForCliInjection: false;
}

export interface MemoryShadowSelectionManifest {
  schemaVersion: 1;
  manifestId: string;
  mode: "shadow";
  executionId: string;
  currentTaskId: string;
  generatedAt: string;
  queryDigest: string;
  cliInjectionEnabled: false;
  maximumCandidates: number;
  maximumContextBytes: number;
  candidateCount: number;
  candidateBytes: number;
  scopeCandidateCounts: Record<MemoryShadowScope, number>;
  candidates: MemoryShadowCandidate[];
  manifestDigest: string;
}

export function boundMemoryShadowQueryText(value: string): string {
  const normalized = value.trim();
  if (new TextEncoder().encode(normalized).byteLength
    <= MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumQueryBytes) return normalized;
  let result = "";
  for (const character of normalized) {
    const next = result + character;
    if (new TextEncoder().encode(next).byteLength
      > MEMORY_SHADOW_RETRIEVAL_LIMITS.maximumQueryBytes) break;
    result = next;
  }
  return result;
}
