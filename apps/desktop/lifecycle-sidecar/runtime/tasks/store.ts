import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";
import {
  MAX_TASK_TRANSPORT_RECORDS,
  TETI_TASK_TRANSPORT_SCHEMA_VERSION,
  type CollaborationTaskTransportRecord,
  type TetiTaskTransportStoreState
} from "../../../../../core/task/transport.ts";
import {
  validateTaskProtocolVersions,
  validateTaskReceiptPayload
} from "../../../../../core/task/transport-validation.ts";
import {
  validateCollaborationTaskRequest,
  validateTaskArtifact
} from "../../../../../core/task/validation.ts";

export interface TaskTransportStore {
  load(): Promise<TetiTaskTransportStoreState>;
  save(state: TetiTaskTransportStoreState): Promise<void>;
}

export class FileTaskTransportStore implements TaskTransportStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiTaskTransportStoreState> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      validateTaskTransportStoreState(state);
      return clone(state);
    } catch (error) {
      if (isNotFound(error)) return emptyTaskTransportStoreState();
      throw error;
    }
  }

  async save(state: TetiTaskTransportStoreState): Promise<void> {
    validateTaskTransportStoreState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryTaskTransportStore implements TaskTransportStore {
  private state: TetiTaskTransportStoreState;

  constructor(state: TetiTaskTransportStoreState = emptyTaskTransportStoreState()) {
    validateTaskTransportStoreState(state);
    this.state = clone(state);
  }

  async load(): Promise<TetiTaskTransportStoreState> {
    return clone(this.state);
  }

  async save(state: TetiTaskTransportStoreState): Promise<void> {
    validateTaskTransportStoreState(state);
    this.state = clone(state);
  }
}

export function emptyTaskTransportStoreState(): TetiTaskTransportStoreState {
  return {
    schemaVersion: TETI_TASK_TRANSPORT_SCHEMA_VERSION,
    records: [],
    peers: []
  };
}

export function validateTaskTransportStoreState(
  value: unknown
): asserts value is TetiTaskTransportStoreState {
  if (!isRecord(value) || value.schemaVersion !== TETI_TASK_TRANSPORT_SCHEMA_VERSION) {
    throw new Error("Unsupported Teti Task transport store.");
  }
  rejectUnknownKeys(value, ["schemaVersion", "records", "peers"], "Teti Task transport store");
  if (!Array.isArray(value.records) || value.records.length > MAX_TASK_TRANSPORT_RECORDS) {
    throw new Error("Teti Task transport records are invalid.");
  }
  if (!Array.isArray(value.peers) || value.peers.length > MAX_TASK_TRANSPORT_RECORDS) {
    throw new Error("Teti Task transport peer capabilities are invalid.");
  }
  for (const record of value.records) validateRecord(record);
  for (const peer of value.peers) {
    if (!isRecord(peer) || !isCanonicalTetiPublicId(peer.tetiId)) {
      throw new Error("Teti Task transport peer capability is invalid.");
    }
    rejectUnknownKeys(peer, ["tetiId", "supportedVersions", "observedAt"], "Task peer capability");
    validateTaskProtocolVersions(peer.supportedVersions);
    requireTimestamp(peer.observedAt, "Task peer observedAt");
  }
}

function validateRecord(value: unknown): asserts value is CollaborationTaskTransportRecord {
  if (!isRecord(value) || value.schemaVersion !== TETI_TASK_TRANSPORT_SCHEMA_VERSION) {
    throw new Error("Teti Task transport record version is invalid.");
  }
  rejectUnknownKeys(value, [
    "schemaVersion",
    "direction",
    "peerTetiId",
    "protocolVersion",
    "envelopeMessageId",
    "chatmailMessageId",
    "sentAttachmentIds",
    "sentArtifactAttachmentIds",
    "request",
    "state",
    "approval",
    "delivery",
    "createdAt",
    "updatedAt",
    "receipt",
    "receiptPending",
    "statusRevision",
    "statusPending",
    "cancelPending",
    "cancelSentAt",
    "artifactPending",
    "artifactAttachmentsReady",
    "attachmentsReady",
    "artifacts",
    "safeErrorCode"
  ], "Task transport record");
  if (value.direction !== "incoming" && value.direction !== "outgoing") {
    throw new Error("Teti Task transport record direction is invalid.");
  }
  if (!isCanonicalTetiPublicId(value.peerTetiId)
    || (value.protocolVersion !== 1 && value.protocolVersion !== 2 && value.protocolVersion !== 3)) {
    throw new Error("Teti Task transport record peer is invalid.");
  }
  if (value.envelopeMessageId !== undefined
    && (typeof value.envelopeMessageId !== "string" || !value.envelopeMessageId.trim())) {
    throw new Error("Teti Task transport envelope message ID is invalid.");
  }
  if (value.chatmailMessageId !== undefined
    && (typeof value.chatmailMessageId !== "number"
      || !Number.isSafeInteger(value.chatmailMessageId)
      || value.chatmailMessageId < 0)) {
    throw new Error("Teti Task transport Chatmail message ID is invalid.");
  }
  validateCollaborationTaskRequest(value.request);
  if (value.request.schemaVersion !== value.protocolVersion) {
    throw new Error("Teti Task transport request version does not match its record.");
  }
  if (!["unknown", "submitted", "working", "input_required", "auth_required", "completed", "failed", "canceled", "rejected"].includes(String(value.state))) {
    throw new Error("Teti Task transport state is invalid.");
  }
  if (!["pending", "approved_once", "rejected", "expired", "consumed"].includes(String(value.approval))) {
    throw new Error("Teti Task transport approval is invalid.");
  }
  if (!["queued", "sent", "send_failed", "received", "acknowledged", "expired", "conflict", "rejected"].includes(String(value.delivery))) {
    throw new Error("Teti Task transport delivery state is invalid.");
  }
  requireTimestamp(value.createdAt, "Task record createdAt");
  requireTimestamp(value.updatedAt, "Task record updatedAt");
  if (value.receipt !== undefined) validateTaskReceiptPayload(value.receipt);
  if (value.receiptPending !== undefined && typeof value.receiptPending !== "boolean") {
    throw new Error("Teti Task transport receipt state is invalid.");
  }
  if (value.sentAttachmentIds !== undefined
    && (!Array.isArray(value.sentAttachmentIds)
      || value.sentAttachmentIds.some((item) => typeof item !== "string"))) {
    throw new Error("Teti Task sent attachment state is invalid.");
  }
  if (value.sentArtifactAttachmentIds !== undefined
    && (!Array.isArray(value.sentArtifactAttachmentIds)
      || value.sentArtifactAttachmentIds.some((item) => typeof item !== "string"))) {
    throw new Error("Teti Task sent Artifact attachment state is invalid.");
  }
  if (value.statusRevision !== undefined
    && (!Number.isSafeInteger(value.statusRevision) || Number(value.statusRevision) < 0)) {
    throw new Error("Teti Task status revision is invalid.");
  }
  if (value.cancelPending !== undefined && typeof value.cancelPending !== "boolean") {
    throw new Error("Teti Task cancel state is invalid.");
  }
  if (value.cancelSentAt !== undefined) requireTimestamp(value.cancelSentAt, "Teti Task cancel sentAt");
  if (value.statusPending !== undefined && typeof value.statusPending !== "boolean") {
    throw new Error("Teti Task status outbox state is invalid.");
  }
  if (value.artifactPending !== undefined && typeof value.artifactPending !== "boolean") {
    throw new Error("Teti Task Artifact outbox state is invalid.");
  }
  if (value.artifactAttachmentsReady !== undefined && typeof value.artifactAttachmentsReady !== "boolean") {
    throw new Error("Teti Task Artifact attachment readiness is invalid.");
  }
  if (value.attachmentsReady !== undefined && typeof value.attachmentsReady !== "boolean") {
    throw new Error("Teti Task attachment readiness is invalid.");
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 1) {
      throw new Error("Teti Task artifacts are invalid.");
    }
    for (const artifact of value.artifacts) validateTaskArtifact(artifact);
  }
  if (value.safeErrorCode !== undefined
    && (typeof value.safeErrorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value.safeErrorCode))) {
    throw new Error("Teti Task transport safe error code is invalid.");
  }
}

function requireTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
