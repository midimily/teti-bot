import { createHash, randomUUID } from "node:crypto";
import type { TetiAccountStorage } from "../../../../../core/account/storage.ts";
import type { TetiApplicationManager } from "../../../../../core/application/manager.ts";
import type { TetiConnectionStorage } from "../../../../../core/connection/storage.ts";
import { TetiConnectionState, type TetiConnectionRecord } from "../../../../../core/connection/types.ts";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";
import type { TetiApplicationEnvelope } from "../../../../../core/protocol/types.ts";
import {
  DEFAULT_TASK_REQUEST_TTL_MS,
  MAX_TASK_CLOCK_SKEW_MS,
  MAX_TASK_TRANSPORT_RECORDS,
  TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS,
  type CollaborationTaskTransportRecord,
  type CollaborationTaskSummarySnapshot,
  type CollaborationTaskTransportSnapshot,
  type SendCollaborationTaskInput,
  type TetiTaskArtifactPayload,
  type TetiTaskAttachmentPayload,
  type TetiTaskAttachmentReceiptPayload,
  type TetiTaskCancelPayload,
  type TetiTaskReceiptPayload,
  type TetiTaskStatusPayload,
  type TetiTaskTransportStoreState
} from "../../../../../core/task/transport.ts";
import {
  canonicalTaskRequestJson,
  selectTaskProtocolVersion,
  validateTaskProtocolVersions
} from "../../../../../core/task/transport-validation.ts";
import {
  MAX_TASK_INPUT_TEXT_BYTES,
  MAX_TASK_REQUEST_TTL_MS,
  taskArtifactImages,
  taskInputText,
  taskInputImages,
  type CollaborationTaskArtifact,
  type CollaborationTaskRequest,
  type CollaborationTaskInput,
  type ExecutionGrant,
  type TaskImagePart
} from "../../../../../core/task/types.ts";
import {
  validateCollaborationTaskRequest,
  validateExecutionGrant,
  validateTaskArtifact,
  validateTaskImagePart
} from "../../../../../core/task/validation.ts";
import type {
  CallableAdapterTaskRequest,
  CallableAdapterTaskSnapshot
} from "../../../../../core/callability/adapter.ts";
import {
  issueExecutionAuthority,
  TETI_LOCAL_TEXT_COMPUTE_OFFER_ID,
  type ExecutionAuthority
} from "../../../../../core/callability/agent-core.ts";
import type {
  ExecutionHandle,
  PrepareExecutionHandleInput
} from "../../../../../core/callability/execution.ts";
import type {
  TaskWorkspaceBinding,
  TaskWorkspaceRequest
} from "../../../../../core/workspace/types.ts";
import { WORKSPACE_LIMITS } from "../../../../../core/workspace/types.ts";
import { validateTaskWorkspaceRequest } from "../../../../../core/workspace/validation.ts";
import type { TaskTransportStore } from "./store.ts";
import type { StagedTaskImage, TaskAttachmentStore } from "./attachments.ts";
import type { CollaborationWorkspaceStore } from "../workspaces/store.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ATTACHMENT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

export class TaskTransportRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface TaskTransportRuntimeOptions {
  accountStorage: TetiAccountStorage;
  connectionStorage: TetiConnectionStorage;
  applicationManager: TetiApplicationManager;
  store: TaskTransportStore;
  now?: () => Date;
  taskIdFactory?: () => string;
  attachmentStore?: TaskAttachmentStore;
  workspaceStore?: CollaborationWorkspaceStore;
  executor?: TaskExecutionBridge;
  enqueueOperation?: (operation: () => Promise<void>) => Promise<void>;
}

export interface TaskExecutionTarget {
  connectorId: string;
  childAgentId: string;
  capabilityId: string;
}

export interface TaskExecutionBridge {
  resolveTarget(
    offerId: string,
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[]
  ): TaskExecutionTarget | null;
  execute(
    request: CallableAdapterTaskRequest,
    authority: ExecutionAuthority
  ): Promise<CallableAdapterTaskSnapshot>;
  getTask(taskId: string): CallableAdapterTaskSnapshot | null;
  cancel(taskId: string): boolean;
  prepareExecution?(input: PrepareExecutionHandleInput): Promise<ExecutionHandle>;
  getExecutionHandle?(taskId: string): Promise<ExecutionHandle | null>;
  reconcileExecutionHandles?(): Promise<ExecutionHandle[]>;
}

export class TaskTransportRuntime {
  private readonly accountStorage: TetiAccountStorage;
  private readonly connectionStorage: TetiConnectionStorage;
  private readonly applicationManager: TetiApplicationManager;
  private readonly store: TaskTransportStore;
  private readonly now: () => Date;
  private readonly taskIdFactory: () => string;
  private readonly attachmentStore?: TaskAttachmentStore;
  private readonly workspaceStore?: CollaborationWorkspaceStore;
  private readonly executor?: TaskExecutionBridge;
  private readonly enqueueOperation: (operation: () => Promise<void>) => Promise<void>;

  constructor(options: TaskTransportRuntimeOptions) {
    this.accountStorage = options.accountStorage;
    this.connectionStorage = options.connectionStorage;
    this.applicationManager = options.applicationManager;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.taskIdFactory = options.taskIdFactory ?? randomUUID;
    this.attachmentStore = options.attachmentStore;
    this.workspaceStore = options.workspaceStore;
    this.executor = options.executor;
    this.enqueueOperation = options.enqueueOperation ?? ((operation) => operation());
  }

  async stageImage(sourcePath: string): Promise<StagedTaskImage> {
    if (!this.attachmentStore) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_UNAVAILABLE", "Task image attachments are unavailable.");
    }
    return this.attachmentStore.stageImage(sourcePath);
  }

  async list(): Promise<CollaborationTaskTransportSnapshot> {
    const state = await this.store.load();
    const changed = await this.reconcileInterruptedExecutions(state);
    if (expireDueRecords(state, this.now()) || changed) await this.store.save(state);
    return snapshot(state, this.now());
  }

  async listSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    const state = await this.store.load();
    let changed = await this.reconcileInterruptedExecutions(state);
    changed = await this.refreshAttachmentReadiness(state) || changed;
    changed = expireDueRecords(state, this.now()) || changed;
    if (changed) await this.store.save(state);
    const connections = await this.connectionStorage.loadAll();
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      pendingIncomingCount: state.records.filter((record) =>
        record.direction === "incoming"
        && record.approval === "pending"
        && record.state === "submitted"
      ).length,
      tasks: state.records
        .map((record) => ({
          taskId: record.request.taskId,
          direction: record.direction,
          peerTetiId: record.peerTetiId,
          connectionRequestId: connections.find((connection) =>
            connection.state === TetiConnectionState.Confirmed
            && connection.remoteTetiId === record.peerTetiId
          )?.requestId,
          capabilityId: record.request.capabilityId,
          textPreview: taskInputText(record.request.input).slice(0, 240),
          imageCount: taskInputImages(record.request.input).length,
          receivedImageCount: receivedInputImageCount(record),
          artifactCount: record.artifactAttachmentsReady === false ? 0 : record.artifacts?.length ?? 0,
          state: record.state,
          approval: record.approval,
          delivery: record.delivery,
          attachmentsReady: record.attachmentsReady ?? taskInputImages(record.request.input).length === 0,
          cancelPending: record.cancelPending ?? false,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          expiresAt: record.request.expiresAt,
          safeErrorCode: record.safeErrorCode
        }))
        .sort(compareTaskSummaries)
        .slice(0, 100)
    };
  }

  async get(taskId: string): Promise<CollaborationTaskTransportRecord> {
    if (!SAFE_ID_PATTERN.test(taskId)) {
      throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task ID is invalid.");
    }
    const state = await this.store.load();
    let changed = await this.reconcileInterruptedExecutions(state);
    changed = await this.refreshAttachmentReadiness(state) || changed;
    changed = expireDueRecords(state, this.now()) || changed;
    if (changed) await this.store.save(state);
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
    return structuredClone(record);
  }

  async resolveTaskImage(taskId: string, attachmentId: string): Promise<string> {
    const record = await this.get(taskId);
    const inputPart = taskInputImages(record.request.input).find((image) => image.attachmentId === attachmentId);
    const artifactPart = (record.artifacts ?? [])
      .flatMap(taskArtifactImages)
      .find((image) => image.attachmentId === attachmentId);
    const part = inputPart ?? artifactPart;
    if (!part || !this.attachmentStore) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENT_NOT_FOUND", "Task image was not found.");
    }
    if (inputPart && record.direction === "outgoing") {
      return (await this.attachmentStore.getStagedImage(part)).path;
    }
    const path = await this.attachmentStore.resolveImage({
      taskId,
      purpose: inputPart ? "input" : "artifact",
      part
    });
    if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENT_NOT_FOUND", "Task image is unavailable.");
    return path;
  }

  async getExecutionHandle(taskId: string): Promise<ExecutionHandle | null> {
    const record = await this.get(taskId);
    if (record.direction !== "incoming") return null;
    return structuredClone(await this.executor?.getExecutionHandle?.(taskId) ?? null);
  }

  async observePeerVersions(
    tetiId: string,
    versions: readonly number[],
    observedAt: string
  ): Promise<void> {
    if (!isCanonicalTetiPublicId(tetiId)) return;
    validateTaskProtocolVersions(versions);
    if (!Number.isFinite(Date.parse(observedAt))) return;
    const state = await this.store.load();
    rememberPeerVersions(state, tetiId, versions, observedAt);
    await this.store.save(state);
  }

  async send(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    const normalized = validateSendInput(input);
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const connection = await this.requireConfirmedConnection(normalized.connectionRequestId);
    const state = await this.store.load();
    expireDueRecords(state, this.now());
    const taskId = normalized.taskId ?? this.taskIdFactory();
    const existing = state.records.find(
      (record) => record.direction === "outgoing"
        && record.request.requesterTetiId === account.id
        && record.request.taskId === taskId
    );
    if (existing) {
      requireMatchingRetry(existing, connection, normalized);
      if (existing.delivery === "queued" || existing.delivery === "send_failed") {
        return this.sendStoredRecord(state, existing);
      }
      return structuredClone(existing);
    }

    const remote = state.peers.find((peer) => peer.tetiId === connection.remoteTetiId);
    const protocolVersion = selectTaskProtocolVersion(remote?.supportedVersions);
    if (!protocolVersion) {
      throw new TaskTransportRuntimeError(
        "TASK_PEER_UNSUPPORTED",
        "The confirmed Teti does not support a compatible Task version."
      );
    }
    if (normalized.attachments.length > 0 && protocolVersion < 2) {
      throw new TaskTransportRuntimeError(
        "TASK_PEER_IMAGE_UNSUPPORTED",
        "The confirmed Teti has not advertised image Task support yet."
      );
    }
    if (normalized.capabilityId === "image-editing" && protocolVersion < 3) {
      throw new TaskTransportRuntimeError(
        "TASK_PEER_IMAGE_RESULT_UNSUPPORTED",
        "The confirmed Teti has not advertised image result support yet."
      );
    }
    if (!ensureCapacity(state, this.now())) {
      throw new TaskTransportRuntimeError("TASK_STORE_CAPACITY", "The local Task queue is full.");
    }
    const createdAt = this.now();
    const request: CollaborationTaskRequest = {
      schemaVersion: protocolVersion,
      taskId,
      requesterTetiId: account.id,
      targetTetiId: connection.remoteTetiId,
      offerId: normalized.offerId ?? `capability:${normalized.capabilityId}`,
      capabilityId: normalized.capabilityId,
      input: taskInputForVersion(protocolVersion, normalized.text, normalized.attachments),
      workspace: structuredClone(normalized.workspace),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + normalized.ttlMs).toISOString()
    };
    validateCollaborationTaskRequest(request);
    const record: CollaborationTaskTransportRecord = {
      schemaVersion: 1,
      direction: "outgoing",
      peerTetiId: connection.remoteTetiId,
      protocolVersion,
      request,
      state: "submitted",
      approval: "pending",
      delivery: "queued",
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
      attachmentsReady: true,
      attachmentDiagnostics: createAttachmentDiagnostics("input", taskInputImages(request.input))
    };
    state.records.push(record);
    await this.store.save(state);
    return this.sendStoredRecord(state, record);
  }

  async receiveRequest(input: {
    envelope: TetiApplicationEnvelope<CollaborationTaskRequest>;
    connection: TetiConnectionRecord;
    chatmailMessageId?: number;
    receivedAt?: string;
  }): Promise<TetiTaskReceiptPayload> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const request = input.envelope.payload;
    validateCollaborationTaskRequest(request);
    if (input.envelope.fromTetiId !== request.requesterTetiId
      || input.connection.remoteTetiId !== request.requesterTetiId
      || request.targetTetiId !== account.id) {
      throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task identity binding is invalid.");
    }
    const receivedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    const state = await this.store.load();
    expireDueRecords(state, this.now());
    rememberPeerVersions(state, request.requesterTetiId, [request.schemaVersion], receivedAt, true);
    const existing = state.records.find(
      (record) => record.direction === "incoming"
        && record.request.requesterTetiId === request.requesterTetiId
        && record.request.taskId === request.taskId
    );
    let status: TetiTaskReceiptPayload["status"];
    if (existing) {
      status = canonicalTaskRequestJson(existing.request) === canonicalTaskRequestJson(request)
        ? "duplicate"
        : "conflict";
    } else if (!(TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS as readonly number[]).includes(request.schemaVersion)) {
      status = "rejected";
      if (ensureCapacity(state, this.now())) {
        state.records.push(incomingRecord(input, receivedAt, "rejected"));
      }
    } else if (Date.parse(request.createdAt) > this.now().getTime() + MAX_TASK_CLOCK_SKEW_MS) {
      status = "rejected";
      if (ensureCapacity(state, this.now())) {
        state.records.push(incomingRecord(input, receivedAt, "rejected"));
      }
    } else if (Date.parse(request.expiresAt) <= this.now().getTime()) {
      status = "expired";
      if (ensureCapacity(state, this.now())) {
        state.records.push(incomingRecord(input, receivedAt, "expired"));
      }
    } else if (!ensureCapacity(state, this.now())) {
      status = "rejected";
    } else {
      status = "received";
      state.records.push(incomingRecord(input, receivedAt, "received"));
    }
    const receipt = createReceipt(request, account.id, status, receivedAt);
    const stored = state.records.find(
      (record) => record.direction === "incoming"
        && record.request.requesterTetiId === request.requesterTetiId
        && record.request.taskId === request.taskId
    );
    if (stored && status !== "conflict") {
      stored.receipt = receipt;
      stored.receiptPending = true;
      stored.updatedAt = receivedAt;
    }
    await this.store.save(state);
    return receipt;
  }

  async receiveReceipt(input: {
    envelope: TetiApplicationEnvelope<TetiTaskReceiptPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const receipt = input.envelope.payload;
    if (input.envelope.fromTetiId !== receipt.targetTetiId
      || input.connection.remoteTetiId !== receipt.targetTetiId
      || receipt.requesterTetiId !== account.id) {
      throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task receipt identity binding is invalid.");
    }
    const state = await this.store.load();
    const observedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    if (Date.parse(receipt.receivedAt) > this.now().getTime() + MAX_TASK_CLOCK_SKEW_MS) {
      throw new TaskTransportRuntimeError(
        "TASK_CLOCK_SKEW",
        "Task receipt timestamp is too far in the future."
      );
    }
    rememberPeerVersions(state, receipt.targetTetiId, receipt.supportedTaskVersions, observedAt);
    const record = state.records.find(
      (candidate) => candidate.direction === "outgoing"
        && candidate.request.requesterTetiId === receipt.requesterTetiId
        && candidate.request.taskId === receipt.taskId
        && candidate.request.targetTetiId === receipt.targetTetiId
    );
    if (record && shouldApplyReceipt(record, receipt)) applyReceipt(record, receipt, observedAt);
    await this.store.save(state);
  }

  async receiveAttachment(input: {
    envelope: TetiApplicationEnvelope<TetiTaskAttachmentPayload>;
    connection: TetiConnectionRecord;
    filePath: string;
    receivedAt?: string;
  }): Promise<TetiTaskAttachmentReceiptPayload | null> {
    if (!this.attachmentStore) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_UNAVAILABLE", "Task image attachments are unavailable.");
    }
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    if (Date.parse(payload.expiresAt) <= this.now().getTime()) return null;
    const state = await this.store.load();
    const receivedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    if (payload.purpose === "artifact") {
      requireOutboundTaskIdentity(input.envelope, input.connection, account.id, payload);
      const record = findTaskRecord(state, "outgoing", account.id, payload.taskId);
      if (!record) {
        throw new TaskTransportRuntimeError(
          "TASK_DEPENDENCY_PENDING",
          "Task Artifact attachment is waiting for its local Task record."
        );
      }
      if (record.protocolVersion < 3 || ["failed", "canceled", "rejected"].includes(record.state)) return null;
      const artifact = record.artifacts?.find((candidate) => candidate.artifactId === payload.artifactId);
      if (artifact) {
        const declared = taskArtifactImages(artifact).find(
          (part) => part.attachmentId === payload.part.attachmentId
        );
        if (!declared || !sameImagePart(declared, payload.part)) {
          throw new TaskTransportRuntimeError(
            "TASK_ATTACHMENT_CONFLICT",
            "Task Artifact attachment does not match its immutable manifest."
          );
        }
      }
      await this.attachmentStore.ingestImage({
        taskId: payload.taskId,
        purpose: "artifact",
        part: payload.part,
        sourcePath: input.filePath
      });
      markAttachmentStored(record, "artifact", payload.part, receivedAt);
      if (artifact) record.artifactAttachmentsReady = await this.areArtifactAttachmentsReady(record);
      record.updatedAt = receivedAt;
      await this.store.save(state);
      return payload.deliveryReceiptRequested
        ? createAttachmentReceipt(payload, receivedAt)
        : null;
    }
    requireInboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    const record = findTaskRecord(state, "incoming", payload.requesterTetiId, payload.taskId);
    if (record) {
      const declared = taskInputImages(record.request.input).find(
        (part) => part.attachmentId === payload.part.attachmentId
      );
      if (!declared || !sameImagePart(declared, payload.part)) {
        throw new TaskTransportRuntimeError(
          "TASK_ATTACHMENT_CONFLICT",
          "Task attachment does not match the immutable request."
        );
      }
      if (isTerminalTaskState(record.state)) {
        const stored = await this.attachmentStore.resolveImage({
          taskId: payload.taskId,
          purpose: "input",
          part: payload.part
        });
        return stored && payload.deliveryReceiptRequested
          ? createAttachmentReceipt(payload, receivedAt)
          : null;
      }
    }
    await this.attachmentStore.ingestImage({
      taskId: payload.taskId,
      purpose: "input",
      part: payload.part,
      sourcePath: input.filePath
    });
    if (record) {
      markAttachmentStored(record, "input", payload.part, receivedAt);
      record.attachmentsReady = await this.areInputAttachmentsReady(record);
      record.updatedAt = receivedAt;
      await this.store.save(state);
    }
    return payload.deliveryReceiptRequested
      ? createAttachmentReceipt(payload, receivedAt)
      : null;
  }

  async receiveAttachmentReceipt(input: {
    envelope: TetiApplicationEnvelope<TetiTaskAttachmentReceiptPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const receipt = input.envelope.payload;
    const state = await this.store.load();
    const record = receipt.purpose === "input"
      ? findTaskRecord(state, "outgoing", account.id, receipt.taskId)
      : findTaskRecord(state, "incoming", receipt.requesterTetiId, receipt.taskId);
    if (!record || record.protocolVersion < 4) return;
    if (receipt.purpose === "input") {
      if (input.envelope.fromTetiId !== receipt.targetTetiId
        || input.connection.remoteTetiId !== receipt.targetTetiId
        || receipt.requesterTetiId !== account.id
        || record.request.targetTetiId !== receipt.targetTetiId
        || !taskInputImages(record.request.input).some((part) => part.attachmentId === receipt.attachmentId)) {
        throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task attachment receipt binding is invalid.");
      }
      record.acknowledgedAttachmentIds = appendUnique(
        record.acknowledgedAttachmentIds,
        receipt.attachmentId
      );
      record.attachmentDeliveryAttempts = removeDeliveryAttempt(
        record.attachmentDeliveryAttempts,
        receipt.attachmentId
      );
      markAttachmentAcknowledged(record, "input", receipt.attachmentId, receipt.receivedAt);
    } else {
      const artifact = record.artifacts?.find((item) => item.artifactId === receipt.artifactId);
      if (input.envelope.fromTetiId !== receipt.requesterTetiId
        || input.connection.remoteTetiId !== receipt.requesterTetiId
        || receipt.targetTetiId !== account.id
        || record.request.requesterTetiId !== receipt.requesterTetiId
        || !artifact
        || !taskArtifactImages(artifact).some((part) => part.attachmentId === receipt.attachmentId)) {
        throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task Artifact receipt binding is invalid.");
      }
      record.acknowledgedArtifactAttachmentIds = appendUnique(
        record.acknowledgedArtifactAttachmentIds,
        receipt.attachmentId
      );
      record.artifactAttachmentDeliveryAttempts = removeDeliveryAttempt(
        record.artifactAttachmentDeliveryAttempts,
        receipt.attachmentId
      );
      markAttachmentAcknowledged(record, "artifact", receipt.attachmentId, receipt.receivedAt);
    }
    record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    await this.store.save(state);
  }

  async receiveStatus(input: {
    envelope: TetiApplicationEnvelope<TetiTaskStatusPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    requireOutboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    const state = await this.store.load();
    const record = findTaskRecord(state, "outgoing", account.id, payload.taskId);
    if (!record
      || payload.revision <= (record.statusRevision ?? 0)
      || !isRemoteTransitionAllowed(record.state, payload.state)) return;
    record.statusRevision = payload.revision;
    record.state = payload.state;
    record.cancelPending = false;
    delete record.cancelSentAt;
    record.approval = payload.state === "rejected"
      ? "rejected"
      : ["working", "completed", "failed", "auth_required", "input_required"].includes(payload.state)
        ? "approved_once"
        : record.approval;
    record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    if (payload.safeErrorCode) record.safeErrorCode = payload.safeErrorCode;
    else delete record.safeErrorCode;
    await this.store.save(state);
  }

  async receiveArtifact(input: {
    envelope: TetiApplicationEnvelope<TetiTaskArtifactPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    requireOutboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    validateTaskArtifact(payload.artifact);
    const state = await this.store.load();
    const record = findTaskRecord(state, "outgoing", account.id, payload.taskId);
    if (!record) {
      if (this.now().getTime() - Date.parse(payload.createdAt) > DEFAULT_TASK_REQUEST_TTL_MS) return;
      throw new TaskTransportRuntimeError(
        "TASK_DEPENDENCY_PENDING",
        "Task Artifact is waiting for its local Task record."
      );
    }
    if (["failed", "canceled", "rejected"].includes(record.state)) return;
    const imageParts = taskArtifactImages(payload.artifact);
    if (imageParts.length > 0 && record.protocolVersion < 3) {
      throw new TaskTransportRuntimeError("TASK_ARTIFACT_UNSUPPORTED", "Peer sent image output without Task v3.");
    }
    const existing = record.artifacts?.[0];
    if (existing && JSON.stringify(existing) !== JSON.stringify(payload.artifact)) {
      throw new TaskTransportRuntimeError("TASK_ARTIFACT_CONFLICT", "Task Artifact conflicts with the stored result.");
    }
    if (!existing) record.artifacts = [structuredClone(payload.artifact)];
    initializeAttachmentDiagnostics(record, "artifact", imageParts);
    record.artifactAttachmentsReady = await this.areArtifactAttachmentsReady(record);
    record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    await this.store.save(state);
  }

  async receiveCancel(input: {
    envelope: TetiApplicationEnvelope<TetiTaskCancelPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    requireInboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    const state = await this.store.load();
    const record = findTaskRecord(state, "incoming", payload.requesterTetiId, payload.taskId);
    if (!record || isTerminalTaskState(record.state)) return;
    this.executor?.cancel(payload.taskId);
    record.state = "canceled";
    record.approval = record.approval === "pending" ? "rejected" : record.approval;
    record.statusPending = true;
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    record.safeErrorCode = "TASK_CANCELED_BY_REQUESTER";
    await this.store.save(state);
  }

  async approve(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireMutableIncomingTask(state, taskId, this.now());
    record.attachmentsReady = await this.areInputAttachmentsReady(record);
    if (!record.attachmentsReady) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images have not finished downloading.");
    }
    if (!this.executor) {
      throw new TaskTransportRuntimeError("TASK_EXECUTOR_UNAVAILABLE", "No callable Agent Runtime is available.");
    }
    const images = taskInputImages(record.request.input);
    const target = this.executor.resolveTarget(
      record.request.offerId,
      record.request.capabilityId,
      images.length > 0 ? ["text", "image"] : ["text"]
    );
    if (!target) {
      throw new TaskTransportRuntimeError("TASK_CAPABILITY_UNAVAILABLE", "No local callable Agent can run this capability.");
    }
    const imageInputs = await Promise.all(images.map(async (part) => {
      const path = await this.attachmentStore?.resolveImage({
        taskId: record.request.taskId,
        purpose: "input",
        part
      });
      if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images are unavailable.");
      return { attachmentId: part.attachmentId, mimeType: part.mimeType, path };
    }));
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const workspaceBinding = await this.resolveWorkspaceBinding(record.request, account.id);
    record.workspaceBinding = workspaceBinding;
    const executionHandle = await this.executor.prepareExecution?.({
      taskId: record.request.taskId,
      workspaceId: workspaceBinding.workspaceId,
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      resume: false
    });
    const grant = createExecutionGrant(record.request, target, workspaceBinding, this.now());
    validateExecutionGrant(grant);
    record.approval = "consumed";
    record.state = "working";
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = this.now().toISOString();
    delete record.safeErrorCode;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    const execution: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId: record.request.taskId,
      adapterId: target.connectorId,
      agentId: target.childAgentId,
      capabilityId: target.capabilityId,
      input: {
        kind: imageInputs.length > 0 ? "parts" : "text",
        text: taskInputText(record.request.input),
        images: imageInputs
      },
      createdAt: this.now().toISOString()
    };
    const executionEpoch = executionHandle?.executionEpoch ?? 1;
    const authority = createExecutionAuthority(grant, execution, target, executionEpoch);
    void this.executor.execute(execution, authority).then(
      (result) => this.enqueueOperation(() => this.finishExecution(
        record.request.taskId,
        result,
        executionEpoch
      )),
      () => this.enqueueOperation(() => this.finishExecution(
        record.request.taskId,
        null,
        executionEpoch
      ))
    ).catch(() => undefined);
    return structuredClone(record);
  }

  private async resolveWorkspaceBinding(
    request: CollaborationTaskRequest,
    localTetiId: string
  ): Promise<TaskWorkspaceBinding> {
    if (request.offerId === TETI_LOCAL_TEXT_COMPUTE_OFFER_ID) {
      if (request.workspace?.kind === "reference") {
        throw new TaskTransportRuntimeError(
          "TASK_COMPUTE_WORKSPACE_UNSUPPORTED",
          "Receiver-local compute cannot access a Collaboration Workspace."
        );
      }
      return {
        workspaceId: `workspace:none.${request.taskId}`,
        workspaceRevision: 1,
        mode: "ephemeral_task",
        access: ["read"]
      };
    }
    if (!this.workspaceStore) {
      // Dependency-injected unit runtimes retain an isolated local seam. The
      // production sidecar always supplies the persistent Workspace Store.
      return {
        workspaceId: `workspace:${request.taskId}`,
        workspaceRevision: 1,
        mode: "ephemeral_task",
        access: [...(request.workspace?.access ?? ["read", "write", "create_artifact"])]
      };
    }
    const workspaceRequest = request.workspace ?? {
      kind: "temporary" as const,
      access: ["read", "write", "create_artifact"] as const
    };
    if (workspaceRequest.kind === "temporary") {
      const maximumExpiry = this.now().getTime() + WORKSPACE_LIMITS.maximumEphemeralTtlMs;
      const workspace = await this.workspaceStore.create({
        ownerTetiId: localTetiId,
        participantTetiIds: [request.requesterTetiId],
        mode: "ephemeral_task",
        retentionPolicy: {
          kind: "ttl",
          expiresAt: new Date(Math.min(Date.parse(request.expiresAt), maximumExpiry)).toISOString()
        }
      });
      return {
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.revision,
        mode: workspace.mode,
        access: [...workspaceRequest.access]
      };
    }
    const workspace = await this.workspaceStore.get(workspaceRequest.workspaceId);
    if (!workspace || workspace.revision !== workspaceRequest.workspaceRevision) {
      throw new TaskTransportRuntimeError(
        "TASK_WORKSPACE_REVISION_UNAVAILABLE",
        "The confirmed Collaboration Workspace revision is unavailable."
      );
    }
    const members = new Set([workspace.ownerTetiId, ...workspace.participantTetiIds]);
    if (!members.has(localTetiId) || !members.has(request.requesterTetiId)) {
      throw new TaskTransportRuntimeError(
        "TASK_WORKSPACE_ACCESS_DENIED",
        "The Collaboration Workspace is not confirmed for both Tetis."
      );
    }
    return {
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.revision,
      mode: workspace.mode,
      access: [...workspaceRequest.access]
    };
  }

  async reject(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireMutableIncomingTask(state, taskId, this.now());
    record.approval = "rejected";
    record.state = "rejected";
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.safeErrorCode = "TASK_REJECTED_BY_USER";
    record.updatedAt = this.now().toISOString();
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async cancel(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
    if (isTerminalTaskState(record.state)) return structuredClone(record);
    if (record.direction === "incoming") {
      this.executor?.cancel(taskId);
      record.state = "canceled";
      record.statusRevision = (record.statusRevision ?? 0) + 1;
      record.statusPending = true;
      record.safeErrorCode = "TASK_CANCELED_BY_USER";
    } else {
      record.cancelPending = true;
    }
    record.updatedAt = this.now().toISOString();
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async resume(taskId: string): Promise<CollaborationTaskTransportRecord> {
    if (!SAFE_ID_PATTERN.test(taskId)) {
      throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task ID is invalid.");
    }
    const state = await this.store.load();
    const record = state.records.find((candidate) =>
      candidate.direction === "incoming" && candidate.request.taskId === taskId
    );
    if (!record || record.state !== "input_required" || !record.workspaceBinding) {
      throw new TaskTransportRuntimeError("TASK_RESUME_UNAVAILABLE", "Task cannot be resumed.");
    }
    if (!this.executor?.prepareExecution || !this.executor.getExecutionHandle) {
      throw new TaskTransportRuntimeError("TASK_RESUME_UNAVAILABLE", "Durable execution is unavailable.");
    }
    const previous = await this.executor.getExecutionHandle(taskId);
    if (!previous || previous.resumeCapability !== "checkpoint_restart") {
      throw new TaskTransportRuntimeError("TASK_RESUME_UNAVAILABLE", "No explicit checkpoint is available.");
    }
    const images = taskInputImages(record.request.input);
    const target = this.executor.resolveTarget(
      record.request.offerId,
      record.request.capabilityId,
      images.length > 0 ? ["text", "image"] : ["text"]
    );
    if (!target
      || target.connectorId !== previous.connectorId
      || target.childAgentId !== previous.childAgentId) {
      throw new TaskTransportRuntimeError("TASK_RESUME_UNAVAILABLE", "The original Child Agent is unavailable.");
    }
    const imageInputs = await Promise.all(images.map(async (part) => {
      const path = await this.attachmentStore?.resolveImage({
        taskId,
        purpose: "input",
        part
      });
      if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images are unavailable.");
      return { attachmentId: part.attachmentId, mimeType: part.mimeType, path };
    }));
    const executionHandle = await this.executor.prepareExecution({
      taskId,
      workspaceId: record.workspaceBinding.workspaceId,
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      resume: true
    });
    const grant = createExecutionGrant(record.request, target, record.workspaceBinding, this.now());
    const execution: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId,
      adapterId: target.connectorId,
      agentId: target.childAgentId,
      capabilityId: target.capabilityId,
      input: {
        kind: imageInputs.length > 0 ? "parts" : "text",
        text: taskInputText(record.request.input),
        images: imageInputs
      },
      createdAt: this.now().toISOString()
    };
    const authority = createExecutionAuthority(
      grant,
      execution,
      target,
      executionHandle.executionEpoch
    );
    record.state = "working";
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = this.now().toISOString();
    delete record.safeErrorCode;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    void this.executor.execute(execution, authority).then(
      (result) => this.enqueueOperation(() => this.finishExecution(
        taskId,
        result,
        executionHandle.executionEpoch
      )),
      () => this.enqueueOperation(() => this.finishExecution(
        taskId,
        null,
        executionHandle.executionEpoch
      ))
    ).catch(() => undefined);
    return structuredClone(record);
  }

  async flushOutbox(): Promise<void> {
    const state = await this.store.load();
    await this.reconcileInterruptedExecutions(state);
    expireDueRecords(state, this.now());
    for (const record of state.records) {
      if (record.direction === "outgoing"
        && (record.delivery === "queued" || record.delivery === "send_failed")) {
        await this.trySendStoredRecord(state, record);
      }
      if (record.direction === "outgoing" && record.protocolVersion >= 4) {
        await this.trySendInputAttachments(state, record);
      }
      if (record.direction === "incoming" && record.receiptPending && record.receipt) {
        try {
          const connection = await this.findConfirmedConnectionForPeer(record.peerTetiId);
          if (!connection) continue;
          await this.applicationManager.sendTaskReceipt(connection.requestId, record.receipt);
          record.receiptPending = false;
          record.updatedAt = this.now().toISOString();
          await this.store.save(state);
        } catch {
          // Durable receipt remains pending for the next Runtime poll.
        }
      }
      await this.trySendPendingForRecord(state, record);
    }
    await this.refreshAttachmentReadiness(state);
    await this.attachmentStore?.cleanup(this.now()).catch(() => undefined);
    await this.workspaceStore?.cleanup(this.now()).catch(() => undefined);
    await this.store.save(state);
  }

  async markReceiptSent(taskId: string, requesterTetiId: string): Promise<void> {
    const state = await this.store.load();
    const record = state.records.find(
      (candidate) => candidate.direction === "incoming"
        && candidate.request.taskId === taskId
        && candidate.request.requesterTetiId === requesterTetiId
    );
    if (!record) return;
    record.receiptPending = false;
    record.updatedAt = this.now().toISOString();
    await this.store.save(state);
  }

  private async refreshAttachmentReadiness(state: TetiTaskTransportStoreState): Promise<boolean> {
    let changed = false;
    for (const record of state.records) {
      if (record.direction !== "incoming" || isTerminalTaskState(record.state)) continue;
      const ready = await this.areInputAttachmentsReady(record);
      if (record.attachmentsReady !== ready) {
        record.attachmentsReady = ready;
        changed = true;
      }
    }
    return changed;
  }

  private async reconcileInterruptedExecutions(state: TetiTaskTransportStoreState): Promise<boolean> {
    await this.executor?.reconcileExecutionHandles?.();
    let changed = false;
    for (const record of state.records) {
      if (!(TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS as readonly number[]).includes(record.protocolVersion)
        && !isTerminalTaskState(record.state)) {
        record.state = "rejected";
        record.approval = "rejected";
        record.delivery = "rejected";
        record.safeErrorCode = "TASK_PROTOCOL_UPGRADE_REQUIRED";
        record.receiptPending = false;
        record.statusPending = false;
        record.cancelPending = false;
        record.artifactPending = false;
        record.updatedAt = this.now().toISOString();
        changed = true;
        continue;
      }
      if (record.direction !== "incoming" || record.state !== "working") continue;
      if (this.executor?.getTask(record.request.taskId)?.state === "working") continue;
      const handle = await this.executor?.getExecutionHandle?.(record.request.taskId);
      const resumable = handle?.progress.state === "interrupted"
        && handle.resumeCapability === "checkpoint_restart";
      record.state = resumable ? "input_required" : "failed";
      record.safeErrorCode = resumable
        ? "TASK_RESUME_AVAILABLE"
        : "TASK_EXECUTION_INTERRUPTED";
      record.statusRevision = (record.statusRevision ?? 0) + 1;
      record.statusPending = true;
      record.updatedAt = this.now().toISOString();
      changed = true;
    }
    return changed;
  }

  private async areInputAttachmentsReady(record: CollaborationTaskTransportRecord): Promise<boolean> {
    const images = taskInputImages(record.request.input);
    if (images.length === 0) return true;
    if (!this.attachmentStore) return false;
    let ready = true;
    for (const part of images) {
      const path = await this.attachmentStore.resolveImage({
        taskId: record.request.taskId,
        purpose: "input",
        part
      });
      if (path) markAttachmentStored(record, "input", part, this.now().toISOString());
      else ready = false;
    }
    return ready;
  }

  private async areArtifactAttachmentsReady(record: CollaborationTaskTransportRecord): Promise<boolean> {
    const images = (record.artifacts ?? []).flatMap(taskArtifactImages);
    if (images.length === 0) return true;
    if (!this.attachmentStore) return false;
    let ready = true;
    for (const part of images) {
      const path = await this.attachmentStore.resolveImage({
        taskId: record.request.taskId,
        purpose: "artifact",
        part
      });
      if (path) markAttachmentStored(record, "artifact", part, this.now().toISOString());
      else ready = false;
    }
    return ready;
  }

  private async trySendPendingForRecord(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord
  ): Promise<void> {
    const connection = await this.findConfirmedConnectionForPeer(record.peerTetiId);
    if (!connection) return;
    if (record.direction === "incoming" && record.artifacts?.length
      && (record.artifactPending || record.protocolVersion >= 4)) {
      const artifact = record.artifacts.at(-1)!;
      for (const part of taskArtifactImages(artifact)) {
        if (!shouldSendAttachment(record, part.attachmentId, "artifact", this.now())) continue;
        if (!this.attachmentStore || record.protocolVersion < 3) return;
        const path = await this.attachmentStore.resolveImage({
          taskId: record.request.taskId,
          purpose: "artifact",
          part
        });
        if (!path) return;
        const createdAt = artifact.createdAt;
        const attachmentPayload: TetiTaskAttachmentPayload = {
          schemaVersion: 1,
          taskId: record.request.taskId,
          requesterTetiId: record.request.requesterTetiId,
          targetTetiId: record.request.targetTetiId,
          purpose: "artifact",
          artifactId: artifact.artifactId,
          part: structuredClone(part),
          createdAt,
          expiresAt: new Date(Date.parse(createdAt) + DEFAULT_TASK_REQUEST_TTL_MS).toISOString(),
          ...(record.protocolVersion >= 4 ? { deliveryReceiptRequested: true as const } : {})
        };
        try {
          await this.applicationManager.sendTaskAttachment(connection.requestId, attachmentPayload, {
            path,
            filename: taskImageFileName(part)
          });
          record.sentArtifactAttachmentIds = appendUnique(record.sentArtifactAttachmentIds, part.attachmentId);
          if (record.protocolVersion >= 4) {
            record.artifactAttachmentDeliveryAttempts = recordDeliveryAttempt(
              record.artifactAttachmentDeliveryAttempts,
              part.attachmentId,
              this.now()
            );
          }
          markAttachmentSent(record, "artifact", part, this.now().toISOString());
          await this.store.save(state);
        } catch {
          return;
        }
      }
      if (record.artifactPending) {
        const payload: TetiTaskArtifactPayload = {
          schemaVersion: 1,
          taskId: record.request.taskId,
          requesterTetiId: record.request.requesterTetiId,
          targetTetiId: record.request.targetTetiId,
          artifact: structuredClone(artifact),
          createdAt: artifact.createdAt
        };
        try {
          await this.applicationManager.sendTaskArtifact(connection.requestId, payload);
          record.artifactPending = false;
          await this.store.save(state);
        } catch {
          return;
        }
      }
    }
    if (record.direction === "incoming" && record.statusPending && record.statusRevision) {
      const payload: TetiTaskStatusPayload = {
        schemaVersion: 1,
        taskId: record.request.taskId,
        requesterTetiId: record.request.requesterTetiId,
        targetTetiId: record.request.targetTetiId,
        revision: record.statusRevision,
        state: networkTaskState(record.state),
        updatedAt: record.updatedAt,
        ...(record.safeErrorCode ? { safeErrorCode: record.safeErrorCode } : {})
      };
      try {
        await this.applicationManager.sendTaskStatus(connection.requestId, payload);
        record.statusPending = false;
        await this.store.save(state);
      } catch {
        return;
      }
    }
    if (record.direction === "outgoing" && record.cancelPending && !record.cancelSentAt) {
      const payload: TetiTaskCancelPayload = {
        schemaVersion: 1,
        taskId: record.request.taskId,
        requesterTetiId: record.request.requesterTetiId,
        targetTetiId: record.request.targetTetiId,
        requestedAt: record.updatedAt
      };
      try {
        await this.applicationManager.sendTaskCancel(connection.requestId, payload);
        record.cancelSentAt = this.now().toISOString();
        record.updatedAt = this.now().toISOString();
        await this.store.save(state);
      } catch {
        // Durable cancel stays pending until the next Runtime poll.
      }
    }
  }

  private async finishExecution(
    taskId: string,
    result: CallableAdapterTaskSnapshot | null,
    executionEpoch = 1
  ): Promise<void> {
    const state = await this.store.load();
    const record = state.records.find((candidate) =>
      candidate.direction === "incoming" && candidate.request.taskId === taskId
    );
    if (!record || isTerminalTaskState(record.state)) return;
    const handle = await this.executor?.getExecutionHandle?.(taskId);
    if (handle && handle.executionEpoch !== executionEpoch) return;
    const completedAt = this.now().toISOString();
    if (result?.state === "completed" && result.artifact) {
      const resultImages = result.artifact.kind === "parts" ? result.artifact.images : [];
      if (record.request.capabilityId === "image-editing" && resultImages.length === 0) {
        record.state = "failed";
        record.safeErrorCode = "TASK_IMAGE_RESULT_MISSING";
        record.statusRevision = (record.statusRevision ?? 0) + 1;
        record.statusPending = true;
        record.updatedAt = completedAt;
        await this.store.save(state);
        await this.trySendPendingForRecord(state, record);
        return;
      }
      if (resultImages.length > 0 && record.protocolVersion < 3) {
        record.state = "failed";
        record.safeErrorCode = "TASK_IMAGE_RESULT_UNSUPPORTED";
        record.statusRevision = (record.statusRevision ?? 0) + 1;
        record.statusPending = true;
        record.updatedAt = completedAt;
        await this.store.save(state);
        await this.trySendPendingForRecord(state, record);
        return;
      }
      const artifact: CollaborationTaskArtifact = record.protocolVersion === 1
        ? {
            schemaVersion: 1,
            taskId,
            artifactId: randomUUID(),
            kind: "text",
            text: result.artifact.text,
            createdAt: completedAt
          }
        : {
            schemaVersion: 2,
            taskId,
            artifactId: randomUUID(),
            parts: [
              { kind: "text", text: result.artifact.text },
              ...structuredClone(resultImages)
            ],
            createdAt: completedAt
          };
      validateTaskArtifact(artifact);
      record.artifacts = [...(record.artifacts ?? []), artifact];
      initializeAttachmentDiagnostics(record, "artifact", taskArtifactImages(artifact));
      record.artifactPending = true;
      record.artifactAttachmentsReady = true;
      record.state = "completed";
      delete record.safeErrorCode;
    } else if (result?.safeErrorCode === "ADAPTER_AUTH_REQUIRED") {
      record.state = "auth_required";
      record.approval = "pending";
      record.safeErrorCode = "ADAPTER_AUTH_REQUIRED";
    } else if (handle?.executionEpoch === executionEpoch
      && handle.progress.state === "failed"
      && handle.resumeCapability === "checkpoint_restart") {
      record.state = "input_required";
      record.safeErrorCode = "TASK_RESUME_AVAILABLE";
    } else {
      record.state = result?.state === "canceled" ? "canceled" : "failed";
      record.safeErrorCode = result?.safeErrorCode ?? "ADAPTER_INTERNAL_ERROR";
    }
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = completedAt;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
  }

  private async sendStoredRecord(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord
  ): Promise<CollaborationTaskTransportRecord> {
    await this.trySendStoredRecord(state, record);
    if (record.delivery === "send_failed") {
      throw new TaskTransportRuntimeError("TASK_SEND_FAILED", "Chatmail could not queue the Task yet.");
    }
    return structuredClone(record);
  }

  private async trySendStoredRecord(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord
  ): Promise<void> {
    if (Date.parse(record.request.expiresAt) <= this.now().getTime()) {
      expireRecord(record, this.now().toISOString());
      await this.store.save(state);
      return;
    }
    const connection = await this.findConfirmedConnectionForPeer(record.peerTetiId);
    if (!connection) {
      record.delivery = "send_failed";
      record.safeErrorCode = "TASK_CONNECTION_UNAVAILABLE";
      record.updatedAt = this.now().toISOString();
      await this.store.save(state);
      return;
    }
    try {
      await this.trySendInputAttachments(state, record, connection);
      const sent = await this.applicationManager.sendTaskRequest(connection.requestId, record.request);
      record.delivery = "sent";
      record.envelopeMessageId = sent.envelope.messageId;
      record.chatmailMessageId = sent.messageId;
      delete record.safeErrorCode;
    } catch {
      record.delivery = "send_failed";
      record.safeErrorCode = "TASK_CHATMAIL_SEND_FAILED";
    }
    record.updatedAt = this.now().toISOString();
    await this.store.save(state);
  }

  private async trySendInputAttachments(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord,
    existingConnection?: TetiConnectionRecord
  ): Promise<void> {
    if (record.direction !== "outgoing"
      || isTerminalTaskState(record.state)
      || Date.parse(record.request.expiresAt) <= this.now().getTime()) return;
    const parts = taskInputImages(record.request.input);
    if (parts.length === 0) return;
    const connection = existingConnection ?? await this.findConfirmedConnectionForPeer(record.peerTetiId);
    if (!connection) return;
    if (!this.attachmentStore) {
      if (existingConnection) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
      return;
    }
    for (const part of parts) {
      if (!shouldSendAttachment(record, part.attachmentId, "input", this.now())) continue;
      const staged = await this.attachmentStore.getStagedImage(part);
      const payload: TetiTaskAttachmentPayload = {
        schemaVersion: 1,
        taskId: record.request.taskId,
        requesterTetiId: record.request.requesterTetiId,
        targetTetiId: record.request.targetTetiId,
        purpose: "input",
        part: structuredClone(part),
        createdAt: record.request.createdAt,
        expiresAt: record.request.expiresAt,
        ...(record.protocolVersion >= 4 ? { deliveryReceiptRequested: true as const } : {})
      };
      await this.applicationManager.sendTaskAttachment(connection.requestId, payload, {
        path: staged.path,
        filename: staged.safeFileName
      });
      record.sentAttachmentIds = appendUnique(record.sentAttachmentIds, part.attachmentId);
      if (record.protocolVersion >= 4) {
        record.attachmentDeliveryAttempts = recordDeliveryAttempt(
          record.attachmentDeliveryAttempts,
          part.attachmentId,
          this.now()
        );
      }
      markAttachmentSent(record, "input", part, this.now().toISOString());
      record.updatedAt = this.now().toISOString();
      await this.store.save(state);
    }
  }

  private async requireConfirmedConnection(requestId: string): Promise<TetiConnectionRecord> {
    const connection = (await this.connectionStorage.loadAll()).find((item) => item.requestId === requestId);
    if (!connection || connection.state !== TetiConnectionState.Confirmed) {
      throw new TaskTransportRuntimeError("TASK_CONNECTION_REQUIRED", "A Confirmed Teti connection is required.");
    }
    return connection;
  }

  private async findConfirmedConnectionForPeer(tetiId: string): Promise<TetiConnectionRecord | undefined> {
    return (await this.connectionStorage.loadAll()).find(
      (connection) => connection.state === TetiConnectionState.Confirmed
        && connection.remoteTetiId === tetiId
    );
  }
}

function validateSendInput(input: SendCollaborationTaskInput): Required<Pick<
  SendCollaborationTaskInput,
  "connectionRequestId" | "capabilityId" | "text" | "ttlMs" | "attachments" | "workspace"
>> & Pick<SendCollaborationTaskInput, "taskId" | "offerId"> {
  if (typeof input !== "object" || input === null) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task input is invalid.");
  }
  if (typeof input.connectionRequestId !== "string" || !input.connectionRequestId.trim() || input.connectionRequestId.length > 120) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task connection request ID is invalid.");
  }
  if (input.taskId !== undefined && !SAFE_ID_PATTERN.test(input.taskId)) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task ID is invalid.");
  }
  if (input.offerId !== undefined && !SAFE_ID_PATTERN.test(input.offerId)) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task offer ID is invalid.");
  }
  if (typeof input.capabilityId !== "string" || input.capabilityId.length > 128 || !SAFE_SLUG_PATTERN.test(input.capabilityId)) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task Capability ID is invalid.");
  }
  if (typeof input.text !== "string" || !input.text.trim()
    || new TextEncoder().encode(input.text).byteLength > MAX_TASK_INPUT_TEXT_BYTES) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task text is invalid or too large.");
  }
  const ttlMs = input.ttlMs ?? DEFAULT_TASK_REQUEST_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TASK_REQUEST_TTL_MS) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task TTL is invalid.");
  }
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments)) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task attachments are invalid.");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  try {
    for (const part of attachments) {
      validateTaskImagePart(part);
      if (seen.has(part.attachmentId)) throw new Error("duplicate");
      seen.add(part.attachmentId);
      totalBytes += part.byteLength;
    }
  } catch {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task attachments are invalid.");
  }
  if (attachments.length > 4 || totalBytes > 12 * 1024 * 1024) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task attachments exceed the allowed size.");
  }
  const workspace: TaskWorkspaceRequest = input.workspace ?? {
    kind: "temporary",
    access: ["read", "write", "create_artifact"]
  };
  try {
    validateTaskWorkspaceRequest(workspace);
  } catch {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task Workspace request is invalid.");
  }
  return {
    connectionRequestId: input.connectionRequestId.trim(),
    capabilityId: input.capabilityId,
    text: input.text,
    attachments: structuredClone(attachments),
    workspace: structuredClone(workspace),
    ttlMs,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.offerId === undefined ? {} : { offerId: input.offerId })
  };
}

function requireMatchingRetry(
  record: CollaborationTaskTransportRecord,
  connection: TetiConnectionRecord,
  input: ReturnType<typeof validateSendInput>
): void {
  if (record.peerTetiId !== connection.remoteTetiId
    || record.request.capabilityId !== input.capabilityId
    || taskInputText(record.request.input) !== input.text
    || JSON.stringify(taskInputImages(record.request.input)) !== JSON.stringify(input.attachments)
    || JSON.stringify(record.request.workspace) !== JSON.stringify(input.workspace)
    || Date.parse(record.request.expiresAt) - Date.parse(record.request.createdAt) !== input.ttlMs
    || (input.offerId !== undefined && record.request.offerId !== input.offerId)) {
    throw new TaskTransportRuntimeError(
      "TASK_ID_CONFLICT",
      "The Task ID is already bound to different immutable content."
    );
  }
}

function taskInputForVersion(
  version: 1 | 2 | 3 | 4 | 5,
  text: string,
  attachments: readonly TaskImagePart[]
): CollaborationTaskInput {
  return version === 1
    ? { kind: "text", text }
    : {
        kind: "parts",
        parts: [{ kind: "text", text }, ...structuredClone(attachments)]
      };
}

function createAttachmentReceipt(
  payload: TetiTaskAttachmentPayload,
  receivedAt: string
): TetiTaskAttachmentReceiptPayload {
  return {
    schemaVersion: 1,
    taskId: payload.taskId,
    requesterTetiId: payload.requesterTetiId,
    targetTetiId: payload.targetTetiId,
    purpose: payload.purpose,
    ...(payload.artifactId ? { artifactId: payload.artifactId } : {}),
    attachmentId: payload.part.attachmentId,
    receivedAt
  };
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function removeDeliveryAttempt(
  attempts: CollaborationTaskTransportRecord["attachmentDeliveryAttempts"],
  attachmentId: string
): CollaborationTaskTransportRecord["attachmentDeliveryAttempts"] {
  const remaining = attempts?.filter((attempt) => attempt.attachmentId !== attachmentId) ?? [];
  return remaining.length > 0 ? remaining : undefined;
}

function shouldSendAttachment(
  record: CollaborationTaskTransportRecord,
  attachmentId: string,
  purpose: "input" | "artifact",
  now: Date
): boolean {
  const sent = purpose === "input" ? record.sentAttachmentIds : record.sentArtifactAttachmentIds;
  if (record.protocolVersion < 4) return !sent?.includes(attachmentId);
  const acknowledged = purpose === "input"
    ? record.acknowledgedAttachmentIds
    : record.acknowledgedArtifactAttachmentIds;
  if (acknowledged?.includes(attachmentId)) return false;
  const attempts = purpose === "input"
    ? record.attachmentDeliveryAttempts
    : record.artifactAttachmentDeliveryAttempts;
  const attempt = attempts?.find((item) => item.attachmentId === attachmentId);
  return !attempt || Date.parse(attempt.nextRetryAt) <= now.getTime();
}

function recordDeliveryAttempt(
  attempts: CollaborationTaskTransportRecord["attachmentDeliveryAttempts"],
  attachmentId: string,
  now: Date
): NonNullable<CollaborationTaskTransportRecord["attachmentDeliveryAttempts"]> {
  const current = attempts?.find((attempt) => attempt.attachmentId === attachmentId);
  const nextAttempt = (current?.attempts ?? 0) + 1;
  const delay = ATTACHMENT_RETRY_DELAYS_MS[
    Math.min(nextAttempt - 1, ATTACHMENT_RETRY_DELAYS_MS.length - 1)
  ];
  const updated = {
    attachmentId,
    attempts: nextAttempt,
    lastSentAt: now.toISOString(),
    nextRetryAt: new Date(now.getTime() + delay).toISOString()
  };
  return [...(attempts ?? []).filter((attempt) => attempt.attachmentId !== attachmentId), updated];
}

function sameImagePart(left: TaskImagePart, right: TaskImagePart): boolean {
  return left.attachmentId === right.attachmentId
    && left.mimeType === right.mimeType
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height
    && left.sha256 === right.sha256;
}

function taskImageFileName(part: TaskImagePart): string {
  return `${part.attachmentId}${part.mimeType === "image/png" ? ".png" : ".jpg"}`;
}

function incomingRecord(
  input: {
    envelope: TetiApplicationEnvelope<CollaborationTaskRequest>;
    connection: TetiConnectionRecord;
    chatmailMessageId?: number;
  },
  receivedAt: string,
  delivery: "received" | "expired" | "rejected"
): CollaborationTaskTransportRecord {
  return {
    schemaVersion: 1,
    direction: "incoming",
    peerTetiId: input.connection.remoteTetiId,
    protocolVersion: input.envelope.payload.schemaVersion,
    envelopeMessageId: input.envelope.messageId,
    ...(input.chatmailMessageId === undefined ? {} : { chatmailMessageId: input.chatmailMessageId }),
    request: structuredClone(input.envelope.payload),
    state: delivery === "received" ? "submitted" : "rejected",
    approval: delivery === "received" ? "pending" : delivery === "expired" ? "expired" : "rejected",
    delivery,
    createdAt: receivedAt,
    updatedAt: receivedAt,
    attachmentsReady: taskInputImages(input.envelope.payload.input).length === 0,
    attachmentDiagnostics: createAttachmentDiagnostics(
      "input",
      taskInputImages(input.envelope.payload.input)
    ),
    ...(delivery === "expired"
      ? { safeErrorCode: "TASK_EXPIRED" }
      : delivery === "rejected"
        ? { safeErrorCode: "TASK_CREATED_AT_FUTURE" }
        : {})
  };
}

function createReceipt(
  request: CollaborationTaskRequest,
  localTetiId: string,
  status: TetiTaskReceiptPayload["status"],
  receivedAt: string
): TetiTaskReceiptPayload {
  return {
    schemaVersion: 1,
    taskId: request.taskId,
    requesterTetiId: request.requesterTetiId,
    targetTetiId: localTetiId,
    status,
    receivedAt,
    supportedTaskVersions: [...TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS]
  };
}

function applyReceipt(
  record: CollaborationTaskTransportRecord,
  receipt: TetiTaskReceiptPayload,
  observedAt: string
): void {
  record.receipt = structuredClone(receipt);
  record.updatedAt = observedAt;
  if (receipt.status === "received" || receipt.status === "duplicate") {
    record.delivery = "acknowledged";
    if (record.state === "submitted"
      && ["TASK_CHATMAIL_SEND_FAILED", "TASK_CONNECTION_UNAVAILABLE"].includes(record.safeErrorCode ?? "")) {
      delete record.safeErrorCode;
    }
    return;
  }
  if (receipt.status === "expired") {
    expireRecord(record, observedAt);
    return;
  }
  record.delivery = receipt.status;
  record.state = receipt.status === "conflict" ? "failed" : "rejected";
  record.approval = "rejected";
  record.safeErrorCode = receipt.status === "conflict" ? "TASK_ID_CONFLICT" : "TASK_REJECTED";
}

function shouldApplyReceipt(
  record: CollaborationTaskTransportRecord,
  receipt: TetiTaskReceiptPayload
): boolean {
  if (["conflict", "rejected", "expired"].includes(record.delivery)) return false;
  if (record.receipt) {
    const order = Date.parse(receipt.receivedAt) - Date.parse(record.receipt.receivedAt);
    if (order < 0) return false;
    if (order === 0) return JSON.stringify(receipt) === JSON.stringify(record.receipt);
  }
  if (!["received", "duplicate"].includes(receipt.status) && record.state !== "submitted") {
    return false;
  }
  return true;
}

function rememberPeerVersions(
  state: TetiTaskTransportStoreState,
  tetiId: string,
  versions: readonly number[],
  observedAt: string,
  merge = false
): void {
  const existing = state.peers.find((peer) => peer.tetiId === tetiId);
  const normalized = [...new Set([
    ...(merge ? existing?.supportedVersions ?? [] : []),
    ...versions
  ])].sort((left, right) => left - right);
  if (existing) {
    if (Date.parse(observedAt) < Date.parse(existing.observedAt)) return;
    existing.supportedVersions = normalized;
    existing.observedAt = observedAt;
  } else {
    state.peers.push({ tetiId, supportedVersions: normalized, observedAt });
  }
}

function expireDueRecords(state: TetiTaskTransportStoreState, now: Date): boolean {
  let changed = false;
  for (const record of state.records) {
    if ((!isTerminalTaskState(record.state)
      || record.delivery === "queued"
      || record.delivery === "send_failed")
      && Date.parse(record.request.expiresAt) <= now.getTime()) {
      expireRecord(record, now.toISOString());
      changed = true;
    }
  }
  return changed;
}

function expireRecord(record: CollaborationTaskTransportRecord, timestamp: string): void {
  record.delivery = "expired";
  record.state = "rejected";
  record.approval = "expired";
  record.safeErrorCode = "TASK_EXPIRED";
  record.receiptPending = false;
  for (const diagnostic of record.attachmentDiagnostics ?? []) {
    if (diagnostic.state === "acknowledged" || diagnostic.state === "stored") continue;
    diagnostic.state = "expired";
    diagnostic.safeErrorCode = "TASK_EXPIRED";
  }
  if (record.direction === "incoming") {
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
  }
  record.updatedAt = timestamp;
}

function createAttachmentDiagnostics(
  purpose: "input" | "artifact",
  parts: readonly TaskImagePart[]
): NonNullable<CollaborationTaskTransportRecord["attachmentDiagnostics"]> {
  return parts.map((part, index) => ({
    attachmentId: part.attachmentId,
    purpose,
    ordinal: index + 1,
    expectedCount: parts.length,
    byteLength: part.byteLength,
    sha256: part.sha256,
    attempts: 0,
    state: "expected"
  }));
}

function initializeAttachmentDiagnostics(
  record: CollaborationTaskTransportRecord,
  purpose: "input" | "artifact",
  parts: readonly TaskImagePart[]
): void {
  const existing = new Map((record.attachmentDiagnostics ?? [])
    .filter((item) => item.purpose === purpose)
    .map((item) => [item.attachmentId, item]));
  const other = (record.attachmentDiagnostics ?? []).filter((item) => item.purpose !== purpose);
  record.attachmentDiagnostics = [
    ...other,
    ...parts.map((part, index) => {
      const prior = existing.get(part.attachmentId);
      return {
        ...(prior ?? createAttachmentDiagnostics(purpose, [part])[0]!),
        attachmentId: part.attachmentId,
        purpose,
        ordinal: index + 1,
        expectedCount: parts.length,
        byteLength: part.byteLength,
        sha256: part.sha256
      };
    })
  ];
}

function markAttachmentSent(
  record: CollaborationTaskTransportRecord,
  purpose: "input" | "artifact",
  part: TaskImagePart,
  timestamp: string
): void {
  ensureSingleAttachmentDiagnostic(record, purpose, part);
  const diagnostic = record.attachmentDiagnostics?.find((item) =>
    item.purpose === purpose && item.attachmentId === part.attachmentId
  );
  if (!diagnostic) return;
  diagnostic.attempts += 1;
  diagnostic.firstSentAt ??= timestamp;
  diagnostic.lastSentAt = timestamp;
  if (diagnostic.state !== "acknowledged" && diagnostic.state !== "stored") diagnostic.state = "sent";
}

function markAttachmentStored(
  record: CollaborationTaskTransportRecord,
  purpose: "input" | "artifact",
  part: TaskImagePart,
  timestamp: string
): void {
  ensureSingleAttachmentDiagnostic(record, purpose, part);
  const diagnostic = record.attachmentDiagnostics?.find((item) =>
    item.purpose === purpose && item.attachmentId === part.attachmentId
  );
  if (!diagnostic) return;
  diagnostic.storedAt ??= timestamp;
  if (diagnostic.state !== "acknowledged") diagnostic.state = "stored";
  delete diagnostic.safeErrorCode;
}

function markAttachmentAcknowledged(
  record: CollaborationTaskTransportRecord,
  purpose: "input" | "artifact",
  attachmentId: string,
  timestamp: string
): void {
  const diagnostic = record.attachmentDiagnostics?.find((item) =>
    item.purpose === purpose && item.attachmentId === attachmentId
  );
  if (!diagnostic) return;
  diagnostic.receiptReceivedAt = timestamp;
  diagnostic.state = "acknowledged";
  delete diagnostic.safeErrorCode;
}

function ensureSingleAttachmentDiagnostic(
  record: CollaborationTaskTransportRecord,
  purpose: "input" | "artifact",
  part: TaskImagePart
): void {
  if (record.attachmentDiagnostics?.some((item) =>
    item.purpose === purpose && item.attachmentId === part.attachmentId
  )) return;
  record.attachmentDiagnostics = [
    ...(record.attachmentDiagnostics ?? []),
    ...createAttachmentDiagnostics(purpose, [part])
  ];
}

function receivedInputImageCount(record: CollaborationTaskTransportRecord): number {
  const expected = taskInputImages(record.request.input);
  if (expected.length === 0) return 0;
  const delivered = new Set((record.attachmentDiagnostics ?? [])
    .filter((item) => item.purpose === "input"
      && (record.direction === "incoming" ? item.state === "stored" : item.state === "acknowledged"))
    .map((item) => item.attachmentId));
  return expected.filter((part) => delivered.has(part.attachmentId)).length;
}

function ensureCapacity(state: TetiTaskTransportStoreState, now: Date): boolean {
  if (state.records.length < MAX_TASK_TRANSPORT_RECORDS) return true;
  const retained = state.records
    .filter((record) => Date.parse(record.request.expiresAt) > now.getTime())
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  if (retained.length >= MAX_TASK_TRANSPORT_RECORDS) return false;
  state.records = retained;
  return true;
}

function validTimestampOrNow(value: string | undefined, now: Date): Date {
  if (!value) return now;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() + MAX_TASK_CLOCK_SKEW_MS
    ? new Date(timestamp)
    : now;
}

function snapshot(
  state: TetiTaskTransportStoreState,
  now: Date
): CollaborationTaskTransportSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    records: structuredClone(state.records).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    peers: structuredClone(state.peers).sort((left, right) => left.tetiId.localeCompare(right.tetiId))
  };
}

function compareTaskSummaries(
  left: CollaborationTaskSummarySnapshot["tasks"][number],
  right: CollaborationTaskSummarySnapshot["tasks"][number]
): number {
  const rank = (task: CollaborationTaskSummarySnapshot["tasks"][number]): number => {
    if (task.direction === "incoming" && task.approval === "pending" && task.state === "submitted") return 0;
    if (task.state === "working") return 1;
    if (task.direction === "outgoing" && task.state === "submitted") return 2;
    return 3;
  };
  const difference = rank(left) - rank(right);
  if (difference !== 0) return difference;
  if (rank(left) === 0) return left.expiresAt.localeCompare(right.expiresAt);
  return right.updatedAt.localeCompare(left.updatedAt);
}

function findTaskRecord(
  state: TetiTaskTransportStoreState,
  direction: "incoming" | "outgoing",
  requesterTetiId: string,
  taskId: string
): CollaborationTaskTransportRecord | undefined {
  return state.records.find((record) =>
    record.direction === direction
    && record.request.requesterTetiId === requesterTetiId
    && record.request.taskId === taskId
  );
}

function requireMutableIncomingTask(
  state: TetiTaskTransportStoreState,
  taskId: string,
  now: Date
): CollaborationTaskTransportRecord {
  if (!SAFE_ID_PATTERN.test(taskId)) {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task ID is invalid.");
  }
  const record = state.records.find((candidate) =>
    candidate.direction === "incoming" && candidate.request.taskId === taskId
  );
  if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
  if (!(TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS as readonly number[]).includes(record.protocolVersion)) {
    throw new TaskTransportRuntimeError(
      "TASK_PROTOCOL_UPGRADE_REQUIRED",
      "Task was created by an unsupported collaboration protocol."
    );
  }
  if (Date.parse(record.request.expiresAt) <= now.getTime()) {
    expireRecord(record, now.toISOString());
    throw new TaskTransportRuntimeError("TASK_EXPIRED", "Task approval has expired.");
  }
  if (record.approval !== "pending"
    || (record.state !== "submitted" && record.state !== "auth_required")) {
    throw new TaskTransportRuntimeError("TASK_NOT_PENDING", "Task no longer awaits approval.");
  }
  return record;
}

function requireInboundTaskIdentity(
  envelope: TetiApplicationEnvelope,
  connection: TetiConnectionRecord,
  localTetiId: string,
  payload: { requesterTetiId: string; targetTetiId: string }
): void {
  if (envelope.fromTetiId !== payload.requesterTetiId
    || connection.remoteTetiId !== payload.requesterTetiId
    || payload.targetTetiId !== localTetiId) {
    throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task identity binding is invalid.");
  }
}

function requireOutboundTaskIdentity(
  envelope: TetiApplicationEnvelope,
  connection: TetiConnectionRecord,
  localTetiId: string,
  payload: { requesterTetiId: string; targetTetiId: string }
): void {
  if (envelope.fromTetiId !== payload.targetTetiId
    || connection.remoteTetiId !== payload.targetTetiId
    || payload.requesterTetiId !== localTetiId) {
    throw new TaskTransportRuntimeError("TASK_IDENTITY_MISMATCH", "Task identity binding is invalid.");
  }
}

function isTerminalTaskState(state: CollaborationTaskTransportRecord["state"]): boolean {
  return ["completed", "failed", "canceled", "rejected"].includes(state);
}

function isRemoteTransitionAllowed(
  current: CollaborationTaskTransportRecord["state"],
  next: TetiTaskStatusPayload["state"]
): boolean {
  if (isTerminalTaskState(current)) return false;
  if (current === "submitted") {
    // Status delivery is asynchronous. A receiver may finish before an
    // earlier working update is delivered, so a monotonic terminal revision
    // must be able to skip that intermediate state.
    return ["working", "completed", "rejected", "failed", "canceled", "auth_required", "input_required"]
      .includes(next);
  }
  if (current === "working" || current === "auth_required" || current === "input_required") {
    return ["working", "completed", "failed", "canceled", "auth_required", "input_required"]
      .includes(next);
  }
  return false;
}

function networkTaskState(state: CollaborationTaskTransportRecord["state"]): TetiTaskStatusPayload["state"] {
  return ["working", "input_required", "auth_required", "completed", "failed", "canceled", "rejected"]
    .includes(state)
    ? state as TetiTaskStatusPayload["state"]
    : "failed";
}

function createExecutionGrant(
  request: CollaborationTaskRequest,
  target: TaskExecutionTarget,
  workspace: TaskWorkspaceBinding,
  now: Date
): ExecutionGrant {
  const issuedAt = now.toISOString();
  return {
    schemaVersion: 2,
    grantId: randomUUID(),
    taskId: request.taskId,
    requesterTetiId: request.requesterTetiId,
    capabilityId: request.capabilityId,
    agentId: target.childAgentId,
    adapterId: target.connectorId,
    inputDigest: `sha256:${createHash("sha256").update(canonicalTaskRequestJson(request)).digest("hex")}`,
    issuedAt,
    expiresAt: new Date(now.getTime() + 2 * 60 * 1_000).toISOString(),
    singleUse: true,
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.workspaceRevision,
    workspaceAccess: [...workspace.access],
    userFileAccess: "none",
    commandPolicy: "fixed_adapter_entrypoint",
    networkPolicy: "agent_managed"
  };
}

function createExecutionAuthority(
  grant: ExecutionGrant,
  request: CallableAdapterTaskRequest,
  target: TaskExecutionTarget,
  executionEpoch: number
): ExecutionAuthority {
  if (request.adapterId !== target.connectorId
    || request.agentId !== target.childAgentId
    || request.capabilityId !== target.capabilityId) {
    throw new TaskTransportRuntimeError("TASK_EXECUTION_TARGET_INVALID", "Execution target changed after approval.");
  }
  return issueExecutionAuthority(request, {
    authorityId: grant.grantId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    workspaceId: grant.workspaceId,
    workspaceRevision: grant.workspaceRevision,
    workspaceAccess: grant.workspaceAccess,
    executionEpoch
  });
}
