import { isCanonicalTetiPublicId } from "../identity/public-id.ts";
import {
  TETI_WORKSPACE_SCHEMA_VERSION,
  TETI_WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  WORKSPACE_LIMITS,
  type CollaborationWorkspace,
  type TaskWorkspaceBinding,
  type TaskWorkspaceRequest,
  type WorkspaceAccess,
  type WorkspaceManifest,
  type WorkspaceQuota,
  type WorkspaceSnapshot
} from "./types.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ACCESS_ORDER: readonly WorkspaceAccess[] = ["read", "write", "create_artifact"];

export class WorkspaceContractError extends Error {}

export function validateCollaborationWorkspace(
  value: unknown
): asserts value is CollaborationWorkspace {
  const workspace = exactRecord(value, [
    "schemaVersion",
    "workspaceId",
    "ownerTetiId",
    "participantTetiIds",
    "revision",
    "mode",
    "quota",
    "retentionPolicy",
    "manifest",
    "createdAt",
    "updatedAt"
  ], "Workspace");
  if (workspace.schemaVersion !== TETI_WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceContractError("Unsupported Workspace schema version.");
  }
  safeId(workspace.workspaceId, "workspaceId");
  canonicalTetiId(workspace.ownerTetiId, "ownerTetiId");
  validateParticipants(workspace.participantTetiIds, workspace.ownerTetiId as string);
  positiveInteger(workspace.revision, "revision");
  if (workspace.mode !== "ephemeral_task" && workspace.mode !== "durable_collaboration") {
    throw new WorkspaceContractError("Workspace mode is invalid.");
  }
  validateWorkspaceQuota(workspace.quota);
  validateRetention(workspace.retentionPolicy, workspace.mode);
  validateWorkspaceManifest(workspace.manifest, workspace.quota as WorkspaceQuota);
  const createdAt = timestamp(workspace.createdAt, "createdAt");
  const updatedAt = timestamp(workspace.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new WorkspaceContractError("Workspace timestamps are invalid.");
}

export function validateTaskWorkspaceRequest(
  value: unknown
): asserts value is TaskWorkspaceRequest {
  if (!isRecord(value)) throw new WorkspaceContractError("Task Workspace request must be an object.");
  if (value.kind === "temporary") {
    exactRecord(value, ["kind", "access"], "Temporary Task Workspace request");
    validateWorkspaceAccess(value.access);
    return;
  }
  if (value.kind === "reference") {
    exactRecord(
      value,
      ["kind", "workspaceId", "workspaceRevision", "access"],
      "Referenced Task Workspace request"
    );
    safeId(value.workspaceId, "workspaceId");
    positiveInteger(value.workspaceRevision, "workspaceRevision");
    validateWorkspaceAccess(value.access);
    return;
  }
  throw new WorkspaceContractError("Task Workspace request kind is invalid.");
}

export function validateTaskWorkspaceBinding(
  value: unknown
): asserts value is TaskWorkspaceBinding {
  const binding = exactRecord(
    value,
    ["workspaceId", "workspaceRevision", "mode", "access"],
    "Task Workspace binding"
  );
  safeId(binding.workspaceId, "workspaceId");
  positiveInteger(binding.workspaceRevision, "workspaceRevision");
  if (binding.mode !== "ephemeral_task" && binding.mode !== "durable_collaboration") {
    throw new WorkspaceContractError("Task Workspace binding mode is invalid.");
  }
  validateWorkspaceAccess(binding.access);
}

export function validateWorkspaceSnapshot(value: unknown): asserts value is WorkspaceSnapshot {
  const snapshot = exactRecord(value, [
    "schemaVersion",
    "snapshotId",
    "workspaceId",
    "workspaceRevision",
    "access",
    "snapshotPath",
    "createdAt"
  ], "Workspace Snapshot");
  if (snapshot.schemaVersion !== TETI_WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
    throw new WorkspaceContractError("Unsupported Workspace Snapshot version.");
  }
  safeId(snapshot.snapshotId, "snapshotId");
  safeId(snapshot.workspaceId, "workspaceId");
  positiveInteger(snapshot.workspaceRevision, "workspaceRevision");
  validateWorkspaceAccess(snapshot.access);
  if (typeof snapshot.snapshotPath !== "string" || !snapshot.snapshotPath) {
    throw new WorkspaceContractError("Workspace Snapshot path is invalid.");
  }
  timestamp(snapshot.createdAt, "createdAt");
}

export function validateWorkspaceAccess(value: unknown): asserts value is WorkspaceAccess[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ACCESS_ORDER.length) {
    throw new WorkspaceContractError("Workspace access is invalid.");
  }
  const unique = new Set(value);
  if (unique.size !== value.length
    || value.some((item) => !ACCESS_ORDER.includes(item as WorkspaceAccess))
    || value[0] !== "read") {
    throw new WorkspaceContractError("Workspace access is invalid.");
  }
  const canonical = ACCESS_ORDER.filter((item) => unique.has(item));
  if (canonical.some((item, index) => value[index] !== item)) {
    throw new WorkspaceContractError("Workspace access ordering is invalid.");
  }
}

export function validateWorkspaceQuota(value: unknown): asserts value is WorkspaceQuota {
  const quota = exactRecord(value, ["maxBytes", "maxFiles"], "Workspace quota");
  positiveInteger(quota.maxBytes, "maxBytes");
  positiveInteger(quota.maxFiles, "maxFiles");
  if (Number(quota.maxBytes) > WORKSPACE_LIMITS.maximumBytes
    || Number(quota.maxFiles) > WORKSPACE_LIMITS.maximumFiles) {
    throw new WorkspaceContractError("Workspace quota exceeds the supported limit.");
  }
}

export function validateWorkspaceManifest(
  value: unknown,
  quota?: WorkspaceQuota
): asserts value is WorkspaceManifest {
  const manifest = exactRecord(value, ["entries", "totalBytes", "totalFiles"], "Workspace manifest");
  if (!Array.isArray(manifest.entries)
    || manifest.entries.length > WORKSPACE_LIMITS.maximumManifestEntries) {
    throw new WorkspaceContractError("Workspace manifest entries are invalid.");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const raw of manifest.entries) {
    const entry = exactRecord(
      raw,
      ["relativePath", "byteLength", "sha256", "updatedAt"],
      "Workspace manifest entry"
    );
    validateWorkspaceRelativePath(entry.relativePath);
    if (paths.has(entry.relativePath as string)) {
      throw new WorkspaceContractError("Workspace manifest paths must be unique.");
    }
    paths.add(entry.relativePath as string);
    if (!Number.isSafeInteger(entry.byteLength) || Number(entry.byteLength) < 0) {
      throw new WorkspaceContractError("Workspace manifest byte length is invalid.");
    }
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw new WorkspaceContractError("Workspace manifest digest is invalid.");
    }
    timestamp(entry.updatedAt, "updatedAt");
    totalBytes += Number(entry.byteLength);
    if (!Number.isSafeInteger(totalBytes)) {
      throw new WorkspaceContractError("Workspace manifest size is invalid.");
    }
  }
  if (manifest.totalFiles !== manifest.entries.length || manifest.totalBytes !== totalBytes) {
    throw new WorkspaceContractError("Workspace manifest totals are invalid.");
  }
  if (quota && (totalBytes > quota.maxBytes || manifest.entries.length > quota.maxFiles)) {
    throw new WorkspaceContractError("Workspace quota is exceeded.");
  }
}

export function validateWorkspaceRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || new TextEncoder().encode(value).byteLength > WORKSPACE_LIMITS.maximumRelativePathBytes) {
    throw new WorkspaceContractError("Workspace relative path is invalid.");
  }
  const segments = value.split("/");
  if (segments.some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.length > 255
    || /[\u0000-\u001f\u007f]/.test(segment)
  )) {
    throw new WorkspaceContractError("Workspace relative path is invalid.");
  }
}

function validateParticipants(value: unknown, ownerTetiId: string): void {
  if (!Array.isArray(value) || value.length > WORKSPACE_LIMITS.maximumParticipants) {
    throw new WorkspaceContractError("Workspace participants are invalid.");
  }
  const participants = new Set<string>();
  for (const item of value) {
    canonicalTetiId(item, "participantTetiId");
    if (item === ownerTetiId || participants.has(item)) {
      throw new WorkspaceContractError("Workspace participants are invalid.");
    }
    participants.add(item);
  }
  const sorted = [...participants].sort();
  if (sorted.some((item, index) => item !== value[index])) {
    throw new WorkspaceContractError("Workspace participants must be canonical and sorted.");
  }
}

function validateRetention(value: unknown, mode: unknown): void {
  if (!isRecord(value)) throw new WorkspaceContractError("Workspace retention policy is invalid.");
  if (mode === "ephemeral_task") {
    const retention = exactRecord(value, ["kind", "expiresAt"], "Workspace retention policy");
    if (retention.kind !== "ttl") throw new WorkspaceContractError("Ephemeral Workspace requires TTL retention.");
    timestamp(retention.expiresAt, "expiresAt");
    return;
  }
  const retention = exactRecord(value, ["kind"], "Workspace retention policy");
  if (retention.kind !== "retain") {
    throw new WorkspaceContractError("Durable Workspace requires retained storage.");
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new WorkspaceContractError(`${label} must be an object.`);
  const actual = Object.keys(value);
  const extra = actual.find((key) => !keys.includes(key));
  const missing = keys.find((key) => !actual.includes(key));
  if (extra) throw new WorkspaceContractError(`${label} contains an unsupported field.`);
  if (missing) throw new WorkspaceContractError(`${label} is missing a required field.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new WorkspaceContractError(`${label} is invalid.`);
  }
}

function canonicalTetiId(value: unknown, label: string): asserts value is string {
  if (!isCanonicalTetiPublicId(value)) {
    throw new WorkspaceContractError(`${label} must be a canonical lowercase Teti ID.`);
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new WorkspaceContractError(`${label} must be a positive integer.`);
  }
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceContractError(`${label} is required.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new WorkspaceContractError(`${label} is invalid.`);
  return parsed;
}
