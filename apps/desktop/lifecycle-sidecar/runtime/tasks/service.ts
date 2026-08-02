import { createHash, randomUUID } from "node:crypto";
import type { TetiAccountStorage } from "../../../../../core/account/storage.ts";
import type { TetiApplicationManager } from "../../../../../core/application/manager.ts";
import type { TetiConnectionStorage } from "../../../../../core/connection/storage.ts";
import { TetiConnectionState, type TetiConnectionRecord } from "../../../../../core/connection/types.ts";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";
import type { TetiApplicationEnvelope } from "../../../../../core/protocol/types.ts";
import {
  DEFAULT_TASK_REQUEST_TTL_MS,
  LONG_HORIZON_LIMITS,
  MAX_TASK_CLOCK_SKEW_MS,
  MAX_TASK_TRANSPORT_RECORDS,
  TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS,
  type CollaborationTaskTransportRecord,
  type CollaborationTaskSummarySnapshot,
  type CollaborationTaskTransportSnapshot,
  type LongHorizonAuditEvent,
  type LongHorizonTaskState,
  type SendCollaborationTaskInput,
  type TetiTaskArtifactPayload,
  type TetiTaskAttachmentPayload,
  type TetiTaskAttachmentReceiptPayload,
  type TetiTaskCancelPayload,
  type TetiTaskInputPayload,
  type TetiTaskLongHorizonStatus,
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
  MAX_TASK_ARTIFACT_TEXT_BYTES,
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
import {
  createDeterministicDelegationPlan
} from "../../../../../core/delegation/planner.ts";
import {
  DELEGATION_LIMITS,
  TETI_HOST_AGGREGATION_RESOURCE_ID,
  type DelegationAuditEvent,
  type DelegationChildStep,
  type DelegationTargetOption,
  type DelegationTargetSelection
} from "../../../../../core/delegation/types.ts";
import {
  isWorkspaceAccessSubset,
  validateDelegationPlanState
} from "../../../../../core/delegation/validation.ts";
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
  workspacePolicy?: "snapshot" | "bounded_context" | "none";
  outputModes?: readonly ("text" | "image")[];
}

export interface TaskExecutionBridge {
  resolveTarget(
    offerId: string,
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[]
  ): TaskExecutionTarget | null;
  listTargets?(
    offerId: string,
    capabilityId: string,
    requiredInputModes: readonly ("text" | "image")[]
  ): TaskExecutionTarget[];
  listDelegationTargets?(): DelegationTargetOption[];
  resolveDelegationTarget?(selection: DelegationTargetSelection): DelegationTargetOption | null;
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
    let changed = await this.reconcileInterruptedExecutions(state);
    changed = this.refreshLongHorizonTargets(state) || changed;
    if (expireDueRecords(state, this.now()) || changed) await this.store.save(state);
    return snapshot(state, this.now());
  }

  async listSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    const state = await this.store.load();
    let changed = await this.reconcileInterruptedExecutions(state);
    changed = this.refreshLongHorizonTargets(state) || changed;
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
          expiresAt: effectiveTaskExpiry(record),
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
    changed = this.refreshLongHorizonTargets(state) || changed;
    changed = await this.refreshAttachmentReadiness(state) || changed;
    changed = expireDueRecords(state, this.now()) || changed;
    if (changed) await this.store.save(state);
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
    return structuredClone(record);
  }

  async listDelegationTargets(taskId: string): Promise<DelegationTargetOption[]> {
    const state = await this.store.load();
    const record = requireMutableIncomingTask(state, taskId, this.now());
    if (record.request.executionMode !== "long_horizon" || !record.longHorizon) {
      throw new TaskTransportRuntimeError(
        "TASK_DELEGATION_MODE_REQUIRED",
        "Deterministic delegation requires a long-horizon Task."
      );
    }
    if (!this.executor?.listDelegationTargets) {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_UNAVAILABLE", "Delegation target discovery is unavailable.");
    }
    return this.executor.listDelegationTargets()
      .filter((target) => target.inputModes.includes("text")
        && (target.outputModes.includes("text") || target.outputModes.includes("image")))
      .map((target) => structuredClone(target));
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
    return structuredClone(await this.executor?.getExecutionHandle?.(
      currentExecutionTaskId(record) ?? taskId
    ) ?? null);
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
      executionMode: normalized.executionMode,
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
    if (record && ((record.request.executionMode === "long_horizon" && payload.schemaVersion !== 2)
      || (record.request.executionMode !== "long_horizon" && payload.schemaVersion !== 1))) {
      throw new TaskTransportRuntimeError("TASK_STATUS_MODE_CONFLICT", "Task status mode does not match its request.");
    }
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
    if (payload.schemaVersion === 2
      && payload.longHorizon
      && record.request.executionMode === "long_horizon") {
      record.peerLongHorizon = structuredClone(payload.longHorizon);
      if (record.inputPending
        && (payload.longHorizon.currentStageIndex > record.inputPending.expectedStageIndex
          || ["completed", "failed", "canceled", "expired"].includes(payload.longHorizon.phase))) {
        delete record.inputPending;
        delete record.inputSentAt;
      }
    }
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
    if ((record.request.executionMode === "long_horizon" && payload.schemaVersion !== 2)
      || (record.request.executionMode !== "long_horizon" && payload.schemaVersion !== 1)) {
      throw new TaskTransportRuntimeError("TASK_ARTIFACT_MODE_CONFLICT", "Task Artifact mode does not match its request.");
    }
    const imageParts = taskArtifactImages(payload.artifact);
    if (imageParts.length > 0 && record.protocolVersion < 3) {
      throw new TaskTransportRuntimeError("TASK_ARTIFACT_UNSUPPORTED", "Peer sent image output without Task v3.");
    }
    const existing = record.artifacts?.find((artifact) => artifact.artifactId === payload.artifact.artifactId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(payload.artifact)) {
      throw new TaskTransportRuntimeError("TASK_ARTIFACT_CONFLICT", "Task Artifact conflicts with the stored result.");
    }
    if (!existing
      && record.request.executionMode !== "long_horizon"
      && (record.artifacts?.length ?? 0) > 0) {
      throw new TaskTransportRuntimeError(
        "TASK_ARTIFACT_CONFLICT",
        "A single-stage Task cannot publish more than one result Artifact."
      );
    }
    if (!existing) record.artifacts = [...(record.artifacts ?? []), structuredClone(payload.artifact)];
    if (payload.schemaVersion === 2) {
      const metadata = {
        artifactId: payload.artifact.artifactId,
        stageIndex: payload.stageIndex!,
        role: payload.role!,
        createdAt: payload.createdAt
      };
      const existingMetadata = record.peerArtifactMetadata?.find(
        (entry) => entry.artifactId === metadata.artifactId
      );
      if (existingMetadata && JSON.stringify(existingMetadata) !== JSON.stringify(metadata)) {
        throw new TaskTransportRuntimeError(
          "TASK_ARTIFACT_CONFLICT",
          "Task Artifact stage metadata conflicts with the stored result."
        );
      }
      if (!existingMetadata) {
        record.peerArtifactMetadata = [...(record.peerArtifactMetadata ?? []), metadata];
      }
    }
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
    this.executor?.cancel(currentExecutionTaskId(record) ?? payload.taskId);
    record.state = "canceled";
    record.approval = record.approval === "pending" ? "rejected" : record.approval;
    record.statusPending = true;
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.updatedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    record.safeErrorCode = "TASK_CANCELED_BY_REQUESTER";
    if (record.longHorizon) {
      record.longHorizon.phase = "canceled";
      record.longHorizon.progress = progress(
        "canceled",
        null,
        null,
        "请求方已取消长期协作",
        record.updatedAt
      );
      appendLongHorizonAudit(record.longHorizon, {
        action: "canceled",
        actor: "remote_peer",
        stageIndex: record.longHorizon.currentStageIndex || null
      }, record.updatedAt);
    }
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
    if (record.longHorizon && target.outputModes?.includes("image")) {
      throw new TaskTransportRuntimeError(
        "TASK_LONG_HORIZON_TEXT_ONLY",
        "The selected Child Agent does not have a text-only long-horizon output contract."
      );
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
    if (record.longHorizon) {
      return this.startLongHorizonStage({
        state,
        record,
        target,
        imageInputs,
        instruction: taskInputText(record.request.input),
        inputId: null
      });
    }
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

  async approveDelegation(
    taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireMutableIncomingTask(state, taskId, this.now());
    if (record.request.executionMode !== "long_horizon" || !record.longHorizon) {
      throw new TaskTransportRuntimeError(
        "TASK_DELEGATION_MODE_REQUIRED",
        "Deterministic delegation requires a long-horizon Task."
      );
    }
    if (record.delegationPlan) {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_EXISTS", "This Task already has a frozen Delegation Plan.");
    }
    if (!Array.isArray(selections)
      || selections.length < 1
      || selections.length > DELEGATION_LIMITS.maximumChildSteps) {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_STEP_LIMIT", "Select one to four Child Agent steps.");
    }
    if (!this.executor?.resolveDelegationTarget || !this.executor.prepareExecution) {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_UNAVAILABLE", "Delegation execution is unavailable.");
    }
    record.attachmentsReady = await this.areInputAttachmentsReady(record);
    if (!record.attachmentsReady) {
      throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images have not finished downloading.");
    }
    const targets = selections.map((selection) => {
      const target = this.executor!.resolveDelegationTarget!(selection);
      if (!target || !target.inputModes.includes("text")) {
        throw new TaskTransportRuntimeError(
          "TASK_DELEGATION_TARGET_INVALID",
          "A selected Child Agent target is unavailable or does not accept text."
        );
      }
      return target;
    });
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const workspaceBinding = await this.resolveWorkspaceBinding(record.request, account.id);
    record.workspaceBinding = workspaceBinding;
    record.delegationPlan = createDeterministicDelegationPlan({
      taskId: record.request.taskId,
      workspaceRevision: workspaceBinding.workspaceRevision,
      workspaceAccess: workspaceBinding.access,
      targets,
      now: this.now(),
      idFactory: this.taskIdFactory
    });
    const approvedAt = this.now().toISOString();
    appendDelegationAudit(record.delegationPlan, {
      action: "plan_approved",
      actor: "local_user",
      stepId: null
    }, approvedAt, this.taskIdFactory);
    record.delegationPlan.updatedAt = approvedAt;
    validateDelegationPlanState(record.delegationPlan);
    const firstStep = record.delegationPlan.steps[0];
    if (!firstStep || firstStep.kind !== "child_execution") {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_INVALID", "Delegation Plan has no executable Child step.");
    }
    return this.startDelegationStep(state, record, firstStep);
  }

  private async startDelegationStep(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord,
    step: DelegationChildStep
  ): Promise<CollaborationTaskTransportRecord> {
    const plan = record.delegationPlan;
    const workspace = record.workspaceBinding;
    const target = this.executor?.resolveDelegationTarget?.({
      childAgentId: step.childAgentId,
      connectorId: step.connectorId,
      capabilityId: step.capabilityId
    });
    if (!plan || !workspace || !target
      || target.resourceBindingId !== step.resourceBindingId
      || target.timeoutMs < step.budget.timeoutMs
      || target.maxOutputBytes < step.budget.maxOutputBytes
      || !isWorkspaceAccessSubset(step.workspaceAccess, workspace.access)) {
      throw new TaskTransportRuntimeError(
        "TASK_DELEGATION_TARGET_CHANGED",
        "A frozen Delegation target or its authority changed before execution."
      );
    }
    const imageInputs = target.inputModes.includes("image")
      ? await this.resolveInputImages(record)
      : [];
    step.workspaceRevision = workspace.workspaceRevision;
    return this.startLongHorizonStage({
      state,
      record,
      target,
      imageInputs,
      instruction: delegationInstruction(record, step),
      inputId: null,
      delegationStep: step
    });
  }

  private async startLongHorizonStage(input: {
    state: TetiTaskTransportStoreState;
    record: CollaborationTaskTransportRecord;
    target: TaskExecutionTarget;
    imageInputs: Array<{ attachmentId: string; mimeType: "image/jpeg" | "image/png"; path: string }>;
    instruction: string;
    inputId: string | null;
    delegationStep?: DelegationChildStep;
  }): Promise<CollaborationTaskTransportRecord> {
    const { state, record, target, imageInputs } = input;
    const session = record.longHorizon;
    const workspace = record.workspaceBinding;
    if (!session || !workspace || !this.executor?.prepareExecution) {
      throw new TaskTransportRuntimeError("TASK_STAGE_UNAVAILABLE", "Long-horizon stage execution is unavailable.");
    }
    if (Date.parse(session.continuationExpiresAt) <= this.now().getTime()) {
      expireRecord(record, this.now().toISOString());
      await this.store.save(state);
      throw new TaskTransportRuntimeError("TASK_EXPIRED", "The collaboration continuation lease has expired.");
    }
    if (session.stages.length >= LONG_HORIZON_LIMITS.maximumStages) {
      throw new TaskTransportRuntimeError("TASK_STAGE_LIMIT", "The collaboration reached its bounded stage limit.");
    }
    this.refreshLongHorizonTargets(state);
    const delegationTargetMatches = input.delegationStep
      && record.delegationPlan
      && input.delegationStep.stepIndex === session.stages.length + 1
      && input.delegationStep.childAgentId === target.childAgentId
      && input.delegationStep.connectorId === target.connectorId
      && input.delegationStep.capabilityId === target.capabilityId;
    if (!delegationTargetMatches && !session.availableChildAgents.some((candidate) =>
      candidate.childAgentId === target.childAgentId
      && candidate.connectorId === target.connectorId)) {
      throw new TaskTransportRuntimeError("TASK_CHILD_UNAVAILABLE", "The selected Child Agent is unavailable.");
    }
    const stageIndex = session.stages.length + 1;
    const executionTaskId = longHorizonExecutionTaskId(record.request.taskId, stageIndex);
    const stageInstruction = boundedStageInstruction(record, input.instruction, stageIndex);
    const execution: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId: executionTaskId,
      adapterId: target.connectorId,
      agentId: target.childAgentId,
      capabilityId: target.capabilityId,
      input: {
        kind: imageInputs.length > 0 ? "parts" : "text",
        text: stageInstruction,
        images: imageInputs
      },
      createdAt: this.now().toISOString()
    };
    const handle = await this.executor.prepareExecution({
      taskId: executionTaskId,
      workspaceId: workspace.workspaceId,
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      resume: false
    });
    const now = this.now().toISOString();
    if (input.delegationStep && record.delegationPlan) {
      input.delegationStep.state = "working";
      input.delegationStep.executionTaskId = executionTaskId;
      input.delegationStep.startedAt = now;
      record.delegationPlan.phase = "working";
      record.delegationPlan.currentStepIndex = input.delegationStep.stepIndex;
      record.delegationPlan.updatedAt = now;
      appendDelegationAudit(record.delegationPlan, {
        action: "step_started",
        actor: "host",
        stepId: input.delegationStep.stepId
      }, now, this.taskIdFactory);
    }
    if (session.pendingInput && session.pendingInput.inputId === input.inputId) {
      session.pendingInput.consumedAt = now;
    }
    session.currentStageIndex = stageIndex;
    session.workspaceRevision = workspace.workspaceRevision;
    session.phase = "working";
    session.pauseRequested = false;
    session.pendingInput = null;
    session.inputRequest = null;
    session.progress = progress("running", stageIndex - 1, LONG_HORIZON_LIMITS.maximumStages, `阶段 ${stageIndex} 正在执行`, now);
    session.stages.push({
      stageId: `stage:${stageIndex}`,
      stageIndex,
      executionTaskId,
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      state: "working",
      workspaceRevision: workspace.workspaceRevision,
      workspaceMutation: target.workspacePolicy === "snapshot"
        && !workspace.workspaceId.startsWith("workspace:none.")
        && workspace.access.some((access) => access === "write" || access === "create_artifact")
        ? "snapshot_commit"
        : "none",
      inputId: input.inputId,
      instructionDigest: digest(input.instruction),
      progress: structuredClone(session.progress),
      artifactIds: [],
      checkpointAvailable: false,
      startedAt: now,
      updatedAt: now
    });
    const previousChildAgentId = session.stages.at(-2)?.childAgentId;
    if (stageIndex === 1 || previousChildAgentId !== target.childAgentId) {
      appendLongHorizonAudit(session, {
        action: "child_selected",
        actor: "local_user",
        stageIndex,
        childAgentId: target.childAgentId,
        workspaceRevision: workspace.workspaceRevision
      }, now);
    }
    if (stageIndex > 1) {
      appendLongHorizonAudit(session, {
        action: "resumed",
        actor: "local_user",
        stageIndex,
        childAgentId: target.childAgentId,
        workspaceRevision: workspace.workspaceRevision
      }, now);
    }
    appendLongHorizonAudit(session, {
      action: "stage_started",
      actor: "host",
      stageIndex,
      childAgentId: target.childAgentId,
      workspaceRevision: workspace.workspaceRevision
    }, now);
    record.state = "working";
    record.approval = "consumed";
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = now;
    delete record.safeErrorCode;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);

    const grant = createExecutionGrant(
      record.request,
      target,
      workspace,
      this.now(),
      execution,
      input.delegationStep?.workspaceAccess
    );
    const delegationDeadline = input.delegationStep
      ? new Date(Math.min(
          Date.parse(session.continuationExpiresAt),
          this.now().getTime() + input.delegationStep.budget.timeoutMs
        )).toISOString()
      : session.continuationExpiresAt;
    const authority = createExecutionAuthority(
      grant,
      execution,
      target,
      handle.executionEpoch,
      delegationDeadline
    );
    void this.executor.execute(execution, authority).then(
      (result) => this.enqueueOperation(() => this.finishExecution(
        record.request.taskId,
        result,
        handle.executionEpoch,
        executionTaskId
      )),
      () => this.enqueueOperation(() => this.finishExecution(
        record.request.taskId,
        null,
        handle.executionEpoch,
        executionTaskId
      ))
    ).catch(() => undefined);
    return structuredClone(record);
  }

  private refreshLongHorizonTargets(state: TetiTaskTransportStoreState): boolean {
    let changed = false;
    for (const record of state.records) {
      const session = record.longHorizon;
      if (!session || record.direction !== "incoming" || isTerminalTaskState(record.state)) continue;
      const requiredModes = taskInputImages(record.request.input).length > 0
        ? ["text", "image"] as const
        : ["text"] as const;
      const targets = this.executor?.listTargets?.(
        record.request.offerId,
        record.request.capabilityId,
        requiredModes
      ) ?? (() => {
        const target = this.executor?.resolveTarget(
          record.request.offerId,
          record.request.capabilityId,
          requiredModes
        );
        return target ? [target] : [];
      })();
      const next = targets.map(({ childAgentId, connectorId }) => ({ childAgentId, connectorId }));
      if (JSON.stringify(next) !== JSON.stringify(session.availableChildAgents)) {
        session.availableChildAgents = next;
        session.updatedAt = this.now().toISOString();
        changed = true;
      }
    }
    return changed;
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
        mode: request.executionMode === "long_horizon" ? "durable_collaboration" : "ephemeral_task",
        access: [...(request.workspace?.access ?? ["read", "write", "create_artifact"])]
      };
    }
    const workspaceRequest = request.workspace ?? {
      kind: "temporary" as const,
      access: ["read", "write", "create_artifact"] as const
    };
    if (workspaceRequest.kind === "temporary") {
      if (request.executionMode === "long_horizon") {
        const workspace = await this.workspaceStore.create({
          ownerTetiId: localTetiId,
          participantTetiIds: [request.requesterTetiId],
          mode: "durable_collaboration",
          retentionPolicy: { kind: "retain" }
        });
        return {
          workspaceId: workspace.workspaceId,
          workspaceRevision: workspace.revision,
          mode: workspace.mode,
          access: [...workspaceRequest.access]
        };
      }
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
    if (record.longHorizon) {
      record.longHorizon.phase = "canceled";
      record.longHorizon.progress = progress("canceled", null, null, "接收端已拒绝长期协作", record.updatedAt);
      appendLongHorizonAudit(record.longHorizon, {
        action: "canceled",
        actor: "local_user",
        stageIndex: null,
        safeErrorCode: record.safeErrorCode
      }, record.updatedAt);
    }
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async cancel(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Task was not found.");
    if (isTerminalTaskState(record.state)) return structuredClone(record);
    const canceledAt = this.now().toISOString();
    if (record.direction === "incoming") {
      this.executor?.cancel(currentExecutionTaskId(record) ?? taskId);
      record.state = "canceled";
      record.statusRevision = (record.statusRevision ?? 0) + 1;
      record.statusPending = true;
      record.safeErrorCode = "TASK_CANCELED_BY_USER";
      if (record.longHorizon) {
        record.longHorizon.phase = "canceled";
        record.longHorizon.progress = progress("canceled", null, null, "协作任务已取消", canceledAt);
        appendLongHorizonAudit(record.longHorizon, {
          action: "canceled",
          actor: "local_user",
          stageIndex: record.longHorizon.currentStageIndex || null
        }, canceledAt);
      }
      if (record.delegationPlan) {
        record.delegationPlan.phase = "canceled";
        record.delegationPlan.updatedAt = canceledAt;
        const activeStep = record.delegationPlan.steps.find((step) => step.state === "working");
        if (activeStep) {
          activeStep.state = "canceled";
          activeStep.completedAt = canceledAt;
          activeStep.safeErrorCode = "TASK_CANCELED_BY_USER";
        }
        appendDelegationAudit(record.delegationPlan, {
          action: "plan_canceled",
          actor: "local_user",
          stepId: activeStep?.stepId ?? null,
          safeErrorCode: "TASK_CANCELED_BY_USER"
        }, canceledAt, this.taskIdFactory);
      }
    } else {
      record.cancelPending = true;
    }
    record.updatedAt = canceledAt;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async submitLongHorizonInput(
    taskId: string,
    instruction: string
  ): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = state.records.find((candidate) =>
      candidate.direction === "outgoing" && candidate.request.taskId === taskId
    );
    if (!record?.peerLongHorizon || record.state !== "input_required") {
      throw new TaskTransportRuntimeError("TASK_INPUT_NOT_REQUIRED", "The collaboration is not waiting for input.");
    }
    const text = instruction.trim();
    if (!text || new TextEncoder().encode(text).byteLength > LONG_HORIZON_LIMITS.maximumInstructionBytes) {
      throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Supplemental instruction is invalid or too large.");
    }
    if (Date.parse(record.peerLongHorizon.continuationExpiresAt) <= this.now().getTime()) {
      expireRecord(record, this.now().toISOString());
      await this.store.save(state);
      throw new TaskTransportRuntimeError("TASK_EXPIRED", "The collaboration continuation lease has expired.");
    }
    if (record.inputPending) {
      throw new TaskTransportRuntimeError("TASK_INPUT_PENDING", "A supplemental instruction is already pending delivery.");
    }
    const createdAt = this.now().toISOString();
    const payload: TetiTaskInputPayload = {
      schemaVersion: 1,
      taskId,
      requesterTetiId: record.request.requesterTetiId,
      targetTetiId: record.request.targetTetiId,
      inputId: randomUUID(),
      expectedStageIndex: record.peerLongHorizon.currentStageIndex,
      instruction: text,
      createdAt
    };
    record.inputPending = payload;
    delete record.inputSentAt;
    record.updatedAt = createdAt;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async receiveLongHorizonInput(input: {
    envelope: TetiApplicationEnvelope<TetiTaskInputPayload>;
    connection: TetiConnectionRecord;
    receivedAt?: string;
  }): Promise<void> {
    const account = await this.accountStorage.load();
    if (!account) throw new TaskTransportRuntimeError("TASK_ACCOUNT_REQUIRED", "A local Teti account is required.");
    const payload = input.envelope.payload;
    requireInboundTaskIdentity(input.envelope, input.connection, account.id, payload);
    const state = await this.store.load();
    const record = findTaskRecord(state, "incoming", payload.requesterTetiId, payload.taskId);
    const session = record?.longHorizon;
    if (session?.audit.some((event) => event.action === "input_received" && event.inputId === payload.inputId)) {
      return;
    }
    if (!record || !session || record.state !== "input_required"
      || !["input_required", "paused"].includes(session.phase)) {
      throw new TaskTransportRuntimeError("TASK_INPUT_NOT_REQUIRED", "The collaboration is not waiting for input.");
    }
    if (Date.parse(session.continuationExpiresAt) <= this.now().getTime()) {
      expireRecord(record, this.now().toISOString());
      await this.store.save(state);
      return;
    }
    if (payload.expectedStageIndex !== session.currentStageIndex) {
      throw new TaskTransportRuntimeError("TASK_INPUT_STAGE_CONFLICT", "Supplemental input targets a stale stage.");
    }
    if (session.pendingInput?.inputId === payload.inputId) return;
    if (session.pendingInput) {
      throw new TaskTransportRuntimeError("TASK_INPUT_CONFLICT", "Another supplemental input is already pending.");
    }
    const receivedAt = validTimestampOrNow(input.receivedAt, this.now()).toISOString();
    session.pendingInput = {
      inputId: payload.inputId,
      instruction: payload.instruction,
      instructionDigest: digest(payload.instruction),
      source: "remote_requester",
      createdAt: payload.createdAt
    };
    appendLongHorizonAudit(session, {
      action: "input_received",
      actor: "remote_peer",
      stageIndex: session.currentStageIndex,
      inputId: payload.inputId
    }, receivedAt);
    session.updatedAt = receivedAt;
    record.updatedAt = receivedAt;
    await this.store.save(state);
  }

  async pauseLongHorizon(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireIncomingLongHorizon(state, taskId, this.now());
    const session = record.longHorizon!;
    const now = this.now().toISOString();
    if (session.phase === "working") {
      session.pauseRequested = true;
      appendLongHorizonAudit(session, {
        action: "pause_requested",
        actor: "local_user",
        stageIndex: session.currentStageIndex
      }, now);
    } else if (session.phase === "input_required") {
      session.phase = "paused";
      appendLongHorizonAudit(session, {
        action: "paused",
        actor: "local_user",
        stageIndex: session.currentStageIndex
      }, now);
    } else if (session.phase !== "paused") {
      throw new TaskTransportRuntimeError("TASK_PAUSE_UNAVAILABLE", "The collaboration cannot be paused now.");
    }
    session.updatedAt = now;
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = now;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async continueLongHorizon(
    taskId: string,
    childAgentId?: string
  ): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireIncomingLongHorizon(state, taskId, this.now());
    const session = record.longHorizon!;
    if (!session.pendingInput || !["input_required", "paused"].includes(session.phase)) {
      throw new TaskTransportRuntimeError("TASK_INPUT_REQUIRED", "A requester instruction is required before the next stage.");
    }
    this.refreshLongHorizonTargets(state);
    const candidates = session.availableChildAgents;
    const previousStage = session.stages.at(-1);
    const selected = childAgentId
      ? candidates.find((candidate) => candidate.childAgentId === childAgentId)
      : candidates.find((candidate) =>
          candidate.childAgentId === previousStage?.childAgentId
          && candidate.connectorId === previousStage.connectorId
        );
    if (!childAgentId && previousStage && !selected) {
      throw new TaskTransportRuntimeError(
        "TASK_CHILD_SELECTION_REQUIRED",
        "The previous Child Agent is unavailable; explicitly select another Child Agent."
      );
    }
    if (!selected) throw new TaskTransportRuntimeError("TASK_CHILD_UNAVAILABLE", "No Child Agent is available.");
    const resolvedTargets = this.executor?.listTargets?.(
      record.request.offerId,
      record.request.capabilityId,
      ["text"]
    ) ?? (() => {
      const resolved = this.executor?.resolveTarget(
        record.request.offerId,
        record.request.capabilityId,
        ["text"]
      );
      return resolved ? [resolved] : [];
    })();
    const target = resolvedTargets.find((candidate) =>
      candidate.childAgentId === selected.childAgentId
      && candidate.connectorId === selected.connectorId
    );
    if (!target) {
      throw new TaskTransportRuntimeError("TASK_CHILD_UNAVAILABLE", "The selected Child Agent is no longer ready.");
    }
    const workspace = record.workspaceBinding;
    if (!workspace) throw new TaskTransportRuntimeError("TASK_WORKSPACE_UNAVAILABLE", "Task Workspace is unavailable.");
    if (this.workspaceStore && !workspace.workspaceId.startsWith("workspace:none.")) {
      const current = await this.workspaceStore.get(workspace.workspaceId);
      if (!current || current.revision !== workspace.workspaceRevision
        || current.revision !== session.workspaceRevision) {
        throw new TaskTransportRuntimeError("TASK_WORKSPACE_REVISION_CONFLICT", "Workspace revision changed before continuation.");
      }
    }
    const images = taskInputImages(record.request.input);
    const imageInputs = await Promise.all(images.map(async (part) => {
      const path = await this.attachmentStore?.resolveImage({ taskId, purpose: "input", part });
      if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images are unavailable.");
      return { attachmentId: part.attachmentId, mimeType: part.mimeType, path };
    }));
    return this.startLongHorizonStage({
      state,
      record,
      target,
      imageInputs,
      instruction: session.pendingInput.instruction,
      inputId: session.pendingInput.inputId
    });
  }

  async completeLongHorizon(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireIncomingLongHorizon(state, taskId, this.now());
    const session = record.longHorizon!;
    if (!["input_required", "paused"].includes(session.phase)
      || session.pendingInput
      || session.artifacts.length === 0) {
      throw new TaskTransportRuntimeError("TASK_COMPLETE_UNAVAILABLE", "The collaboration cannot be completed now.");
    }
    const now = this.now().toISOString();
    const final = session.artifacts.at(-1)!;
    final.role = "final";
    session.phase = "completed";
    session.inputRequest = null;
    session.progress = progress("completed", session.currentStageIndex, session.currentStageIndex, "长期协作已完成", now);
    appendLongHorizonAudit(session, {
      action: "completed",
      actor: "local_user",
      stageIndex: session.currentStageIndex,
      artifactId: final.artifactId,
      workspaceRevision: session.workspaceRevision
    }, now);
    record.state = "completed";
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = now;
    delete record.safeErrorCode;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
    return structuredClone(record);
  }

  async renewLongHorizon(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord> {
    const state = await this.store.load();
    const record = requireIncomingLongHorizon(state, taskId, this.now());
    const session = record.longHorizon!;
    if (!["input_required", "paused"].includes(session.phase)) {
      throw new TaskTransportRuntimeError(
        "TASK_RENEWAL_UNAVAILABLE",
        "A collaboration can be renewed only at a stage boundary."
      );
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > LONG_HORIZON_LIMITS.maximumRenewalMs
      || session.renewalCount >= LONG_HORIZON_LIMITS.maximumRenewals) {
      throw new TaskTransportRuntimeError("TASK_RENEWAL_LIMIT", "Task renewal exceeds the bounded policy.");
    }
    const absoluteLimit = Date.parse(record.request.createdAt) + LONG_HORIZON_LIMITS.maximumLifetimeMs;
    const nextExpiry = Math.min(this.now().getTime() + ttlMs, absoluteLimit);
    if (nextExpiry <= Date.parse(session.continuationExpiresAt)) {
      throw new TaskTransportRuntimeError("TASK_RENEWAL_LIMIT", "Task renewal does not extend the current lease.");
    }
    const now = this.now().toISOString();
    session.continuationExpiresAt = new Date(nextExpiry).toISOString();
    session.renewalCount += 1;
    appendLongHorizonAudit(session, {
      action: "renewed",
      actor: "local_user",
      stageIndex: session.currentStageIndex || null
    }, now);
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = now;
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

  private async resolveInputImages(
    record: CollaborationTaskTransportRecord
  ): Promise<Array<{ attachmentId: string; mimeType: "image/jpeg" | "image/png"; path: string }>> {
    return Promise.all(taskInputImages(record.request.input).map(async (part) => {
      const path = await this.attachmentStore?.resolveImage({
        taskId: record.request.taskId,
        purpose: "input",
        part
      });
      if (!path) throw new TaskTransportRuntimeError("TASK_ATTACHMENTS_PENDING", "Task images are unavailable.");
      return { attachmentId: part.attachmentId, mimeType: part.mimeType, path };
    }));
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
      const executionTaskId = currentExecutionTaskId(record) ?? record.request.taskId;
      const handle = await this.executor?.getExecutionHandle?.(executionTaskId);
      if (this.executor?.getTask(executionTaskId)?.state === "working") {
        if (record.longHorizon && handle && updateLongHorizonProgress(record, handle, this.now())) {
          changed = true;
        }
        continue;
      }
      if (record.longHorizon) {
        await this.finishLongHorizonStage(state, record, null, handle, executionTaskId);
        changed = true;
        continue;
      }
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
      const pendingArtifacts = record.artifacts.filter(
        (artifact) => !record.sentArtifactIds?.includes(artifact.artifactId)
      );
      for (const artifact of pendingArtifacts) {
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
          expiresAt: record.longHorizon
            ? record.longHorizon.continuationExpiresAt
            : new Date(Date.parse(createdAt) + DEFAULT_TASK_REQUEST_TTL_MS).toISOString(),
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
        const stageEntry = record.longHorizon?.artifacts.find(
          (entry) => entry.artifactId === artifact.artifactId
        );
        const payload: TetiTaskArtifactPayload = stageEntry ? {
          schemaVersion: 2,
          taskId: record.request.taskId,
          requesterTetiId: record.request.requesterTetiId,
          targetTetiId: record.request.targetTetiId,
          artifact: structuredClone(artifact),
          createdAt: artifact.createdAt,
          stageIndex: stageEntry.stageIndex,
          role: stageEntry.role
        } : {
          schemaVersion: 1,
          taskId: record.request.taskId,
          requesterTetiId: record.request.requesterTetiId,
          targetTetiId: record.request.targetTetiId,
          artifact: structuredClone(artifact),
          createdAt: artifact.createdAt
        };
        try {
          await this.applicationManager.sendTaskArtifact(connection.requestId, payload);
          record.sentArtifactIds = appendUnique(record.sentArtifactIds, artifact.artifactId);
          record.artifactPending = record.artifacts.some(
            (candidate) => !record.sentArtifactIds?.includes(candidate.artifactId)
          );
          await this.store.save(state);
        } catch {
          return;
        }
      }
    }
    if (record.direction === "incoming" && record.statusPending && record.statusRevision) {
      const payload: TetiTaskStatusPayload = record.longHorizon ? {
        schemaVersion: 2,
        taskId: record.request.taskId,
        requesterTetiId: record.request.requesterTetiId,
        targetTetiId: record.request.targetTetiId,
        revision: record.statusRevision,
        state: networkTaskState(record.state),
        updatedAt: record.updatedAt,
        longHorizon: peerLongHorizonStatus(record.longHorizon),
        ...(record.safeErrorCode ? { safeErrorCode: record.safeErrorCode } : {})
      } : {
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
    if (record.direction === "outgoing" && record.inputPending && !record.inputSentAt) {
      try {
        await this.applicationManager.sendTaskInput(connection.requestId, record.inputPending);
        record.inputSentAt = this.now().toISOString();
        record.updatedAt = record.inputSentAt;
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
    executionEpoch = 1,
    executionTaskId = taskId
  ): Promise<void> {
    const state = await this.store.load();
    const record = state.records.find((candidate) =>
      candidate.direction === "incoming" && candidate.request.taskId === taskId
    );
    if (!record || isTerminalTaskState(record.state)) return;
    const handle = await this.executor?.getExecutionHandle?.(executionTaskId);
    if (handle && handle.executionEpoch !== executionEpoch) return;
    if (record.longHorizon) {
      await this.finishLongHorizonStage(state, record, result, handle, executionTaskId);
      return;
    }
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

  private async finishLongHorizonStage(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord,
    result: CallableAdapterTaskSnapshot | null,
    handle: ExecutionHandle | null | undefined,
    executionTaskId: string
  ): Promise<void> {
    const session = record.longHorizon!;
    const stage = session.stages.find((candidate) => candidate.executionTaskId === executionTaskId);
    if (!stage || stage.stageIndex !== session.currentStageIndex || stage.state !== "working") return;
    const completedAt = this.now().toISOString();
    if (Date.parse(session.continuationExpiresAt) <= this.now().getTime()
      || result?.safeErrorCode === "ADAPTER_TASK_EXPIRED") {
      expireRecord(record, completedAt);
      stage.state = "canceled";
      stage.safeErrorCode = "TASK_EXPIRED";
      stage.updatedAt = completedAt;
      stage.completedAt = completedAt;
      await this.store.save(state);
      await this.trySendPendingForRecord(state, record);
      return;
    }

    const delegationStep = record.delegationPlan?.steps.find((candidate) =>
      candidate.kind === "child_execution" && candidate.executionTaskId === executionTaskId
    );
    const unsupportedImageArtifact = !record.delegationPlan
      && result?.artifact?.kind === "parts"
      && result.artifact.images.length > 0;
    const delegationOutputExceeded = delegationStep?.kind === "child_execution"
      && result?.artifact
      && new TextEncoder().encode(result.artifact.text).byteLength > delegationStep.budget.maxOutputBytes;
    if (result?.state === "completed" && result.artifact
      && !unsupportedImageArtifact && !delegationOutputExceeded) {
      const resultImages = record.delegationPlan && result.artifact.kind === "parts"
        ? result.artifact.images
        : [];
      const artifact: CollaborationTaskArtifact = {
        schemaVersion: 2,
        taskId: record.request.taskId,
        artifactId: randomUUID(),
        parts: [
          { kind: "text", text: result.artifact.text },
          ...structuredClone(resultImages)
        ],
        createdAt: completedAt
      };
      validateTaskArtifact(artifact);
      record.artifacts = [...(record.artifacts ?? []), artifact];
      stage.artifactIds.push(artifact.artifactId);
      stage.state = "completed";
      stage.progress = progress("completed", 1, 1, `阶段 ${stage.stageIndex} 已完成`, completedAt);
      stage.updatedAt = completedAt;
      stage.completedAt = completedAt;
      if (record.workspaceBinding && this.workspaceStore
        && !record.workspaceBinding.workspaceId.startsWith("workspace:none.")) {
        const workspace = await this.workspaceStore.get(record.workspaceBinding.workspaceId);
        const expectedRevision = stage.workspaceRevision
          + (stage.workspaceMutation === "snapshot_commit" ? 1 : 0);
        if (!workspace || workspace.revision !== expectedRevision) {
          record.artifacts = record.artifacts.filter((candidate) => candidate.artifactId !== artifact.artifactId);
          stage.artifactIds = [];
          stage.state = "failed";
          stage.safeErrorCode = "TASK_WORKSPACE_REVISION_CONFLICT";
          stage.progress = progress("failed", null, null, "Workspace revision 冲突", completedAt);
          session.phase = "input_required";
          session.pauseRequested = false;
          session.inputRequest = {
            requestId: randomUUID(),
            prompt: "Workspace 版本发生冲突，请检查后补充指令并选择 Child Agent 继续。",
            createdAt: completedAt
          };
          session.progress = progress(
            "failed",
            stage.stageIndex - 1,
            LONG_HORIZON_LIMITS.maximumStages,
            "Workspace revision 冲突；阶段结果未发布",
            completedAt
          );
          appendLongHorizonAudit(session, {
            action: "stage_failed",
            actor: "host",
            stageIndex: stage.stageIndex,
            childAgentId: stage.childAgentId,
            workspaceRevision: stage.workspaceRevision,
            safeErrorCode: stage.safeErrorCode
          }, completedAt);
          if (record.delegationPlan && delegationStep?.kind === "child_execution") {
            delegationStep.state = "failed";
            delegationStep.completedAt = completedAt;
            delegationStep.safeErrorCode = stage.safeErrorCode;
            record.delegationPlan.phase = "failed";
            record.delegationPlan.updatedAt = completedAt;
            appendDelegationAudit(record.delegationPlan, {
              action: "step_failed",
              actor: "host",
              stepId: delegationStep.stepId,
              safeErrorCode: stage.safeErrorCode
            }, completedAt, this.taskIdFactory);
          }
          record.state = record.delegationPlan ? "failed" : "input_required";
          record.safeErrorCode = stage.safeErrorCode;
          record.statusRevision = (record.statusRevision ?? 0) + 1;
          record.statusPending = true;
          record.updatedAt = completedAt;
          await this.store.save(state);
          await this.trySendPendingForRecord(state, record);
          return;
        } else {
          record.workspaceBinding.workspaceRevision = workspace.revision;
          session.workspaceRevision = workspace.revision;
        }
      }
      session.artifacts.push({
        artifactId: artifact.artifactId,
        stageIndex: stage.stageIndex,
        role: "intermediate",
        createdAt: completedAt
      });
      const checkpoint = {
        checkpointId: randomUUID(),
        stageIndex: stage.stageIndex,
        workspaceRevision: session.workspaceRevision,
        artifactIds: [...stage.artifactIds],
        digest: digest(JSON.stringify({
          taskId: record.request.taskId,
          stageIndex: stage.stageIndex,
          workspaceRevision: session.workspaceRevision,
          artifactIds: stage.artifactIds
        })),
        createdAt: completedAt
      };
      session.checkpoints.push(checkpoint);
      stage.checkpointAvailable = true;
      if (record.delegationPlan && delegationStep?.kind === "child_execution") {
        delegationStep.state = "completed";
        delegationStep.completedAt = completedAt;
        delegationStep.artifactIds = [artifact.artifactId];
        record.delegationPlan.artifacts.push({
          artifactId: artifact.artifactId,
          stepId: delegationStep.stepId,
          producer: {
            kind: "child_agent",
            childAgentId: delegationStep.childAgentId,
            connectorId: delegationStep.connectorId,
            resourceBindingId: delegationStep.resourceBindingId
          },
          workspaceRevision: session.workspaceRevision,
          role: "intermediate",
          createdAt: completedAt
        });
        appendDelegationAudit(record.delegationPlan, {
          action: "artifact_recorded",
          actor: "child_agent",
          stepId: delegationStep.stepId,
          artifactId: artifact.artifactId
        }, completedAt, this.taskIdFactory);
        appendDelegationAudit(record.delegationPlan, {
          action: "step_completed",
          actor: "host",
          stepId: delegationStep.stepId
        }, completedAt, this.taskIdFactory);
        record.delegationPlan.updatedAt = completedAt;
        appendLongHorizonAudit(session, {
          action: "artifact_published",
          actor: "child_agent",
          stageIndex: stage.stageIndex,
          artifactId: artifact.artifactId,
          childAgentId: stage.childAgentId
        }, completedAt);
        appendLongHorizonAudit(session, {
          action: "checkpoint_created",
          actor: "host",
          stageIndex: stage.stageIndex,
          artifactId: artifact.artifactId,
          workspaceRevision: session.workspaceRevision
        }, completedAt);
        record.artifactPending = true;
        record.artifactAttachmentsReady = true;
        record.updatedAt = completedAt;
        session.updatedAt = completedAt;
        const nextStep = record.delegationPlan.steps.find((candidate) =>
          candidate.kind === "child_execution" && candidate.state === "pending"
        );
        if (nextStep?.kind === "child_execution") {
          try {
            await this.startDelegationStep(state, record, nextStep);
          } catch (error) {
            const safeErrorCode = error instanceof TaskTransportRuntimeError
              ? error.code
              : "TASK_DELEGATION_TARGET_CHANGED";
            nextStep.state = "failed";
            nextStep.completedAt = completedAt;
            nextStep.safeErrorCode = safeErrorCode;
            record.delegationPlan.phase = "failed";
            record.delegationPlan.currentStepIndex = nextStep.stepIndex;
            record.delegationPlan.updatedAt = completedAt;
            appendDelegationAudit(record.delegationPlan, {
              action: "step_failed",
              actor: "host",
              stepId: nextStep.stepId,
              safeErrorCode
            }, completedAt, this.taskIdFactory);
            session.phase = "failed";
            session.inputRequest = null;
            session.pendingInput = null;
            session.progress = progress(
              "failed",
              nextStep.stepIndex - 1,
              record.delegationPlan.maximumChildCalls,
              "下一委派目标或权限已改变；计划已停止",
              completedAt
            );
            record.state = "failed";
            record.safeErrorCode = safeErrorCode;
            record.statusRevision = (record.statusRevision ?? 0) + 1;
            record.statusPending = true;
            record.updatedAt = completedAt;
            validateDelegationPlanState(record.delegationPlan);
            await this.store.save(state);
            await this.trySendPendingForRecord(state, record);
          }
          return;
        }
        await this.completeDelegation(state, record, completedAt);
        return;
      }
      session.phase = session.pauseRequested ? "paused" : "input_required";
      session.pauseRequested = false;
      session.inputRequest = {
        requestId: randomUUID(),
        prompt: "请补充下一阶段指令，或确认当前结果为最终结果。",
        createdAt: completedAt
      };
      session.progress = progress(
        session.phase === "paused" ? "paused" : "interrupted",
        stage.stageIndex,
        LONG_HORIZON_LIMITS.maximumStages,
        session.phase === "paused" ? "已在阶段边界暂停" : "等待用户补充下一阶段指令",
        completedAt
      );
      appendLongHorizonAudit(session, {
        action: "artifact_published",
        actor: "child_agent",
        stageIndex: stage.stageIndex,
        artifactId: artifact.artifactId,
        childAgentId: stage.childAgentId
      }, completedAt);
      appendLongHorizonAudit(session, {
        action: "checkpoint_created",
        actor: "host",
        stageIndex: stage.stageIndex,
        artifactId: artifact.artifactId,
        workspaceRevision: session.workspaceRevision
      }, completedAt);
      appendLongHorizonAudit(session, {
        action: session.phase === "paused" ? "paused" : "input_requested",
        actor: "host",
        stageIndex: stage.stageIndex
      }, completedAt);
      record.artifactPending = true;
      record.artifactAttachmentsReady = true;
      record.state = "input_required";
      delete record.safeErrorCode;
    } else {
      const interrupted = handle?.progress.state === "interrupted";
      stage.state = result?.state === "canceled" ? "canceled" : interrupted ? "interrupted" : "failed";
      stage.safeErrorCode = unsupportedImageArtifact
        ? "TASK_LONG_HORIZON_TEXT_ONLY"
        : delegationOutputExceeded
          ? "TASK_DELEGATION_OUTPUT_BUDGET"
        : result?.safeErrorCode ?? (interrupted
        ? "TASK_EXECUTION_INTERRUPTED"
        : "ADAPTER_INTERNAL_ERROR");
      stage.checkpointAvailable = handle?.resumeCapability === "checkpoint_restart";
      stage.progress = progress("failed", null, null, "阶段执行失败，等待用户选择如何继续", completedAt);
      stage.updatedAt = completedAt;
      stage.completedAt = completedAt;
      session.phase = session.pauseRequested ? "paused" : "input_required";
      session.pauseRequested = false;
      session.inputRequest = {
        requestId: randomUUID(),
        prompt: "本阶段失败。可补充指令并显式选择原 Child 或其他 Child 继续。",
        createdAt: completedAt
      };
      session.progress = progress(
        session.phase === "paused" ? "paused" : "failed",
        stage.stageIndex - 1,
        LONG_HORIZON_LIMITS.maximumStages,
        "阶段失败，未自动切换 Child Agent",
        completedAt
      );
      appendLongHorizonAudit(session, {
        action: interrupted ? "restart_reconciled" : "stage_failed",
        actor: "host",
        stageIndex: stage.stageIndex,
        childAgentId: stage.childAgentId,
        safeErrorCode: stage.safeErrorCode
      }, completedAt);
      record.state = "input_required";
      record.safeErrorCode = stage.safeErrorCode;
      if (record.delegationPlan && delegationStep?.kind === "child_execution") {
        delegationStep.state = interrupted ? "interrupted" : result?.state === "canceled" ? "canceled" : "failed";
        delegationStep.completedAt = completedAt;
        delegationStep.safeErrorCode = stage.safeErrorCode;
        record.delegationPlan.phase = interrupted ? "interrupted" : "failed";
        record.delegationPlan.updatedAt = completedAt;
        appendDelegationAudit(record.delegationPlan, {
          action: interrupted ? "restart_reconciled" : "step_failed",
          actor: "host",
          stepId: delegationStep.stepId,
          safeErrorCode: stage.safeErrorCode
        }, completedAt, this.taskIdFactory);
        session.phase = "failed";
        session.inputRequest = null;
        session.pendingInput = null;
        session.progress = progress(
          "failed",
          delegationStep.stepIndex - 1,
          record.delegationPlan.maximumChildCalls,
          "委派步骤失败；计划已停止且未自动切换 Child Agent",
          completedAt
        );
        record.state = "failed";
      }
    }
    session.updatedAt = completedAt;
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = completedAt;
    await this.store.save(state);
    await this.trySendPendingForRecord(state, record);
  }

  private async completeDelegation(
    state: TetiTaskTransportStoreState,
    record: CollaborationTaskTransportRecord,
    completedAt: string
  ): Promise<void> {
    const plan = record.delegationPlan;
    const session = record.longHorizon;
    const aggregation = plan?.steps.at(-1);
    if (!plan || !session || !aggregation || aggregation.kind !== "artifact_aggregation") {
      throw new TaskTransportRuntimeError("TASK_DELEGATION_INVALID", "Delegation aggregation is unavailable.");
    }
    plan.phase = "aggregating";
    plan.currentStepIndex = aggregation.stepIndex;
    plan.updatedAt = completedAt;
    aggregation.state = "working";
    aggregation.startedAt = completedAt;
    appendDelegationAudit(plan, {
      action: "aggregation_started",
      actor: "host",
      stepId: aggregation.stepId
    }, completedAt, this.taskIdFactory);
    const intermediateIds = new Set(plan.artifacts
      .filter((entry) => entry.role === "intermediate")
      .map((entry) => entry.artifactId));
    const intermediateArtifacts = (record.artifacts ?? []).filter((artifact) =>
      intermediateIds.has(artifact.artifactId)
    );
    const finalArtifact: CollaborationTaskArtifact = {
      schemaVersion: 2,
      taskId: record.request.taskId,
      artifactId: randomUUID(),
      parts: [
        {
          kind: "text",
          text: aggregateDelegationText(intermediateArtifacts, MAX_TASK_ARTIFACT_TEXT_BYTES)
        },
        ...uniqueDelegationImages(intermediateArtifacts).slice(0, 4)
      ],
      createdAt: completedAt
    };
    validateTaskArtifact(finalArtifact);
    record.artifacts = [...(record.artifacts ?? []), finalArtifact];
    initializeAttachmentDiagnostics(record, "artifact", taskArtifactImages(finalArtifact));
    aggregation.state = "completed";
    aggregation.artifactId = finalArtifact.artifactId;
    aggregation.completedAt = completedAt;
    plan.artifacts.push({
      artifactId: finalArtifact.artifactId,
      stepId: aggregation.stepId,
      producer: {
        kind: "teti_host",
        resourceId: TETI_HOST_AGGREGATION_RESOURCE_ID
      },
      workspaceRevision: session.workspaceRevision,
      role: "final",
      createdAt: completedAt
    });
    plan.phase = "completed";
    plan.updatedAt = completedAt;
    appendDelegationAudit(plan, {
      action: "artifact_recorded",
      actor: "host",
      stepId: aggregation.stepId,
      artifactId: finalArtifact.artifactId
    }, completedAt, this.taskIdFactory);
    appendDelegationAudit(plan, {
      action: "plan_completed",
      actor: "host",
      stepId: aggregation.stepId,
      artifactId: finalArtifact.artifactId
    }, completedAt, this.taskIdFactory);
    session.artifacts.push({
      artifactId: finalArtifact.artifactId,
      stageIndex: session.currentStageIndex,
      role: "final",
      createdAt: completedAt
    });
    session.phase = "completed";
    session.inputRequest = null;
    session.pendingInput = null;
    session.progress = progress(
      "completed",
      plan.maximumChildCalls,
      plan.maximumChildCalls,
      "Teti Host 已完成委派与 Artifact 汇总",
      completedAt
    );
    session.updatedAt = completedAt;
    appendLongHorizonAudit(session, {
      action: "completed",
      actor: "host",
      stageIndex: session.currentStageIndex,
      artifactId: finalArtifact.artifactId,
      workspaceRevision: session.workspaceRevision
    }, completedAt);
    record.state = "completed";
    record.approval = "consumed";
    record.artifactPending = true;
    record.artifactAttachmentsReady = true;
    record.statusRevision = (record.statusRevision ?? 0) + 1;
    record.statusPending = true;
    record.updatedAt = completedAt;
    delete record.safeErrorCode;
    validateDelegationPlanState(plan);
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
  "connectionRequestId" | "capabilityId" | "text" | "ttlMs" | "attachments" | "workspace" | "executionMode"
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
  const executionMode = input.executionMode ?? "single_stage";
  if (executionMode !== "single_stage" && executionMode !== "long_horizon") {
    throw new TaskTransportRuntimeError("TASK_INPUT_INVALID", "Task execution mode is invalid.");
  }
  if (executionMode === "long_horizon"
    && (attachments.length > 0 || input.capabilityId === "image-editing")) {
    throw new TaskTransportRuntimeError(
      "TASK_LONG_HORIZON_TEXT_ONLY",
      "Long-horizon collaboration accepts text-only capabilities in Beta 0.2.8."
    );
  }
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
    executionMode,
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
    || record.request.executionMode !== input.executionMode
    || Date.parse(record.request.expiresAt) - Date.parse(record.request.createdAt) !== input.ttlMs
    || (input.offerId !== undefined && record.request.offerId !== input.offerId)) {
    throw new TaskTransportRuntimeError(
      "TASK_ID_CONFLICT",
      "The Task ID is already bound to different immutable content."
    );
  }
}

function taskInputForVersion(
  version: 1 | 2 | 3 | 4 | 5 | 6,
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
  const record: CollaborationTaskTransportRecord = {
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
  if (input.envelope.payload.executionMode === "long_horizon") {
    record.longHorizon = createLongHorizonState(input.envelope.payload, new Date(receivedAt));
  }
  return record;
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
      && Date.parse(effectiveTaskExpiry(record)) <= now.getTime()) {
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
  if (record.longHorizon && record.longHorizon.phase !== "expired") {
    record.longHorizon.phase = "expired";
    record.longHorizon.pauseRequested = false;
    record.longHorizon.inputRequest = null;
    record.longHorizon.pendingInput = null;
    record.longHorizon.progress = progress("canceled", null, null, "长期协作续期已过期", timestamp);
    appendLongHorizonAudit(record.longHorizon, {
      action: "expired",
      actor: "host",
      stageIndex: record.longHorizon.currentStageIndex || null,
      safeErrorCode: "TASK_EXPIRED"
    }, timestamp);
  }
  if (record.delegationPlan
    && !["completed", "failed", "canceled"].includes(record.delegationPlan.phase)) {
    record.delegationPlan.phase = "canceled";
    record.delegationPlan.updatedAt = timestamp;
    const activeStep = record.delegationPlan.steps.find((step) => step.state === "working");
    if (activeStep) {
      activeStep.state = "canceled";
      activeStep.completedAt = timestamp;
      activeStep.safeErrorCode = "TASK_EXPIRED";
    }
    appendDelegationAudit(record.delegationPlan, {
      action: "plan_canceled",
      actor: "host",
      stepId: activeStep?.stepId ?? null,
      safeErrorCode: "TASK_EXPIRED"
    }, timestamp, randomUUID);
  }
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
    return ["working", "completed", "failed", "canceled", "rejected", "auth_required", "input_required"]
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
  now: Date,
  execution?: CallableAdapterTaskRequest,
  workspaceAccess: TaskWorkspaceBinding["access"] = workspace.access
): ExecutionGrant {
  const issuedAt = now.toISOString();
  return {
    schemaVersion: 2,
    grantId: randomUUID(),
    taskId: execution?.taskId ?? request.taskId,
    requesterTetiId: request.requesterTetiId,
    capabilityId: execution?.capabilityId ?? request.capabilityId,
    agentId: target.childAgentId,
    adapterId: target.connectorId,
    inputDigest: execution
      ? digest(JSON.stringify(execution.input))
      : `sha256:${createHash("sha256").update(canonicalTaskRequestJson(request)).digest("hex")}`,
    issuedAt,
    expiresAt: new Date(now.getTime() + 2 * 60 * 1_000).toISOString(),
    singleUse: true,
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.workspaceRevision,
    workspaceAccess: [...workspaceAccess],
    userFileAccess: "none",
    commandPolicy: "fixed_adapter_entrypoint",
    networkPolicy: "agent_managed"
  };
}

function createExecutionAuthority(
  grant: ExecutionGrant,
  request: CallableAdapterTaskRequest,
  target: TaskExecutionTarget,
  executionEpoch: number,
  executionDeadlineAt?: string
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
    executionEpoch,
    ...(executionDeadlineAt ? { executionDeadlineAt } : {})
  });
}

function createLongHorizonState(
  request: CollaborationTaskRequest,
  now: Date
): LongHorizonTaskState {
  const timestamp = now.toISOString();
  const session: LongHorizonTaskState = {
    schemaVersion: 1,
    phase: "pending_approval",
    currentStageIndex: 0,
    workspaceRevision: 1,
    progress: progress("queued", 0, LONG_HORIZON_LIMITS.maximumStages, "等待接收端批准", timestamp),
    continuationExpiresAt: request.expiresAt,
    renewalCount: 0,
    pauseRequested: false,
    pendingInput: null,
    inputRequest: null,
    availableChildAgents: [],
    stages: [],
    checkpoints: [],
    artifacts: [],
    audit: [],
    updatedAt: timestamp
  };
  appendLongHorizonAudit(session, {
    action: "session_created",
    actor: "host",
    stageIndex: null,
    workspaceRevision: 1
  }, timestamp);
  return session;
}

function appendLongHorizonAudit(
  session: LongHorizonTaskState,
  event: Omit<LongHorizonAuditEvent, "eventId" | "sequence" | "timestamp">,
  timestamp: string
): void {
  if (session.audit.length >= LONG_HORIZON_LIMITS.maximumAuditEvents) {
    throw new TaskTransportRuntimeError("TASK_AUDIT_LIMIT", "Long-horizon audit capacity was reached.");
  }
  session.audit.push({
    eventId: randomUUID(),
    sequence: session.audit.length + 1,
    ...event,
    timestamp
  });
  session.updatedAt = timestamp;
}

function appendDelegationAudit(
  plan: NonNullable<CollaborationTaskTransportRecord["delegationPlan"]>,
  event: Omit<DelegationAuditEvent, "eventId" | "sequence" | "timestamp">,
  timestamp: string,
  idFactory: () => string
): void {
  if (plan.audit.length >= DELEGATION_LIMITS.maximumAuditEvents) {
    throw new TaskTransportRuntimeError("TASK_DELEGATION_AUDIT_LIMIT", "Delegation audit capacity was reached.");
  }
  plan.audit.push({
    eventId: idFactory(),
    sequence: plan.audit.length + 1,
    ...event,
    timestamp
  });
  plan.updatedAt = timestamp;
}

function progress(
  state: "queued" | "running" | "paused" | "interrupted" | "canceling" | "canceled" | "completed" | "failed",
  completedUnits: number | null,
  totalUnits: number | null,
  message: string | null,
  updatedAt: string
) {
  return { state, completedUnits, totalUnits, message, updatedAt } as const;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function effectiveTaskExpiry(record: CollaborationTaskTransportRecord): string {
  return record.longHorizon?.continuationExpiresAt
    ?? record.peerLongHorizon?.continuationExpiresAt
    ?? record.request.expiresAt;
}

function currentExecutionTaskId(record: CollaborationTaskTransportRecord): string | null {
  const session = record.longHorizon;
  if (!session || session.currentStageIndex === 0) return null;
  return session.stages.find((stage) => stage.stageIndex === session.currentStageIndex)?.executionTaskId ?? null;
}

function updateLongHorizonProgress(
  record: CollaborationTaskTransportRecord,
  handle: ExecutionHandle,
  now: Date
): boolean {
  const session = record.longHorizon;
  const stage = session?.stages.find((candidate) => candidate.executionTaskId === handle.taskId);
  if (!session || !stage || stage.state !== "working") return false;
  const previous = stage.progress;
  const next = handle.progress;
  if (previous.state === next.state
    && previous.completedUnits === next.completedUnits
    && previous.totalUnits === next.totalUnits
    && previous.message === next.message) return false;
  const timestamp = now.toISOString();
  stage.progress = { ...structuredClone(next), updatedAt: timestamp };
  stage.updatedAt = timestamp;
  session.progress = structuredClone(stage.progress);
  appendLongHorizonAudit(session, {
    action: "progress_updated",
    actor: "child_agent",
    stageIndex: stage.stageIndex,
    childAgentId: stage.childAgentId,
    workspaceRevision: stage.workspaceRevision
  }, timestamp);
  record.statusRevision = (record.statusRevision ?? 0) + 1;
  record.statusPending = true;
  record.updatedAt = timestamp;
  return true;
}

function longHorizonExecutionTaskId(taskId: string, stageIndex: number): string {
  const taskDigest = createHash("sha256").update(taskId).digest("hex").slice(0, 24);
  return `lh_${taskDigest}_${stageIndex}`;
}

function boundedStageInstruction(
  record: CollaborationTaskTransportRecord,
  instruction: string,
  stageIndex: number
): string {
  if (stageIndex === 1) return truncateUtf8(instruction, MAX_TASK_INPUT_TEXT_BYTES);
  const priorArtifacts = (record.artifacts ?? [])
    .map((artifact, index) => `阶段 ${index + 1} 中间结果:\n${taskArtifactText(artifact)}`)
    .join("\n\n");
  return truncateUtf8([
    `长期协作原始目标:\n${taskInputText(record.request.input)}`,
    priorArtifacts ? `已保留的中间结果:\n${priorArtifacts}` : "",
    `本阶段补充指令:\n${instruction}`,
    "仅完成当前阶段；是否继续由 Teti Host 在阶段边界决定。"
  ].filter(Boolean).join("\n\n"), MAX_TASK_INPUT_TEXT_BYTES);
}

function delegationInstruction(
  record: CollaborationTaskTransportRecord,
  step: DelegationChildStep
): string {
  if (step.stepIndex === 1) return taskInputText(record.request.input);
  return [
    `执行确定性委派计划的第 ${step.stepIndex} 步。`,
    `本步骤能力：${step.capabilityId}。`,
    "使用前序 Artifact 作为有界上下文，但不要联系任何远端 Teti 或再次委派。",
    "只返回当前步骤的结果，最终汇总由 Teti Host 完成。"
  ].join("\n");
}

function aggregateDelegationText(
  artifacts: readonly CollaborationTaskArtifact[],
  maximumBytes: number
): string {
  const sections = artifacts.map((artifact, index) =>
    `步骤 ${index + 1} 结果：\n${taskArtifactText(artifact)}`
  );
  return truncateUtf8([
    `Teti Host 已按冻结顺序完成 ${artifacts.length} 个 Child Agent 步骤。`,
    ...sections
  ].join("\n\n"), maximumBytes);
}

function uniqueDelegationImages(
  artifacts: readonly CollaborationTaskArtifact[]
): TaskImagePart[] {
  const images = new Map<string, TaskImagePart>();
  for (const artifact of artifacts) {
    for (const image of taskArtifactImages(artifact)) {
      if (!images.has(image.attachmentId)) images.set(image.attachmentId, structuredClone(image));
    }
  }
  return [...images.values()];
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (new TextEncoder().encode(characters.slice(0, middle).join("")).byteLength <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function taskArtifactText(artifact: CollaborationTaskArtifact): string {
  return artifact.schemaVersion === 1
    ? artifact.text
    : artifact.parts.find((part) => part.kind === "text")?.text ?? "";
}

function requireIncomingLongHorizon(
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
  if (!record?.longHorizon) {
    throw new TaskTransportRuntimeError("TASK_NOT_FOUND", "Long-horizon collaboration was not found.");
  }
  if (Date.parse(record.longHorizon.continuationExpiresAt) <= now.getTime()) {
    expireRecord(record, now.toISOString());
    throw new TaskTransportRuntimeError("TASK_EXPIRED", "The collaboration continuation lease has expired.");
  }
  if (["completed", "failed", "canceled", "expired"].includes(record.longHorizon.phase)) {
    throw new TaskTransportRuntimeError("TASK_TERMINAL", "Long-horizon collaboration is already terminal.");
  }
  return record;
}

function peerLongHorizonStatus(session: LongHorizonTaskState): TetiTaskLongHorizonStatus {
  const phase = session.phase === "pending_approval" ? "failed" : session.phase;
  const finalArtifactId = session.artifacts.find((artifact) => artifact.role === "final")?.artifactId;
  return {
    schemaVersion: 1,
    phase,
    currentStageIndex: session.currentStageIndex,
    workspaceRevision: session.workspaceRevision,
    completedUnits: session.progress.completedUnits,
    totalUnits: session.progress.totalUnits,
    progressMessage: session.progress.message,
    continuationExpiresAt: session.continuationExpiresAt,
    ...(session.inputRequest ? { inputRequestId: session.inputRequest.requestId } : {}),
    ...(finalArtifactId ? { finalArtifactId } : {})
  };
}
