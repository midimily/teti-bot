import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";
import {
  LONG_HORIZON_LIMITS,
  MAX_TASK_TRANSPORT_RECORDS,
  TETI_TASK_TRANSPORT_SCHEMA_VERSION,
  TETI_TASK_TRANSPORT_STORE_SCHEMA_VERSION,
  type CollaborationTaskTransportRecord,
  type TetiTaskTransportStoreState
} from "../../../../../core/task/transport.ts";
import {
  validateTaskInputPayload,
  validateTaskApplicationReceiptPayload,
  validateTaskProtocolVersions,
  validateTaskReceiptPayload,
  validateTaskStatusPayload
} from "../../../../../core/task/transport-validation.ts";
import {
  validateCollaborationTaskRequest,
  validateTaskArtifact
} from "../../../../../core/task/validation.ts";
import { validateTaskWorkspaceBinding } from "../../../../../core/workspace/validation.ts";
import {
  validateLongHorizonArtifactEntries,
  validateLongHorizonTaskState
} from "../../../../../core/task/long-horizon-validation.ts";
import {
  isWorkspaceAccessSubset,
  validateDelegationPlanState
} from "../../../../../core/delegation/validation.ts";

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
      const state = migrateTaskStoreState(JSON.parse(await readFile(this.path, "utf8")));
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
    const migrated = migrateTaskStoreState(state);
    validateTaskTransportStoreState(migrated);
    this.state = clone(migrated);
  }

  async load(): Promise<TetiTaskTransportStoreState> {
    return clone(this.state);
  }

  async save(state: TetiTaskTransportStoreState): Promise<void> {
    const migrated = migrateTaskStoreState(state);
    validateTaskTransportStoreState(migrated);
    this.state = clone(migrated);
  }
}

function migrateTaskStoreState(value: unknown): unknown {
  if (!isRecord(value)
    || (value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4)) return value;
  return { ...value, schemaVersion: TETI_TASK_TRANSPORT_STORE_SCHEMA_VERSION };
}

export function emptyTaskTransportStoreState(): TetiTaskTransportStoreState {
  return {
    schemaVersion: TETI_TASK_TRANSPORT_STORE_SCHEMA_VERSION,
    records: [],
    peers: []
  };
}

export function validateTaskTransportStoreState(
  value: unknown
): asserts value is TetiTaskTransportStoreState {
  if (!isRecord(value) || value.schemaVersion !== TETI_TASK_TRANSPORT_STORE_SCHEMA_VERSION) {
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
    "acknowledgedAttachmentIds",
    "acknowledgedArtifactAttachmentIds",
    "attachmentDeliveryAttempts",
    "artifactAttachmentDeliveryAttempts",
    "attachmentDiagnostics",
    "workspaceBinding",
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
    "statusAcknowledgedRevision",
    "cancelPending",
    "cancelControlId",
    "cancelRequestedAt",
    "cancelSentAt",
    "cancelAcknowledgedAt",
    "applicationDeliveryAttempts",
    "applicationDeliveryFailures",
    "applicationReceiptOutbox",
    "artifactPending",
    "sentArtifactIds",
    "acknowledgedArtifactIds",
    "artifactDeliveryAttempts",
    "artifactAttachmentsReady",
    "attachmentsReady",
    "artifacts",
    "longHorizon",
    "delegationPlan",
    "peerLongHorizon",
    "peerArtifactMetadata",
    "inputPending",
    "inputSentAt",
    "inputAcknowledgedAt",
    "viewedStageResultIndex",
    "attentionRevision",
    "viewedAttentionRevision",
    "latestAttentionChange",
    "safeErrorCode"
  ], "Task transport record");
  if (value.direction !== "incoming" && value.direction !== "outgoing") {
    throw new Error("Teti Task transport record direction is invalid.");
  }
  if (!isCanonicalTetiPublicId(value.peerTetiId)
    || (value.protocolVersion !== 1
      && value.protocolVersion !== 2
      && value.protocolVersion !== 3
      && value.protocolVersion !== 4
      && value.protocolVersion !== 5
      && value.protocolVersion !== 6
      && value.protocolVersion !== 7)) {
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
  validateStringArray(value.acknowledgedAttachmentIds, "Teti Task acknowledged attachment state");
  validateStringArray(
    value.acknowledgedArtifactAttachmentIds,
    "Teti Task acknowledged Artifact attachment state"
  );
  validateDeliveryAttempts(value.attachmentDeliveryAttempts, "Teti Task attachment delivery attempts");
  validateDeliveryAttempts(
    value.artifactAttachmentDeliveryAttempts,
    "Teti Task Artifact attachment delivery attempts"
  );
  validateAttachmentDiagnostics(value.attachmentDiagnostics);
  if (value.workspaceBinding !== undefined) validateTaskWorkspaceBinding(value.workspaceBinding);
  if (value.statusRevision !== undefined
    && (!Number.isSafeInteger(value.statusRevision) || Number(value.statusRevision) < 0)) {
    throw new Error("Teti Task status revision is invalid.");
  }
  if (value.statusAcknowledgedRevision !== undefined
    && (!Number.isSafeInteger(value.statusAcknowledgedRevision)
      || Number(value.statusAcknowledgedRevision) < 0
      || Number(value.statusAcknowledgedRevision) > Number(value.statusRevision ?? 0))) {
    throw new Error("Teti Task acknowledged status revision is invalid.");
  }
  if (value.cancelPending !== undefined && typeof value.cancelPending !== "boolean") {
    throw new Error("Teti Task cancel state is invalid.");
  }
  if (value.cancelControlId !== undefined
    && (typeof value.cancelControlId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.cancelControlId))) {
    throw new Error("Teti Task cancel control ID is invalid.");
  }
  if (value.cancelRequestedAt !== undefined) requireTimestamp(value.cancelRequestedAt, "Teti Task cancel requestedAt");
  if (value.cancelSentAt !== undefined) requireTimestamp(value.cancelSentAt, "Teti Task cancel sentAt");
  if (value.cancelAcknowledgedAt !== undefined) {
    requireTimestamp(value.cancelAcknowledgedAt, "Teti Task cancel acknowledgedAt");
  }
  validateApplicationDeliveryAttempts(value.applicationDeliveryAttempts);
  validateApplicationDeliveryFailures(value.applicationDeliveryFailures);
  if (value.applicationReceiptOutbox !== undefined) {
    if (!Array.isArray(value.applicationReceiptOutbox) || value.applicationReceiptOutbox.length > 16) {
      throw new Error("Teti Task application receipt outbox is invalid.");
    }
    for (const receipt of value.applicationReceiptOutbox) validateTaskApplicationReceiptPayload(receipt);
  }
  if (value.statusPending !== undefined && typeof value.statusPending !== "boolean") {
    throw new Error("Teti Task status outbox state is invalid.");
  }
  if (value.artifactPending !== undefined && typeof value.artifactPending !== "boolean") {
    throw new Error("Teti Task Artifact outbox state is invalid.");
  }
  validateStringArray(value.sentArtifactIds, "Teti Task sent Artifact IDs");
  validateStringArray(value.acknowledgedArtifactIds, "Teti Task acknowledged Artifact IDs");
  validateArtifactDeliveryAttempts(value.artifactDeliveryAttempts);
  if (value.artifactAttachmentsReady !== undefined && typeof value.artifactAttachmentsReady !== "boolean") {
    throw new Error("Teti Task Artifact attachment readiness is invalid.");
  }
  if (value.attachmentsReady !== undefined && typeof value.attachmentsReady !== "boolean") {
    throw new Error("Teti Task attachment readiness is invalid.");
  }
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > 32) {
      throw new Error("Teti Task artifacts are invalid.");
    }
    for (const artifact of value.artifacts) validateTaskArtifact(artifact);
  }
  if (value.longHorizon !== undefined) validateLongHorizonTaskState(value.longHorizon);
  if (value.delegationPlan !== undefined) {
    validateDelegationPlanState(value.delegationPlan);
    if (value.delegationPlan.taskId !== value.request.taskId
      || value.direction !== "incoming"
      || value.request.executionMode !== "long_horizon"
      || value.longHorizon === undefined) {
      throw new Error("Teti Task Delegation Plan ownership boundary is invalid.");
    }
    const binding = value.workspaceBinding;
    if (binding && value.delegationPlan.steps.some((step) =>
      step.kind === "child_execution"
      && (!isWorkspaceAccessSubset(step.workspaceAccess, binding.access)
        || step.workspaceRevision > binding.workspaceRevision))) {
      throw new Error("Teti Task Delegation Plan expanded Workspace authority.");
    }
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (value.delegationPlan.artifacts.some((entry) =>
      !artifacts.some((artifact) => artifact.artifactId === entry.artifactId))) {
      throw new Error("Teti Task Delegation Artifact provenance is orphaned.");
    }
  }
  if (value.peerLongHorizon !== undefined) {
    const peerState = value.state === "submitted" ? "working" : value.state;
    if (peerState === "unknown") throw new Error("Teti Task peer status state is invalid.");
    validateTaskStatusPayload({
      schemaVersion: 2,
      taskId: value.request.taskId,
      requesterTetiId: value.request.requesterTetiId,
      targetTetiId: value.request.targetTetiId,
      revision: 1,
      state: peerState,
      updatedAt: value.updatedAt,
      longHorizon: value.peerLongHorizon
    });
  }
  if (value.peerArtifactMetadata !== undefined) {
    validateLongHorizonArtifactEntries(value.peerArtifactMetadata);
    const peerArtifactMetadata = value.peerArtifactMetadata as NonNullable<
      CollaborationTaskTransportRecord["peerArtifactMetadata"]
    >;
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (peerArtifactMetadata.length !== artifacts.length
      || peerArtifactMetadata.some((entry) =>
        !artifacts.some((artifact) => artifact.artifactId === entry.artifactId))) {
      throw new Error("Teti Task peer Artifact metadata is incomplete.");
    }
  }
  if (value.inputPending !== undefined) validateTaskInputPayload(value.inputPending);
  if (value.inputSentAt !== undefined) requireTimestamp(value.inputSentAt, "Task input sentAt");
  if (value.inputAcknowledgedAt !== undefined) {
    requireTimestamp(value.inputAcknowledgedAt, "Task input acknowledgedAt");
  }
  if (value.viewedStageResultIndex !== undefined
    && (!Number.isSafeInteger(value.viewedStageResultIndex)
      || Number(value.viewedStageResultIndex) < 0
      || Number(value.viewedStageResultIndex) > LONG_HORIZON_LIMITS.maximumStages)) {
    throw new Error("Teti Task viewed stage result index is invalid.");
  }
  for (const field of ["attentionRevision", "viewedAttentionRevision"] as const) {
    if (value[field] !== undefined
      && (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) {
      throw new Error(`Teti Task ${field} is invalid.`);
    }
  }
  if (Number(value.viewedAttentionRevision ?? 0) > Number(value.attentionRevision ?? 0)) {
    throw new Error("Teti Task viewed attention revision exceeds the latest revision.");
  }
  validateLatestAttentionChange(value.latestAttentionChange, Number(value.attentionRevision ?? 0));
  if (value.safeErrorCode !== undefined
    && (typeof value.safeErrorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value.safeErrorCode))) {
    throw new Error("Teti Task transport safe error code is invalid.");
  }
  if ((value.longHorizon !== undefined
      && (value.direction !== "incoming" || value.request.executionMode !== "long_horizon"))
    || (value.peerLongHorizon !== undefined
      && (value.direction !== "outgoing" || value.request.executionMode !== "long_horizon"))
    || (value.peerArtifactMetadata !== undefined
      && (value.direction !== "outgoing" || value.request.executionMode !== "long_horizon"))
    || (value.longHorizon !== undefined && value.peerLongHorizon !== undefined)
    || (value.inputPending !== undefined
      && (value.direction !== "outgoing" || value.request.executionMode !== "long_horizon"))) {
    throw new Error("Teti Task long-horizon ownership boundary is invalid.");
  }
  validateApplicationDeliveryOwnership(value as unknown as CollaborationTaskTransportRecord);
  if (Array.isArray(value.sentArtifactIds)
    && value.sentArtifactIds.some((artifactId) =>
      !(value.artifacts as CollaborationTaskTransportRecord["artifacts"] | undefined)
        ?.some((artifact) => artifact.artifactId === artifactId))) {
    throw new Error("Teti Task sent Artifact identity is invalid.");
  }
  if (Array.isArray(value.acknowledgedArtifactIds)
    && value.acknowledgedArtifactIds.some((artifactId) =>
      !(value.artifacts as CollaborationTaskTransportRecord["artifacts"] | undefined)
        ?.some((artifact) => artifact.artifactId === artifactId))) {
    throw new Error("Teti Task acknowledged Artifact identity is invalid.");
  }
}

function validateApplicationDeliveryOwnership(record: CollaborationTaskTransportRecord): void {
  const attemptHasInvalidOwner = record.applicationDeliveryAttempts?.some((item) =>
    item.kind === "status" ? record.direction !== "incoming" : record.direction !== "outgoing"
  );
  const failureHasInvalidOwner = record.applicationDeliveryFailures?.some((item) =>
    item.kind === "request"
      ? record.direction !== "outgoing"
      : item.kind === "status"
        ? record.direction !== "incoming"
        : record.direction !== "outgoing"
  );
  const receiptHasInvalidOwner = record.applicationReceiptOutbox?.some((receipt) =>
    receipt.taskId !== record.request.taskId
    || receipt.requesterTetiId !== record.request.requesterTetiId
    || receipt.targetTetiId !== record.request.targetTetiId
    || (receipt.kind === "status" ? record.direction !== "outgoing" : record.direction !== "incoming")
  );
  if (attemptHasInvalidOwner || failureHasInvalidOwner || receiptHasInvalidOwner
    || (record.statusAcknowledgedRevision !== undefined && record.direction !== "incoming")
    || (record.inputAcknowledgedAt !== undefined && record.direction !== "outgoing")
    || ((record.cancelControlId !== undefined
        || record.cancelRequestedAt !== undefined
        || record.cancelAcknowledgedAt !== undefined)
      && record.direction !== "outgoing")) {
    throw new Error("Teti Task application delivery ownership boundary is invalid.");
  }
}

function validateAttachmentDiagnostics(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Teti Task attachment diagnostics are invalid.");
  }
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Teti Task attachment diagnostics are invalid.");
    rejectUnknownKeys(item, [
      "attachmentId",
      "purpose",
      "ordinal",
      "expectedCount",
      "byteLength",
      "sha256",
      "attempts",
      "state",
      "firstSentAt",
      "lastSentAt",
      "storedAt",
      "receiptReceivedAt",
      "safeErrorCode"
    ], "Teti Task attachment diagnostic");
    const key = `${String(item.purpose)}:${String(item.attachmentId)}`;
    if (typeof item.attachmentId !== "string" || !item.attachmentId.trim()
      || (item.purpose !== "input" && item.purpose !== "artifact")
      || keys.has(key)
      || !Number.isSafeInteger(item.ordinal) || Number(item.ordinal) < 1
      || !Number.isSafeInteger(item.expectedCount) || Number(item.expectedCount) < 1
      || Number(item.ordinal) > Number(item.expectedCount)
      || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 1
      || typeof item.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0
      || !["expected", "sent", "stored", "acknowledged", "expired", "failed"].includes(String(item.state))) {
      throw new Error("Teti Task attachment diagnostics are invalid.");
    }
    keys.add(key);
    for (const timestamp of ["firstSentAt", "lastSentAt", "storedAt", "receiptReceivedAt"] as const) {
      if (item[timestamp] !== undefined) requireTimestamp(item[timestamp], `Attachment diagnostic ${timestamp}`);
    }
    if (item.safeErrorCode !== undefined
      && (typeof item.safeErrorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(item.safeErrorCode))) {
      throw new Error("Teti Task attachment diagnostic error is invalid.");
    }
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)
    || value.length > 16
    || value.some((item) => typeof item !== "string" || !item.trim())
    || new Set(value).size !== value.length) {
    throw new Error(`${label} is invalid.`);
  }
}

function validateDeliveryAttempts(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} are invalid.`);
  const attachmentIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`${label} are invalid.`);
    rejectUnknownKeys(item, ["attachmentId", "attempts", "lastSentAt", "nextRetryAt"], label);
    if (typeof item.attachmentId !== "string" || !item.attachmentId.trim()
      || attachmentIds.has(item.attachmentId)
      || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 1) {
      throw new Error(`${label} are invalid.`);
    }
    attachmentIds.add(item.attachmentId);
    requireTimestamp(item.lastSentAt, `${label} lastSentAt`);
    requireTimestamp(item.nextRetryAt, `${label} nextRetryAt`);
  }
}

function validateArtifactDeliveryAttempts(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Teti Task Artifact delivery attempts are invalid.");
  }
  const artifactIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Teti Task Artifact delivery attempts are invalid.");
    rejectUnknownKeys(
      item,
      ["artifactId", "attempts", "lastSentAt", "nextRetryAt"],
      "Teti Task Artifact delivery attempt"
    );
    if (typeof item.artifactId !== "string"
      || !item.artifactId.trim()
      || artifactIds.has(item.artifactId)
      || !Number.isSafeInteger(item.attempts)
      || Number(item.attempts) < 1) {
      throw new Error("Teti Task Artifact delivery attempts are invalid.");
    }
    artifactIds.add(item.artifactId);
    requireTimestamp(item.lastSentAt, "Teti Task Artifact attempt lastSentAt");
    requireTimestamp(item.nextRetryAt, "Teti Task Artifact attempt nextRetryAt");
  }
}

function validateApplicationDeliveryAttempts(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Teti Task application delivery attempts are invalid.");
  }
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Teti Task application delivery attempts are invalid.");
    rejectUnknownKeys(
      item,
      ["kind", "referenceId", "attempts", "lastSentAt", "nextRetryAt"],
      "Teti Task application delivery attempt"
    );
    const key = `${String(item.kind)}:${String(item.referenceId)}`;
    if (!isApplicationDeliveryKind(item.kind)
      || typeof item.referenceId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.referenceId)
      || keys.has(key)
      || !Number.isSafeInteger(item.attempts)
      || Number(item.attempts) < 1) {
      throw new Error("Teti Task application delivery attempts are invalid.");
    }
    keys.add(key);
    requireTimestamp(item.lastSentAt, "Teti Task application attempt lastSentAt");
    requireTimestamp(item.nextRetryAt, "Teti Task application attempt nextRetryAt");
  }
}

function validateApplicationDeliveryFailures(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Teti Task application delivery failures are invalid.");
  }
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error("Teti Task application delivery failures are invalid.");
    rejectUnknownKeys(
      item,
      ["kind", "referenceId", "failedAt", "safeErrorCode"],
      "Teti Task application delivery failure"
    );
    const key = `${String(item.kind)}:${String(item.referenceId)}`;
    if ((item.kind !== "request" && !isApplicationDeliveryKind(item.kind))
      || typeof item.referenceId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.referenceId)
      || keys.has(key)
      || typeof item.safeErrorCode !== "string"
      || !/^[A-Z0-9_]{1,64}$/.test(item.safeErrorCode)) {
      throw new Error("Teti Task application delivery failures are invalid.");
    }
    keys.add(key);
    requireTimestamp(item.failedAt, "Teti Task application failure failedAt");
  }
}

function validateLatestAttentionChange(value: unknown, attentionRevision: number): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Teti Task latest attention change is invalid.");
  rejectUnknownKeys(
    value,
    ["revision", "kind", "occurredAt", "stageIndex", "safeErrorCode"],
    "Teti Task latest attention change"
  );
  if (!Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || Number(value.revision) > attentionRevision
    || ![
      "status_updated", "delivery_failed", "delivery_recovered", "input_received",
      "stage_started", "stage_completed", "stage_failed", "pause_requested", "cancel_requested",
      "paused", "resumed",
      "renewed", "completed", "failed", "rejected", "canceled", "expired"
    ].includes(String(value.kind))) {
    throw new Error("Teti Task latest attention change is invalid.");
  }
  requireTimestamp(value.occurredAt, "Teti Task latest attention occurredAt");
  if (value.stageIndex !== undefined
    && (!Number.isSafeInteger(value.stageIndex) || Number(value.stageIndex) < 1
      || Number(value.stageIndex) > LONG_HORIZON_LIMITS.maximumStages)) {
    throw new Error("Teti Task latest attention stage is invalid.");
  }
  if (value.safeErrorCode !== undefined
    && (typeof value.safeErrorCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value.safeErrorCode))) {
    throw new Error("Teti Task latest attention error is invalid.");
  }
}

function isApplicationDeliveryKind(value: unknown): boolean {
  return value === "status" || value === "input" || value === "control";
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
