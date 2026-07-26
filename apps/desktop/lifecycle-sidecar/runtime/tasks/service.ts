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
import type { TaskTransportStore } from "./store.ts";
import type { StagedTaskImage, TaskAttachmentStore } from "./attachments.ts";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

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
  executor?: TaskExecutionBridge;
  enqueueOperation?: (operation: () => Promise<void>) => Promise<void>;
}

export interface TaskExecutionTarget {
  adapterId: string;
  agentId: string;
  capabilityId: string;
}

export interface TaskExecutionBridge {
  resolveTarget(
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[]
  ): TaskExecutionTarget | null;
  execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot>;
  getTask(taskId: string): CallableAdapterTaskSnapshot | null;
  cancel(taskId: string): boolean;
}

export class TaskTransportRuntime {
  private readonly accountStorage: TetiAccountStorage;
  private readonly connectionStorage: TetiConnectionStorage;
  private readonly applicationManager: TetiApplicationManager;
  private readonly store: TaskTransportStore;
  private readonly now: () => Date;
  private readonly taskIdFactory: () => string;
  private readonly attachmentStore?: TaskAttachmentStore;
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
    const changed = this.reconcileInterruptedExecutions(state);
    if (expireDueRecords(state, this.now()) || changed) await this.store.save(state);
    return snapshot(state, this.now());
  }

  async listSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    const state = await this.store.load();
    let changed = this.reconcileInterruptedExecutions(state);
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
    let changed = this.reconcileInterruptedExecutions(state);
    changed = await this.refreshAttachmentReadiness(state) || changed;
    changed = expireDueRecords(state, this.now()) || changed;
    if (changed) await this.store.save(state);
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
    return structuredClone(record);
  }

  async resolveTaskImage(taskId: string, attachmentId: string): Promise<string> {
    const record = await this.get(taskId);
    const part = taskInputImages(record.request.input).find((image) => image.attachmentId === attachmentId);
    if (!part || !this.attachmentStore) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENT_NOT_FOUND", "Task image was not found.");
    }
    if (record.direction === "outgoing") {
      return (await this.attachmentStore.getStagedImage(part)).path;
    }
    const path = await this.attachmentStore.resolveImage({ taskId, purpose: "input", part });
    if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENT_NOT_FOUND", "Task image is unavailable.");
    return path;
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
      attachmentsReady: true
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
  }): Promise<void> {
    if (!this.attachmentStore) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_UNAVAILABLE", "Task image attachments are unavailable.");
    }
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    requireInboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    if (payload.purpose !== "input") {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENT_UNSUPPORTED", "Image result attachments are not enabled yet.");
    }
    if (Date.parse(payload.expiresAt) <= this.now().getTime()) return;
    const state = await this.store.load();
    const record = findTaskRecord(state, "incoming", payload.requesterTetiId, payload.taskId);
    if (record) {
      if (isTerminalTaskState(record.state)) return;
      const declared = taskInputImages(record.request.input).find(
        (part) => part.attachmentId === payload.part.attachmentId
      );
      if (!declared || !sameImagePart(declared, payload.part)) {
        throw new TaskTransportRuntimeError(
          "TASK_ATTACHMENT_CONFLICT",
          "Task attachment does not match the immutable request."
        );
      }
    }
    await this.attachmentStore.ingestImage({
      taskId: payload.taskId,
      purpose: "input",
      part: payload.part,
      sourcePath: input.filePath
    });
    if (record) {
      record.attachmentsReady = await this.areInputAttachmentsReady(record);
      record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
      await this.store.save(state);
    }
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
    if (!record || ["failed", "canceled", "rejected"].includes(record.state)) return;
    const artifacts = record.artifacts ?? [];
    if (artifacts.length === 0) {
      record.artifacts = [...artifacts, structuredClone(payload.artifact)];
      record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
      await this.store.save(state);
    }
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
    const grant = createExecutionGrant(record.request, target, this.now());
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
      adapterId: target.adapterId,
      agentId: target.agentId,
      capabilityId: target.capabilityId,
      input: {
        kind: imageInputs.length > 0 ? "parts" : "text",
        text: taskInputText(record.request.input),
        images: imageInputs
      },
      createdAt: this.now().toISOString()
    };
    void this.executor.execute(execution).then(
      (result) => this.enqueueOperation(() => this.finishExecution(record.request.taskId, result)),
      () => this.enqueueOperation(() => this.finishExecution(record.request.taskId, null))
    ).catch(() => undefined);
    return structuredClone(record);
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

  async flushOutbox(): Promise<void> {
    const state = await this.store.load();
    this.reconcileInterruptedExecutions(state);
    expireDueRecords(state, this.now());
    for (const record of state.records) {
      if (record.direction === "outgoing"
        && (record.delivery === "queued" || record.delivery === "send_failed")) {
        await this.trySendStoredRecord(state, record);
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

  private reconcileInterruptedExecutions(state: TetiTaskTransportStoreState): boolean {
    let changed = false;
    for (const record of state.records) {
      if (record.direction !== "incoming" || record.state !== "working") continue;
      if (this.executor?.getTask(record.request.taskId)?.state === "working") continue;
      record.state = "failed";
      record.safeErrorCode = "TASK_RUNTIME_RESTARTED";
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
    for (const part of images) {
      if (!await this.attachmentStore.resolveImage({
        taskId: record.request.taskId,
        purpose: "input",
        part
      })) return false;
    }
    return true;
  }

  private async trySendPendingForRecord(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord
  ): Promise<void> {
    const connection = await this.findConfirmedConnectionForPeer(record.peerTetiId);
    if (!connection) return;
    if (record.direction === "incoming" && record.artifactPending && record.artifacts?.length) {
      const artifact = record.artifacts.at(-1)!;
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
    result: CallableAdapterTaskSnapshot | null
  ): Promise<void> {
    const state = await this.store.load();
    const record = state.records.find((candidate) =>
      candidate.direction === "incoming" && candidate.request.taskId === taskId
    );
    if (!record || record.state === "canceled") return;
    const completedAt = this.now().toISOString();
    if (result?.state === "completed" && result.artifact) {
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
            parts: [{ kind: "text", text: result.artifact.text }],
            createdAt: completedAt
          };
      validateTaskArtifact(artifact);
      record.artifacts = [...(record.artifacts ?? []), artifact];
      record.artifactPending = true;
      record.state = "completed";
      delete record.safeErrorCode;
    } else if (result?.safeErrorCode === "ADAPTER_AUTH_REQUIRED") {
      record.state = "auth_required";
      record.approval = "pending";
      record.safeErrorCode = "ADAPTER_AUTH_REQUIRED";
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
      for (const part of taskInputImages(record.request.input)) {
        if (record.sentAttachmentIds?.includes(part.attachmentId)) continue;
        if (!this.attachmentStore) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
        const staged = await this.attachmentStore.getStagedImage(part);
        const payload: TetiTaskAttachmentPayload = {
          schemaVersion: 1,
          taskId: record.request.taskId,
          requesterTetiId: record.request.requesterTetiId,
          targetTetiId: record.request.targetTetiId,
          purpose: "input",
          part: structuredClone(part),
          createdAt: record.request.createdAt,
          expiresAt: record.request.expiresAt
        };
        await this.applicationManager.sendTaskAttachment(connection.requestId, payload, {
          path: staged.path,
          filename: staged.safeFileName
        });
        record.sentAttachmentIds = [...(record.sentAttachmentIds ?? []), part.attachmentId];
        record.updatedAt = this.now().toISOString();
        await this.store.save(state);
      }
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
  "connectionRequestId" | "capabilityId" | "text" | "ttlMs" | "attachments"
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
  return {
    connectionRequestId: input.connectionRequestId.trim(),
    capabilityId: input.capabilityId,
    text: input.text,
    attachments: structuredClone(attachments),
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
    || Date.parse(record.request.expiresAt) - Date.parse(record.request.createdAt) !== input.ttlMs
    || (input.offerId !== undefined && record.request.offerId !== input.offerId)) {
    throw new TaskTransportRuntimeError(
      "TASK_ID_CONFLICT",
      "The Task ID is already bound to different immutable content."
    );
  }
}

function taskInputForVersion(
  version: 1 | 2,
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

function sameImagePart(left: TaskImagePart, right: TaskImagePart): boolean {
  return left.attachmentId === right.attachmentId
    && left.mimeType === right.mimeType
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height
    && left.sha256 === right.sha256;
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
  if (record.direction === "incoming") {
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
  }
  record.updatedAt = timestamp;
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
  now: Date
): ExecutionGrant {
  const issuedAt = now.toISOString();
  return {
    schemaVersion: 1,
    grantId: randomUUID(),
    taskId: request.taskId,
    requesterTetiId: request.requesterTetiId,
    capabilityId: request.capabilityId,
    agentId: target.agentId,
    adapterId: target.adapterId,
    inputDigest: `sha256:${createHash("sha256").update(canonicalTaskRequestJson(request)).digest("hex")}`,
    issuedAt,
    expiresAt: new Date(now.getTime() + 2 * 60 * 1_000).toISOString(),
    singleUse: true,
    workspaceAccess: "isolated_task_directory",
    userFileAccess: "none",
    commandPolicy: "fixed_adapter_entrypoint",
    networkPolicy: "agent_managed"
  };
}
