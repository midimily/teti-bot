import {
  CHILD_MEMORY_LIMITS,
  TETI_CHILD_MEMORY_SCHEMA_VERSION,
  type ChildMemorySnapshot,
  type MemoryAuthorization,
  type MemoryContextSelection,
  type MemoryRecord,
  type MemoryRecordSummary
} from "./types.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_CHILD_AGENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validateMemoryRecord(value: unknown): asserts value is MemoryRecord {
  if (!isRecord(value)) throw new Error("Memory Record is invalid.");
  exactKeys(value, [
    "schemaVersion", "memoryId", "scope", "workspaceId", "childAgentId",
    "sourceTaskId", "sourcePeerId", "content", "contentDigest", "createdAt",
    "expiresAt", "provenance"
  ], "Memory Record");
  if (value.schemaVersion !== TETI_CHILD_MEMORY_SCHEMA_VERSION
    || !safeId(value.memoryId)
    || !["task", "workspace", "child_agent"].includes(String(value.scope))
    || !safeId(value.workspaceId)
    || !safeChildAgentId(value.childAgentId)
    || !safeId(value.sourceTaskId)
    || !safeId(value.sourcePeerId)
    || typeof value.content !== "string"
    || !value.content.trim()
    || utf8Size(value.content) > CHILD_MEMORY_LIMITS.maximumContentBytes
    || typeof value.contentDigest !== "string"
    || !DIGEST_PATTERN.test(value.contentDigest)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    throw new Error("Memory Record is invalid.");
  }
  validateMemoryProvenance(value.provenance);
}

export function validateMemoryAuthorization(
  value: unknown
): asserts value is MemoryAuthorization {
  if (!isRecord(value)) throw new Error("Memory authorization is invalid.");
  exactKeys(value, [
    "schemaVersion", "scope", "workspaceId", "childAgentId", "authorizedAt"
  ], "Memory authorization");
  const validScope = value.scope === "workspace" || value.scope === "child_agent";
  const validWorkspace = value.scope === "workspace"
    ? safeId(value.workspaceId)
    : value.workspaceId === null;
  if (value.schemaVersion !== TETI_CHILD_MEMORY_SCHEMA_VERSION
    || !validScope
    || !validWorkspace
    || !safeChildAgentId(value.childAgentId)
    || !validTimestamp(value.authorizedAt)) {
    throw new Error("Memory authorization is invalid.");
  }
}

export function validateChildMemorySnapshot(
  value: unknown
): asserts value is ChildMemorySnapshot {
  if (!isRecord(value)) throw new Error("Child Memory snapshot is invalid.");
  exactKeys(value, ["schemaVersion", "generatedAt", "records", "authorizations"], "Child Memory snapshot");
  if (value.schemaVersion !== TETI_CHILD_MEMORY_SCHEMA_VERSION
    || !validTimestamp(value.generatedAt)
    || !Array.isArray(value.records)
    || !Array.isArray(value.authorizations)
    || value.records.length > CHILD_MEMORY_LIMITS.maximumRecords
    || value.authorizations.length > CHILD_MEMORY_LIMITS.maximumAuthorizations) {
    throw new Error("Child Memory snapshot is invalid.");
  }
  const memoryIds = new Set<string>();
  for (const record of value.records) {
    validateMemoryRecordSummary(record);
    if (memoryIds.has(record.memoryId)) throw new Error("Child Memory snapshot contains duplicate records.");
    memoryIds.add(record.memoryId);
  }
  const authorizationKeys = new Set<string>();
  for (const authorization of value.authorizations) {
    validateMemoryAuthorization(authorization);
    const key = `${authorization.scope}:${authorization.workspaceId ?? "none"}:${authorization.childAgentId}`;
    if (authorizationKeys.has(key)) throw new Error("Child Memory snapshot contains duplicate authorizations.");
    authorizationKeys.add(key);
  }
}

export function validateMemoryRecordSummary(
  value: unknown
): asserts value is MemoryRecordSummary {
  if (!isRecord(value)) throw new Error("Memory Record summary is invalid.");
  exactKeys(value, [
    "schemaVersion", "memoryId", "scope", "workspaceId", "childAgentId",
    "sourceTaskId", "sourcePeerId", "contentPreview", "contentDigest", "createdAt",
    "expiresAt", "provenance"
  ], "Memory Record summary");
  if (value.schemaVersion !== TETI_CHILD_MEMORY_SCHEMA_VERSION
    || !safeId(value.memoryId)
    || (value.scope !== "workspace" && value.scope !== "child_agent")
    || !safeId(value.workspaceId)
    || !safeChildAgentId(value.childAgentId)
    || !safeId(value.sourceTaskId)
    || !safeId(value.sourcePeerId)
    || typeof value.contentPreview !== "string"
    || [...value.contentPreview].length > CHILD_MEMORY_LIMITS.maximumPreviewCharacters
    || typeof value.contentDigest !== "string"
    || !DIGEST_PATTERN.test(value.contentDigest)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    throw new Error("Memory Record summary is invalid.");
  }
  validateMemoryProvenance(value.provenance);
}

export function validateMemoryContextSelection(
  value: MemoryContextSelection
): void {
  if (value.schemaVersion !== TETI_CHILD_MEMORY_SCHEMA_VERSION
    || value.records.length > CHILD_MEMORY_LIMITS.maximumContextRecords
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 0
    || value.byteLength > CHILD_MEMORY_LIMITS.maximumContextBytes) {
    throw new Error("Memory context selection is invalid.");
  }
  let measured = 0;
  for (const record of value.records) {
    if (!safeId(record.memoryId)
      || (record.scope !== "workspace" && record.scope !== "child_agent")
      || !DIGEST_PATTERN.test(record.contentDigest)
      || typeof record.content !== "string"
      || !record.content.trim()
      || utf8Size(record.content) > CHILD_MEMORY_LIMITS.maximumContentBytes) {
      throw new Error("Memory context selection is invalid.");
    }
    measured += utf8Size(record.content);
  }
  if (measured !== value.byteLength) throw new Error("Memory context byte length is invalid.");
}

function validateMemoryProvenance(value: unknown): void {
  if (!isRecord(value)) throw new Error("Memory provenance is invalid.");
  exactKeys(value, ["kind", "actor", "sourceArtifactId", "authorizedAt"], "Memory provenance");
  if (value.kind !== "task_artifact_user_saved"
    || value.actor !== "local_user"
    || !safeId(value.sourceArtifactId)
    || !validTimestamp(value.authorizedAt)) {
    throw new Error("Memory provenance is invalid.");
  }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function safeChildAgentId(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHILD_AGENT_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}
