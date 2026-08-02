import { join } from "node:path";
import { normalizeTetiPublicIdCode } from "../../../core/identity/public-id.ts";
import type { TetiAccountStorage } from "../../../core/account/storage.ts";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { TetiApplicationManager } from "../../../core/application/manager.ts";
import {
  acceptConnection,
  handleAccept,
  handleIncomingRequest,
  handleReject,
  reconcileConfirmedPeerConnections,
  rejectConnection
} from "../../../core/connection/handshake.ts";
import { TetiConnectionManager } from "../../../core/connection/manager.ts";
import { parseConnectionEnvelope, TetiConnectionProtocolError } from "../../../core/connection/protocol.ts";
import type { TetiConnectionStorage } from "../../../core/connection/storage.ts";
import { FileTetiConnectionStorage } from "../../../core/connection/storage.ts";
import {
  TetiConnectionState,
  type TetiConnectionAccept,
  type TetiConnectionRecord,
  type TetiConnectionReject,
  type TetiConnectionRequest
} from "../../../core/connection/types.ts";
import {
  inspectApplicationEnvelopeHeader,
  parseApplicationEnvelope
} from "../../../core/protocol/envelope.ts";
import {
  TETI_COLLABORATION_PROTOCOL_EPOCH,
  type TetiPresencePayload
} from "../../../core/protocol/types.ts";
import type { TetiApplicationEnvelope } from "../../../core/protocol/types.ts";
import {
  MAX_TASK_IMAGE_BYTES,
  type CollaborationTaskRequest
} from "../../../core/task/types.ts";
import {
  TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS,
  type CollaborationTaskTransportRecord,
  type CollaborationTaskTransportSnapshot,
  type CollaborationTaskSummarySnapshot,
  type SendCollaborationTaskInput,
  type TetiTaskArtifactPayload,
  type TetiTaskAttachmentPayload,
  type TetiTaskAttachmentReceiptPayload,
  type TetiTaskCancelPayload,
  type TetiTaskInputPayload,
  type TetiTaskReceiptPayload,
  type TetiTaskStatusPayload
} from "../../../core/task/transport.ts";
import type {
  AiStatusSyncPayload,
  ComputePassportAiStatusSyncPayload,
  AiToolStatusSnapshot,
  RemoteAiStatusSnapshot
} from "../../../core/ai-status/types.ts";
import {
  selectAiStatusSchemaForPeer,
  TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS
} from "../../../core/ai-status/negotiation.ts";
import type { CallableAgent } from "../../../core/callability/types.ts";
import type { AgentComputeOffer } from "../../../core/callability/agent-core.ts";
import { projectCallablePassport } from "../../../core/passport/callable-projection.ts";
import type { PassportSharingPolicy } from "../../../core/passport/types.ts";
import { TetiApplicationProtocolError } from "../../../core/protocol/validator.ts";
import { ChatmailConnectionMessagingAdapter } from "../../../integrations/chatmail/connection-messaging.ts";
import { createRuntimeChatmailRpcClient, type RuntimeChatmailRpcClient } from "../../../integrations/chatmail/create-runtime-client.ts";
import { RealChatmailAdapter } from "../../../integrations/chatmail/real-adapter.ts";
import type {
  ChatmailAdapter,
  ChatmailReceivedMessage
} from "../../../integrations/chatmail/types.ts";
import { RegistryDiscoveryClient } from "../../../services/discovery/registry-client.ts";
import { toTetiIdentity, type TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { TetiIdentity } from "../../../services/discovery/types.ts";
import type {
  PeerConnectionDto,
  PeerConnectionRequestOutcome,
  PeerConnectionResult,
  PublicTetiIdentity
} from "../src/lifecycle-bridge/protocol.ts";
import { resolveTetiProfile } from "./profile.ts";
import {
  FilePassportSharingStore,
  hasPassportSharingFields,
  MemoryPassportSharingStore,
  type PassportSharingStore
} from "./runtime/passport/sharing.ts";
import {
  FilePeerProtocolCapabilityStore,
  MemoryPeerProtocolCapabilityStore,
  type PeerProtocolCapabilityStore
} from "./runtime/passport/peer-capabilities.ts";
import { getDefaultCodexUsageService } from "./codex-usage/runtime.ts";
import { createShareableCodexStatus } from "../src/codex-usage/presentation.ts";
import {
  FileTaskTransportStore,
  MemoryTaskTransportStore,
  type TaskTransportStore
} from "./runtime/tasks/store.ts";
import { TaskTransportRuntime, TaskTransportRuntimeError } from "./runtime/tasks/service.ts";
import type { TaskExecutionBridge } from "./runtime/tasks/service.ts";
import {
  FileTaskAttachmentStore,
  type StagedTaskImage
} from "./runtime/tasks/attachments.ts";
import type { CollaborationWorkspaceStore } from "./runtime/workspaces/store.ts";
import type { ExecutionHandle } from "../../../core/callability/execution.ts";
import type {
  DelegationTargetOption,
  DelegationTargetSelection
} from "../../../core/delegation/types.ts";

const HEARTBEAT_INTERVAL_MS = 5_000;
const AI_STATUS_SYNC_INTERVAL_MS = 10 * 60 * 1_000;
const AI_STATUS_TTL_MS = 30 * 60 * 1_000;
const PEER_PROFILE_CACHE_TTL_MS = 15 * 60 * 1_000;
const TETI_TASK_ATTACHMENT_FILENAME_PATTERN = /^(?:teti-task-)?[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:png|jpe?g)$/i;

export interface PeerConnectionService {
  resolve(query: string): Promise<PublicTetiIdentity>;
  request(query: string): Promise<PeerConnectionResult>;
  list(): Promise<PeerConnectionResult>;
  poll(): Promise<PeerConnectionResult>;
  refreshPeerProfiles?(): Promise<PeerProfileRefreshResult>;
  accept(requestId: string): Promise<PeerConnectionResult>;
  reject(requestId: string): Promise<PeerConnectionResult>;
  getPassportSharing(): Promise<PassportSharingPolicy>;
  setPassportSharing(policy: PassportSharingPolicy): Promise<PassportSharingPolicy>;
  sendTask?(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord>;
  listTasks?(): Promise<CollaborationTaskTransportSnapshot>;
  listTaskSummaries?(): Promise<CollaborationTaskSummarySnapshot>;
  getTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  stageTaskImage?(sourcePath: string): Promise<StagedTaskImage>;
  resolveTaskImage?(taskId: string, attachmentId: string): Promise<string>;
  approveTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  listTaskDelegationTargets?(taskId: string): Promise<DelegationTargetOption[]>;
  approveTaskDelegation?(
    taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord>;
  rejectTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  cancelTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  getTaskExecution?(taskId: string): Promise<ExecutionHandle | null>;
  resumeTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  submitTaskInput?(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord>;
  pauseTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  continueTask?(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord>;
  completeTask?(taskId: string): Promise<CollaborationTaskTransportRecord>;
  renewTask?(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord>;
}

export interface PeerProfileRefreshResult {
  snapshot: PeerConnectionResult;
  failedPeerCount: number;
}

interface PeerConnectionRuntimeOptions {
  accountStorage: TetiAccountStorage;
  connectionStorage: TetiConnectionStorage;
  chatmailAdapter: ChatmailAdapter;
  registry: TetiRegistryReader;
  startIo?: (accountId: number) => Promise<void>;
  now?: () => Date;
  passportSharing?: PassportSharingStore;
  getLocalAiTools?: () => AiToolStatusSnapshot[];
  getLocalCallableAgents?: () => CallableAgent[];
  getLocalComputeOffers?: () => AgentComputeOffer[];
  peerProtocolCapabilities?: PeerProtocolCapabilityStore;
  taskTransportStore?: TaskTransportStore;
  taskIdFactory?: () => string;
  taskAttachmentStore?: FileTaskAttachmentStore;
  workspaceStore?: CollaborationWorkspaceStore;
  taskExecutor?: TaskExecutionBridge;
}

export class PeerConnectionRuntime implements PeerConnectionService {
  private readonly accountStorage: TetiAccountStorage;
  private readonly connectionStorage: TetiConnectionStorage;
  private readonly chatmailAdapter: ChatmailAdapter;
  private readonly registry: TetiRegistryReader;
  private readonly connectionManager: TetiConnectionManager;
  private readonly applicationManager: TetiApplicationManager;
  private readonly messagingAdapter: ChatmailConnectionMessagingAdapter;
  private readonly taskTransport: TaskTransportRuntime;
  private readonly startIo?: (accountId: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly passportSharing: PassportSharingStore;
  private readonly getLocalAiTools: () => AiToolStatusSnapshot[];
  private readonly getLocalCallableAgents: () => CallableAgent[];
  private readonly getLocalComputeOffers: () => AgentComputeOffer[];
  private readonly peerProtocolCapabilities: PeerProtocolCapabilityStore;
  private readonly heartbeatSent = new Map<string, string>();
  private readonly heartbeatReceived = new Map<string, string>();
  private readonly aiStatusSent = new Map<string, { at: string; signature: string }>();
  private readonly remoteAiStatus = new Map<string, RemoteAiStatusSnapshot>();
  private readonly identityCache = new Map<string, TetiIdentity>();
  private readonly identityRefreshedAt = new Map<string, number>();
  private readonly messageProcessingFailures = new Map<number, number>();
  private ready = false;
  private queue: Promise<void> = Promise.resolve();
  private profileQueue: Promise<void> = Promise.resolve();
  private settingsQueue: Promise<void> = Promise.resolve();
  private pendingAiStatusBroadcast: PassportSharingPolicy | null = null;
  private aiStatusBroadcastQueued = false;

  constructor(options: PeerConnectionRuntimeOptions) {
    this.accountStorage = options.accountStorage;
    this.connectionStorage = options.connectionStorage;
    this.chatmailAdapter = options.chatmailAdapter;
    this.registry = options.registry;
    this.startIo = options.startIo;
    this.now = options.now ?? (() => new Date());
    this.passportSharing = options.passportSharing ?? new MemoryPassportSharingStore();
    this.getLocalAiTools = options.getLocalAiTools ?? (() => []);
    this.getLocalCallableAgents = options.getLocalCallableAgents ?? (() => []);
    this.getLocalComputeOffers = options.getLocalComputeOffers ?? (() => []);
    this.peerProtocolCapabilities = options.peerProtocolCapabilities
      ?? new MemoryPeerProtocolCapabilityStore();
    this.messagingAdapter = new ChatmailConnectionMessagingAdapter(this.chatmailAdapter);
    this.connectionManager = new TetiConnectionManager({
      accountStorage: this.accountStorage,
      connectionStorage: this.connectionStorage,
      messagingAdapter: this.messagingAdapter
    });
    this.applicationManager = new TetiApplicationManager({
      accountStorage: this.accountStorage,
      connectionStorage: this.connectionStorage,
      chatmailAdapter: this.chatmailAdapter,
      now: () => this.now().toISOString()
    });
    this.taskTransport = new TaskTransportRuntime({
      accountStorage: this.accountStorage,
      connectionStorage: this.connectionStorage,
      applicationManager: this.applicationManager,
      store: options.taskTransportStore ?? new MemoryTaskTransportStore(),
      now: this.now,
      taskIdFactory: options.taskIdFactory,
      attachmentStore: options.taskAttachmentStore,
      workspaceStore: options.workspaceStore,
      executor: options.taskExecutor,
      enqueueOperation: (operation) => this.serial(operation)
    });
  }

  resolve(query: string): Promise<PublicTetiIdentity> {
    return this.serial(async () => toPublicIdentity(await this.resolveRemote(query)));
  }

  request(query: string): Promise<PeerConnectionResult> {
    return this.serial(async () => {
      await this.ensureReady();
      const local = await this.requireAccount();
      const remote = await this.resolveRemote(query);
      if (remote.id === local.id || remote.address.toLowerCase() === local.address.toLowerCase()) {
        throw new Error("Teti cannot connect to its own identity.");
      }

      const connections = await reconcileConfirmedPeerConnections(this.connectionStorage);
      const existing = selectActivePeerConnection(connections, remote.id);
      if (existing?.state === TetiConnectionState.PendingApproval) {
        const confirmed = await acceptConnection(existing.requestId, this.handshakeOptions());
        await this.sendDueHeartbeats();
        await this.sendDueAiStatus(true);
        return this.snapshot(0, 0, {
          kind: "mutualConfirmed",
          requestId: confirmed.requestId,
          remoteTetiId: confirmed.remoteTetiId
        });
      }
      const connection = existing ?? await this.connectionManager.createRequest(remote);
      return this.snapshot(0, 0, {
        kind: existing ? requestOutcomeKind(existing.state) : "created",
        requestId: connection.requestId,
        remoteTetiId: connection.remoteTetiId
      });
    });
  }

  list(): Promise<PeerConnectionResult> {
    return this.serial(async () => {
      await this.removeLocalIdentityConnections();
      return this.snapshot();
    });
  }

  refreshPeerProfiles(): Promise<PeerProfileRefreshResult> {
    return this.serialProfiles(async () => {
      const nowMs = this.now().getTime();
      const connections = canonicalPeerConnections(await this.connectionStorage.loadAll());
      const peers = new Map<string, TetiConnectionRecord>();
      for (const connection of connections) peers.set(connection.remoteTetiId, connection);
      const failures: unknown[] = [];
      for (const connection of peers.values()) {
        const refreshedAt = this.identityRefreshedAt.get(connection.remoteTetiId) ?? 0;
        if (this.identityCache.has(connection.remoteTetiId)
          && nowMs - refreshedAt < PEER_PROFILE_CACHE_TTL_MS) continue;
        try {
          const discovered = await this.registry.getIdentity(connection.remoteTetiId);
          if (!discovered) {
            throw new Error("The peer Registry profile is not available yet.");
          }
          const identity = toTetiIdentity(discovered);
          if (identity.address.toLowerCase() !== connection.remoteAddress.toLowerCase()) {
            throw new Error("The peer Registry profile does not match the confirmed address.");
          }
          this.identityCache.set(identity.id, identity);
          this.identityRefreshedAt.set(identity.id, nowMs);
        } catch (error) {
          failures.push(error);
        }
      }
      return {
        snapshot: await this.snapshotConnections(connections),
        failedPeerCount: failures.length
      };
    });
  }

  poll(): Promise<PeerConnectionResult> {
    return this.serial(async () => {
      await this.ensureReady();
      const account = await this.requireAccount();
      // Presence is control-plane traffic. Send it before receiving a backlog
      // or flushing Task attachments so bulk collaboration work cannot make a
      // healthy peer appear offline.
      let heartbeatCount = await this.sendDueHeartbeats();
      const messages = await this.chatmailAdapter.receiveMessages({
        accountId: account.chatmailAccountId,
        limit: 100,
        backlogFirst: true
      });
      const confirmedPeerAddresses = new Set(
        (await this.connectionStorage.loadAll())
          .filter((connection) => connection.state === TetiConnectionState.Confirmed)
          .map((connection) => connection.remoteAddress.toLowerCase())
      );
      let receivedCount = 0;

      for (const receivedMessage of messages) {
        let message = receivedMessage;
        let processed = false;
        try {
          message = await this.preparePartialTaskAttachment(
            account.chatmailAccountId,
            message,
            confirmedPeerAddresses
          );
          if (!message.text) {
            processed = true;
          } else if (await this.processConnectionMessage(message.text, message.receivedAt, message.fromAddress)) {
            receivedCount += 1;
            processed = true;
          } else if (await this.processApplicationMessage(message)) {
            receivedCount += 1;
            processed = true;
          } else {
            processed = true;
          }
        } catch (error) {
          if (isPendingTaskMessageError(error)) {
            // Waiting for a Task dependency or an asynchronous DeltaChat
            // attachment download is not a processing failure. Keep the
            // message fresh until it can be persisted or its envelope expires.
            this.messageProcessingFailures.delete(message.messageId);
            continue;
          }
          const failures = (this.messageProcessingFailures.get(message.messageId) ?? 0) + 1;
          this.messageProcessingFailures.set(message.messageId, failures);
          // A dependent Task envelope is deliberately left fresh until the
          // corresponding immutable Task record arrives. Other malformed or
          // persistently failing messages are isolated after bounded retries.
          processed = failures >= 5;
        }
        if (processed) {
          try {
            await this.chatmailAdapter.acknowledgeReceivedMessage?.(
              account.chatmailAccountId,
              message.messageId
            );
            this.messageProcessingFailures.delete(message.messageId);
          } catch {
            // DeltaChat keeps the message fresh; idempotent protocol handlers
            // make it safe to retry if acknowledgement itself fails.
          }
        }
      }

      // A connection may have become Confirmed while processing this batch.
      // Give that peer its first presence message before Task outbox traffic.
      heartbeatCount += await this.sendDueHeartbeats();
      await this.taskTransport.flushOutbox();
      const aiStatusCount = await this.sendDueAiStatus();
      return this.snapshot(receivedCount, heartbeatCount, undefined, aiStatusCount);
    });
  }

  private async preparePartialTaskAttachment(
    accountId: number,
    message: ChatmailReceivedMessage,
    confirmedPeerAddresses: ReadonlySet<string>
  ): Promise<ChatmailReceivedMessage> {
    if (message.filePath || !isPartialAttachmentState(message.downloadState)) {
      return message;
    }
    if (!isCandidateTaskAttachment(message, confirmedPeerAddresses)) {
      return message;
    }
    if (message.downloadState === "InProgress") {
      throw new TaskTransportRuntimeError(
        "TASK_ATTACHMENT_PENDING",
        "Task attachment download is still pending."
      );
    }
    if (!this.chatmailAdapter.downloadMessageAttachment) {
      throw new Error("Chatmail attachment download is unavailable.");
    }
    const refreshed = await this.chatmailAdapter.downloadMessageAttachment(
      accountId,
      message.messageId
    );
    if (!refreshed.filePath) {
      throw new TaskTransportRuntimeError(
        "TASK_ATTACHMENT_PENDING",
        "Task attachment download is still pending."
      );
    }
    return refreshed;
  }

  accept(requestId: string): Promise<PeerConnectionResult> {
    return this.serial(async () => {
      await this.ensureReady();
      await acceptConnection(requireRequestId(requestId), this.handshakeOptions());
      await this.sendDueHeartbeats();
      await this.sendDueAiStatus(true);
      return this.snapshot();
    });
  }

  reject(requestId: string): Promise<PeerConnectionResult> {
    return this.serial(async () => {
      await this.ensureReady();
      await rejectConnection(requireRequestId(requestId), this.handshakeOptions(), "declined");
      return this.snapshot();
    });
  }

  getPassportSharing(): Promise<PassportSharingPolicy> {
    return this.passportSharing.load();
  }

  setPassportSharing(policy: PassportSharingPolicy): Promise<PassportSharingPolicy> {
    return this.serialSettings(async () => {
      await this.passportSharing.save(policy);
      this.scheduleAiStatusBroadcast(policy);
      return { ...policy };
    });
  }

  sendTask(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    return this.serial(async () => {
      await this.ensureReady();
      const connection = (await this.connectionStorage.loadAll()).find(
        (item) => item.requestId === input.connectionRequestId
      );
      const compatibility = connection
        ? await this.peerProtocolCapabilities.get(connection.remoteTetiId).catch(() => undefined)
        : undefined;
      const knownIncompatible = Boolean(compatibility && (
        compatibility.collaborationProtocolEpoch !== TETI_COLLABORATION_PROTOCOL_EPOCH
        || (compatibility.taskProtocolVersions
          && !supportsCurrentTaskProtocol(compatibility.taskProtocolVersions))
      ));
      if (compatibility?.collaborationProtocolEpoch !== TETI_COLLABORATION_PROTOCOL_EPOCH
        || !supportsCurrentTaskProtocol(compatibility.taskProtocolVersions)) {
        throw new TaskTransportRuntimeError(
          knownIncompatible
            ? "TASK_PEER_UPGRADE_REQUIRED"
            : "TASK_PEER_COMPATIBILITY_UNKNOWN",
          knownIncompatible
            ? "The confirmed Teti must upgrade to Beta 0.2 before receiving tasks."
            : "Wait until the confirmed Teti proves Beta 0.2 compatibility."
        );
      }
      return this.taskTransport.send(input);
    });
  }

  listTasks(): Promise<CollaborationTaskTransportSnapshot> {
    return this.serial(() => this.taskTransport.list());
  }

  listTaskSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    return this.serial(() => this.taskTransport.listSummaries());
  }

  getTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.get(taskId));
  }

  stageTaskImage(sourcePath: string): Promise<StagedTaskImage> {
    return this.serial(() => this.taskTransport.stageImage(sourcePath));
  }

  resolveTaskImage(taskId: string, attachmentId: string): Promise<string> {
    return this.serial(() => this.taskTransport.resolveTaskImage(taskId, attachmentId));
  }

  approveTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.approve(taskId));
  }

  listTaskDelegationTargets(taskId: string): Promise<DelegationTargetOption[]> {
    return this.serial(() => this.taskTransport.listDelegationTargets(taskId));
  }

  approveTaskDelegation(
    taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.approveDelegation(taskId, selections));
  }

  rejectTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.reject(taskId));
  }

  cancelTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.cancel(taskId));
  }

  getTaskExecution(taskId: string): Promise<ExecutionHandle | null> {
    return this.serial(() => this.taskTransport.getExecutionHandle(taskId));
  }

  resumeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.resume(taskId));
  }

  submitTaskInput(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.submitLongHorizonInput(taskId, instruction));
  }

  pauseTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.pauseLongHorizon(taskId));
  }

  continueTask(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.continueLongHorizon(taskId, childAgentId));
  }

  completeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.completeLongHorizon(taskId));
  }

  renewTask(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord> {
    return this.serial(() => this.taskTransport.renewLongHorizon(taskId, ttlMs));
  }

  private scheduleAiStatusBroadcast(policy: PassportSharingPolicy): void {
    this.pendingAiStatusBroadcast = structuredClone(policy);
    if (this.aiStatusBroadcastQueued) return;
    this.aiStatusBroadcastQueued = true;
    queueMicrotask(() => {
      void this.serial(async () => {
        const latest = this.pendingAiStatusBroadcast;
        this.pendingAiStatusBroadcast = null;
        if (!latest) return;
        await this.broadcastAiStatus(latest);
        if (!hasPassportSharingFields(latest)) this.aiStatusSent.clear();
      }).catch(() => undefined).finally(() => {
        this.aiStatusBroadcastQueued = false;
        const latest = this.pendingAiStatusBroadcast;
        if (latest) this.scheduleAiStatusBroadcast(latest);
      });
    });
  }

  private async resolveRemote(query: string): Promise<TetiIdentity> {
    const identity = await resolveIdentityQuery(query, this.registry);
    this.identityCache.set(identity.id, identity);
    this.identityRefreshedAt.set(identity.id, this.now().getTime());
    return identity;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    const account = await this.requireAccount();
    await this.startIo?.(account.chatmailAccountId);
    await this.removeLocalIdentityConnections();
    this.ready = true;
  }

  private async requireAccount() {
    const account = await this.accountStorage.load();
    if (!account) throw new Error("A local Teti account is required before creating connections.");
    return account;
  }

  private async processConnectionMessage(
    text: string,
    receivedAt?: string,
    fromAddress?: string
  ): Promise<boolean> {
    let envelope;
    try {
      envelope = parseConnectionEnvelope(text);
    } catch (error) {
      if (error instanceof TetiConnectionProtocolError) return false;
      throw error;
    }

    const options = this.handshakeOptions(receivedAt);
    if (envelope.type === "teti.connection.request") {
      const request = envelope.payload as TetiConnectionRequest;
      requireMatchingSender(fromAddress, request.fromAddress);
      const local = await this.requireAccount();
      if (isSameIdentity(request.fromTetiId, request.fromAddress, local.id, local.address)) {
        return true;
      }
      await handleIncomingRequest(request, options);
    } else if (envelope.type === "teti.connection.accept") {
      const accept = envelope.payload as TetiConnectionAccept;
      requireMatchingSender(fromAddress, accept.fromAddress);
      const existing = await findConnection(this.connectionStorage, accept.requestId);
      if (existing?.state !== TetiConnectionState.Confirmed) {
        await handleAccept(accept, options);
      }
    } else if (envelope.type === "teti.connection.reject") {
      const reject = envelope.payload as TetiConnectionReject;
      const existing = await findConnection(this.connectionStorage, reject.requestId);
      requireMatchingSender(fromAddress, existing?.remoteAddress);
      if (existing?.state !== TetiConnectionState.Rejected) {
        await handleReject(reject, options);
      }
    }
    return true;
  }

  private async processApplicationMessage(message: ChatmailReceivedMessage): Promise<boolean> {
    const text = message.text ?? "";
    const fromAddress = message.fromAddress;
    const receivedAt = message.receivedAt;
    const chatmailMessageId = message.messageId;
    let envelope;
    try {
      envelope = parseApplicationEnvelope(text);
    } catch (error) {
      if (error instanceof TetiApplicationProtocolError) {
        return this.observeIncompatibleApplicationEnvelope(text, fromAddress, receivedAt);
      }
      throw error;
    }
    const connection = (await this.connectionStorage.loadAll()).find(
      (item) =>
        item.state === TetiConnectionState.Confirmed &&
        item.remoteTetiId === envelope.fromTetiId &&
        (!fromAddress || item.remoteAddress.toLowerCase() === fromAddress.toLowerCase())
    );
    if (!connection) return false;

    if (envelope.type === "teti.presence") {
      const payload = envelope.payload as TetiPresencePayload;
      // Reachability is based on the relay's receive timestamp, not the peer's
      // wall clock. Delayed or skewed peer clocks must not create false online
      // cards, and an older queued heartbeat must not replace a newer one.
      const observedAt = validReceivedHeartbeatTimestamp(receivedAt, this.now());
      const previous = this.heartbeatReceived.get(connection.requestId);
      if (!previous || Date.parse(observedAt) > Date.parse(previous)) {
        this.heartbeatReceived.set(connection.requestId, observedAt);
      }
      if (payload.taskProtocolVersions) {
        await this.taskTransport.observePeerVersions(
          connection.remoteTetiId,
          payload.taskProtocolVersions,
          payload.timestamp || envelope.createdAt
        );
      }
      if (payload.passportSchemaVersions) {
        const changed = await this.peerProtocolCapabilities.observe({
          tetiId: connection.remoteTetiId,
          collaborationProtocolEpoch: payload.collaborationProtocolEpoch,
          taskProtocolVersions: payload.taskProtocolVersions,
          passportSchemaVersions: payload.passportSchemaVersions,
          observedAt
        });
        if (changed) this.aiStatusSent.delete(connection.requestId);
      }
      return true;
    }

    if (envelope.type === "teti.ai.status.sync") {
      if (!fromAddress || connection.remoteAddress.toLowerCase() !== fromAddress.toLowerCase()) return false;
      const payload = envelope.payload as AiStatusSyncPayload;
      const existing = this.remoteAiStatus.get(connection.requestId);
      if (!existing || shouldReplaceRemoteAiStatus(existing, payload)) {
        this.remoteAiStatus.set(connection.requestId, {
          ...structuredClone(payload),
          receivedAt: receivedAt ?? this.now().toISOString()
        });
      }
      return true;
    }

    if (!fromAddress || connection.remoteAddress.toLowerCase() !== fromAddress.toLowerCase()) {
      return false;
    }

    if (envelope.type === "teti.task.request") {
      const typedEnvelope = envelope as TetiApplicationEnvelope<CollaborationTaskRequest>;
      const receipt = await this.taskTransport.receiveRequest({
        envelope: typedEnvelope,
        connection,
        chatmailMessageId,
        receivedAt
      });
      try {
        await this.applicationManager.sendTaskReceipt(connection.requestId, receipt);
        await this.taskTransport.markReceiptSent(receipt.taskId, receipt.requesterTetiId);
      } catch {
        // Receipt stays in the durable outbox and is retried by Runtime polling.
      }
      return true;
    }

    if (envelope.type === "teti.task.attachment") {
      const typedEnvelope = envelope as TetiApplicationEnvelope<TetiTaskAttachmentPayload>;
      let attachmentMessage = message;
      if (!attachmentMessage.filePath
        && (attachmentMessage.downloadState === "Available" || attachmentMessage.downloadState === "Failure")) {
        const account = await this.requireAccount();
        if (!this.chatmailAdapter.downloadMessageAttachment) {
          throw new Error("Chatmail attachment download is unavailable.");
        }
        attachmentMessage = await this.chatmailAdapter.downloadMessageAttachment(
          account.chatmailAccountId,
          message.messageId
        );
      }
      if (!attachmentMessage.filePath) {
        if (Date.parse(typedEnvelope.payload.expiresAt) <= this.now().getTime()) {
          return true;
        }
        if (attachmentMessage.downloadState === "Available"
          || attachmentMessage.downloadState === "Failure"
          || attachmentMessage.downloadState === "InProgress"
          || attachmentMessage.downloadState === "Done") {
          throw new TaskTransportRuntimeError(
            "TASK_ATTACHMENT_PENDING",
            "Task attachment download is still pending."
          );
        }
        throw new Error("Chatmail Task attachment has no local file.");
      }
      const receipt = await this.taskTransport.receiveAttachment({
        envelope: typedEnvelope,
        connection,
        filePath: attachmentMessage.filePath,
        receivedAt
      });
      if (receipt) {
        // The Chatmail message is acknowledged only after the durable Task
        // copy and its v4 peer receipt have both succeeded. A retry is safe:
        // attachment ingestion and receipts are idempotent by attachmentId.
        await this.applicationManager.sendTaskAttachmentReceipt(connection.requestId, receipt);
      }
      return true;
    }

    if (envelope.type === "teti.task.attachment.receipt") {
      await this.taskTransport.receiveAttachmentReceipt({
        envelope: envelope as TetiApplicationEnvelope<TetiTaskAttachmentReceiptPayload>,
        connection,
        receivedAt
      });
      return true;
    }

    if (envelope.type === "teti.task.status") {
      await this.taskTransport.receiveStatus({
        envelope: envelope as TetiApplicationEnvelope<TetiTaskStatusPayload>,
        connection,
        receivedAt
      });
      return true;
    }

    if (envelope.type === "teti.task.input") {
      await this.taskTransport.receiveLongHorizonInput({
        envelope: envelope as TetiApplicationEnvelope<TetiTaskInputPayload>,
        connection,
        receivedAt
      });
      return true;
    }

    if (envelope.type === "teti.task.cancel") {
      await this.taskTransport.receiveCancel({
        envelope: envelope as TetiApplicationEnvelope<TetiTaskCancelPayload>,
        connection,
        receivedAt
      });
      return true;
    }

    if (envelope.type === "teti.task.artifact") {
      await this.taskTransport.receiveArtifact({
        envelope: envelope as TetiApplicationEnvelope<TetiTaskArtifactPayload>,
        connection,
        receivedAt
      });
      return true;
    }

    if (envelope.type !== "teti.task.receipt") return true;

    await this.taskTransport.receiveReceipt({
      envelope: envelope as TetiApplicationEnvelope<TetiTaskReceiptPayload>,
      connection,
      receivedAt
    });
    return true;
  }

  private async observeIncompatibleApplicationEnvelope(
    text: string,
    fromAddress?: string,
    receivedAt?: string
  ): Promise<boolean> {
    const header = inspectApplicationEnvelopeHeader(text);
    if (!header || header.version >= TETI_COLLABORATION_PROTOCOL_EPOCH) return false;
    const connection = (await this.connectionStorage.loadAll()).find((item) =>
      item.state === TetiConnectionState.Confirmed
      && item.remoteTetiId === header.fromTetiId
      && (!fromAddress || item.remoteAddress.toLowerCase() === fromAddress.toLowerCase())
    );
    if (!connection) return false;
    const observedAt = validReceivedHeartbeatTimestamp(receivedAt, this.now());
    const previous = this.heartbeatReceived.get(connection.requestId);
    if (!previous || Date.parse(observedAt) > Date.parse(previous)) {
      this.heartbeatReceived.set(connection.requestId, observedAt);
    }
    await this.peerProtocolCapabilities.observe({
      tetiId: connection.remoteTetiId,
      collaborationProtocolEpoch: header.version,
      observedAt
    });
    return true;
  }

  private async sendDueHeartbeats(): Promise<number> {
    let sent = 0;
    const now = this.now();
    for (const connection of await this.connectionStorage.loadAll()) {
      if (connection.state !== TetiConnectionState.Confirmed) continue;
      const previous = this.heartbeatSent.get(connection.requestId);
      if (previous && now.getTime() - Date.parse(previous) < HEARTBEAT_INTERVAL_MS) continue;
      const timestamp = now.toISOString();
      try {
        await this.applicationManager.sendPresence(connection.requestId, {
          status: "alpha-heartbeat",
          timestamp,
          collaborationProtocolEpoch: TETI_COLLABORATION_PROTOCOL_EPOCH,
          taskProtocolVersions: [...TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS],
          passportSchemaVersions: [...TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS]
        });
        this.heartbeatSent.set(connection.requestId, timestamp);
        sent += 1;
      } catch {
        // One unavailable peer must not delay heartbeats for the remaining
        // confirmed connections. The next Runtime poll retries this peer.
      }
    }
    return sent;
  }

  private async sendDueAiStatus(force = false): Promise<number> {
    const policy = await this.passportSharing.load().catch(() => null);
    if (!policy || !hasPassportSharingFields(policy)) return 0;
    return this.broadcastAiStatus(policy, force);
  }

  private async broadcastAiStatus(
    policy: PassportSharingPolicy,
    force = true
  ): Promise<number> {
    const now = this.now();
    const sharing = hasPassportSharingFields(policy) ? "enabled" : "disabled";
    const tools = policy.resourceSummary
      ? this.getLocalAiTools().map((tool) => ({
          ...structuredClone(tool),
          quotas: policy.resourceQuota ? structuredClone(tool.quotas) : []
        }))
      : [];
    const callable = projectCallablePassport(
      policy.agents ? this.getLocalCallableAgents() : [],
      policy.agents && policy.capabilities ? this.getLocalComputeOffers() : []
    );
    const agents = policy.agents ? callable.agents : [];
    const capabilities = policy.capabilities ? callable.capabilities : [];
    const bindings = policy.capabilities
      ? callable.bindings.filter((binding) =>
          binding.agentIds.every((agentId) => agents.some((agent) => agent.id === agentId))
        )
      : [];
    const computeOffers = policy.capabilities && policy.agents
      ? callable.computeOffers.filter((offer) =>
          capabilities.some((capability) => capability.id === offer.capability)
        )
      : [];
    const snapshotSignature = JSON.stringify({ sharing, tools, agents, capabilities, bindings, computeOffers });
    let sent = 0;
    for (const connection of await this.connectionStorage.loadAll()) {
      if (connection.state !== TetiConnectionState.Confirmed) continue;
      const peerCapability = await this.peerProtocolCapabilities
        .get(connection.remoteTetiId)
        .catch(() => undefined);
      const schemaVersion = selectAiStatusSchemaForPeer(
        peerCapability?.passportSchemaVersions
      );
      if (peerCapability?.collaborationProtocolEpoch !== TETI_COLLABORATION_PROTOCOL_EPOCH
        || !supportsCurrentTaskProtocol(peerCapability.taskProtocolVersions)
        || !schemaVersion) continue;
      const signature = JSON.stringify({ schemaVersion, snapshot: snapshotSignature });
      const previous = this.aiStatusSent.get(connection.requestId);
      if (!force
        && previous
        && previous.signature === signature
        && now.getTime() - Date.parse(previous.at) < AI_STATUS_SYNC_INTERVAL_MS) {
        continue;
      }
      const callablePassportPayload: ComputePassportAiStatusSyncPayload = {
        schemaVersion,
        sharing,
        generatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + AI_STATUS_TTL_MS).toISOString(),
        tools: structuredClone(tools),
        agents: structuredClone(agents),
        capabilities: structuredClone(capabilities),
        bindings: structuredClone(bindings),
        computeOffers: structuredClone(computeOffers)
      };
      try {
        await this.applicationManager.sendAiStatusSync(
          connection.requestId,
          callablePassportPayload
        );
        this.aiStatusSent.set(connection.requestId, {
          at: callablePassportPayload.generatedAt,
          signature
        });
        sent += 1;
      } catch {
        // Optional status sharing must not break peer presence or polling.
      }
    }
    return sent;
  }

  private async snapshot(
    receivedCount = 0,
    heartbeatCount = 0,
    requestOutcome?: PeerConnectionRequestOutcome,
    aiStatusCount = 0
  ): Promise<PeerConnectionResult> {
    const connections = await reconcileConfirmedPeerConnections(this.connectionStorage);
    return this.snapshotConnections(
      connections,
      receivedCount,
      heartbeatCount,
      requestOutcome,
      aiStatusCount
    );
  }

  private async snapshotConnections(
    connections: readonly TetiConnectionRecord[],
    receivedCount = 0,
    heartbeatCount = 0,
    requestOutcome?: PeerConnectionRequestOutcome,
    aiStatusCount = 0
  ): Promise<PeerConnectionResult> {
    const dtos = await Promise.all(connections.map((connection) => this.toDto(connection)));
    const result: PeerConnectionResult = {
      connections: dtos.sort(comparePeerConnections),
      receivedCount,
      heartbeatCount,
      aiStatusCount
    };
    if (requestOutcome) result.requestOutcome = requestOutcome;
    return result;
  }

  private async toDto(connection: TetiConnectionRecord): Promise<PeerConnectionDto> {
    const identity = this.identityCache.get(connection.remoteTetiId);
    const protocolCapability = await this.peerProtocolCapabilities
      .get(connection.remoteTetiId)
      .catch(() => undefined);
    return {
      requestId: connection.requestId,
      state: connection.state,
      direction: connection.direction,
      remoteTetiId: connection.remoteTetiId,
      remoteAddress: connection.remoteAddress,
      remoteDisplayName: identity?.displayName,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      confirmedAt: connection.confirmedAt,
      lastHeartbeatSentAt: this.heartbeatSent.get(connection.requestId),
      lastHeartbeatReceivedAt: this.heartbeatReceived.get(connection.requestId),
      remoteProtocolCapabilities: protocolCapability
        ? {
            collaborationProtocolEpoch: protocolCapability.collaborationProtocolEpoch,
            ...(protocolCapability.taskProtocolVersions
              ? { taskProtocolVersions: structuredClone(protocolCapability.taskProtocolVersions) }
              : {}),
            ...(protocolCapability.passportSchemaVersions
              ? { passportSchemaVersions: structuredClone(protocolCapability.passportSchemaVersions) }
              : {}),
            observedAt: protocolCapability.observedAt
          }
        : undefined,
      remoteAiStatus: this.remoteAiStatus.has(connection.requestId)
        ? structuredClone(this.remoteAiStatus.get(connection.requestId))
        : undefined
    };
  }

  private handshakeOptions(timestamp?: string) {
    return {
      accountStorage: this.accountStorage,
      connectionStorage: this.connectionStorage,
      messagingAdapter: this.messagingAdapter,
      now: timestamp ? () => timestamp : () => this.now().toISOString()
    };
  }

  private async removeLocalIdentityConnections(): Promise<void> {
    const local = await this.requireAccount();
    const connections = await this.connectionStorage.loadAll();
    const retained = connections.filter((connection) =>
      !isSameIdentity(connection.remoteTetiId, connection.remoteAddress, local.id, local.address)
    );
    if (retained.length !== connections.length) {
      await this.connectionStorage.saveAll(retained);
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private serialSettings<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.settingsQueue.then(operation, operation);
    this.settingsQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private serialProfiles<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.profileQueue.then(operation, operation);
    this.profileQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function validReceivedHeartbeatTimestamp(receivedAt: string | undefined, now: Date): string {
  if (!receivedAt) return now.toISOString();
  const timestamp = Date.parse(receivedAt);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) {
    return now.toISOString();
  }
  return new Date(timestamp).toISOString();
}

function canonicalPeerConnections(
  connections: readonly TetiConnectionRecord[]
): TetiConnectionRecord[] {
  const canonicalByPeer = new Map<string, TetiConnectionRecord>();
  for (const connection of connections) {
    if (connection.state !== TetiConnectionState.Confirmed) continue;
    const canonical = canonicalByPeer.get(connection.remoteTetiId);
    if (!canonical || connection.requestId.localeCompare(canonical.requestId) < 0) {
      canonicalByPeer.set(connection.remoteTetiId, connection);
    }
  }
  return connections.filter((connection) => {
    const canonical = canonicalByPeer.get(connection.remoteTetiId);
    return !canonical || connection.requestId === canonical.requestId;
  });
}

function supportsCurrentTaskProtocol(versions: readonly number[] | undefined): boolean {
  return Boolean(versions
    && versions.length === TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS.length
    && versions.every((version, index) => version === TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS[index]));
}

let defaultServicePromise: Promise<PeerConnectionService> | undefined;
let defaultRpcClient: RuntimeChatmailRpcClient | undefined;
let defaultPassportSharingStorePromise: Promise<FilePassportSharingStore> | undefined;

export interface DefaultPeerConnectionServiceOptions {
  getLocalCallableAgents?: () => CallableAgent[];
  getLocalComputeOffers?: () => AgentComputeOffer[];
  taskExecutor?: TaskExecutionBridge;
  taskAttachmentStore?: FileTaskAttachmentStore;
  workspaceStore?: CollaborationWorkspaceStore;
}

export function getDefaultPeerConnectionService(
  options: DefaultPeerConnectionServiceOptions = {}
): Promise<PeerConnectionService> {
  defaultServicePromise ??= createDefaultPeerConnectionService(options);
  return defaultServicePromise;
}

export function getDefaultPassportSharingStore(): Promise<FilePassportSharingStore> {
  defaultPassportSharingStorePromise ??= resolveTetiProfile().then(
    (profile) => new FilePassportSharingStore(join(profile.storeDir, "settings.json"))
  );
  return defaultPassportSharingStorePromise;
}

export async function closeDefaultPeerConnectionService(): Promise<void> {
  const pendingService = defaultServicePromise;
  if (pendingService) await pendingService.catch(() => undefined);
  const client = defaultRpcClient;
  defaultServicePromise = undefined;
  defaultRpcClient = undefined;
  defaultPassportSharingStorePromise = undefined;
  await client?.close();
}

async function createDefaultPeerConnectionService(
  options: DefaultPeerConnectionServiceOptions
): Promise<PeerConnectionService> {
  const profile = await resolveTetiProfile();
  defaultRpcClient = createRuntimeChatmailRpcClient({
    runtime: { accountsPath: profile.chatmailAccountsPath },
    transport: { requestTimeoutMs: 15_000 }
  });
  const accountStorage = new FileTetiAccountStorage(profile.accountPath);
  const connectionStorage = new FileTetiConnectionStorage(join(profile.storeDir, "connections.json"));
  const chatmailAdapter = new RealChatmailAdapter(defaultRpcClient);
  return new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter,
    registry: new RegistryDiscoveryClient(),
    startIo: (accountId) => defaultRpcClient!.startIo(accountId),
    passportSharing: await getDefaultPassportSharingStore(),
    getLocalAiTools: () => [createShareableCodexStatus(getDefaultCodexUsageService().getCurrentState())],
    getLocalCallableAgents: options.getLocalCallableAgents,
    getLocalComputeOffers: options.getLocalComputeOffers,
    taskTransportStore: new FileTaskTransportStore(join(profile.storeDir, "tasks.json")),
    peerProtocolCapabilities: new FilePeerProtocolCapabilityStore(
      join(profile.storeDir, "peer-protocol-capabilities.json")
    ),
    taskAttachmentStore: options.taskAttachmentStore
      ?? new FileTaskAttachmentStore(join(profile.storeDir, "task-attachments")),
    workspaceStore: options.workspaceStore,
    taskExecutor: options.taskExecutor
  });
}

export async function resolveIdentityQuery(
  rawQuery: string,
  registry: TetiRegistryReader
): Promise<TetiIdentity> {
  const publicId = normalizePublicTetiId(rawQuery);
  const identity = await registry.getIdentity(`teti_${publicId}`);
  if (!identity) {
    throw new Error("No public Teti identity matched this ID.");
  }
  return toTetiIdentity(identity);
}

export function normalizePublicTetiId(value: string): string {
  return normalizeTetiPublicIdCode(value);
}

function toPublicIdentity(identity: TetiIdentity): PublicTetiIdentity {
  return {
    id: identity.id,
    address: identity.address,
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    publicProfile: identity.publicProfile
  };
}

function requireRequestId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new Error("A valid connection request ID is required.");
  }
  return value.trim();
}

async function findConnection(
  storage: TetiConnectionStorage,
  requestId: string
): Promise<TetiConnectionRecord | undefined> {
  return (await storage.loadAll()).find((connection) => connection.requestId === requestId);
}

function requireMatchingSender(actual: string | undefined, expected: string | undefined): void {
  if (!actual || !expected || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Chatmail sender does not match the Teti handshake identity.");
  }
}

function shouldReplaceRemoteAiStatus(
  existing: RemoteAiStatusSnapshot,
  incoming: AiStatusSyncPayload
): boolean {
  // A compatibility payload is never evidence that the Peer lost support for
  // a richer Passport. Keep the highest successfully validated schema and use
  // generatedAt only to order snapshots within that schema.
  if (incoming.schemaVersion !== existing.schemaVersion) {
    return incoming.schemaVersion > existing.schemaVersion;
  }
  return Date.parse(incoming.generatedAt) >= Date.parse(existing.generatedAt);
}

function isSameIdentity(
  leftId: string,
  leftAddress: string,
  rightId: string,
  rightAddress: string
): boolean {
  return leftId === rightId || leftAddress.toLowerCase() === rightAddress.toLowerCase();
}

function isPendingTaskMessageError(error: unknown): error is TaskTransportRuntimeError {
  return error instanceof TaskTransportRuntimeError
    && (error.code === "TASK_DEPENDENCY_PENDING" || error.code === "TASK_ATTACHMENT_PENDING");
}

function isPartialAttachmentState(
  state: ChatmailReceivedMessage["downloadState"]
): state is "Available" | "Failure" | "InProgress" {
  return state === "Available" || state === "Failure" || state === "InProgress";
}

function isCandidateTaskAttachment(
  message: ChatmailReceivedMessage,
  confirmedPeerAddresses: ReadonlySet<string>
): boolean {
  if (!message.fromAddress
    || !confirmedPeerAddresses.has(message.fromAddress.toLowerCase())) {
    return false;
  }
  if (message.fileBytes !== undefined
    && (!Number.isSafeInteger(message.fileBytes)
      || message.fileBytes <= 0
      || message.fileBytes > MAX_TASK_IMAGE_BYTES)) {
    return false;
  }
  if (message.fileName !== undefined) {
    return TETI_TASK_ATTACHMENT_FILENAME_PATTERN.test(message.fileName);
  }
  // DeltaChat can know the MIME type before the original filename becomes
  // available. At least one bounded Teti image signal is required before an
  // opaque, not-yet-decrypted caption is downloaded.
  return message.fileMime === "image/png" || message.fileMime === "image/jpeg";
}

function comparePeerConnections(left: PeerConnectionDto, right: PeerConnectionDto): number {
  const rank = (connection: PeerConnectionDto): number => {
    if (connection.state === TetiConnectionState.Confirmed) return 0;
    if (connection.state === TetiConnectionState.Rejected || connection.state === TetiConnectionState.Blocked) return 1;
    return 2;
  };
  const rankDifference = rank(left) - rank(right);
  if (rankDifference !== 0) return rankDifference;
  const leftTime = left.state === TetiConnectionState.Confirmed
    ? left.confirmedAt ?? left.updatedAt
    : left.updatedAt;
  const rightTime = right.state === TetiConnectionState.Confirmed
    ? right.confirmedAt ?? right.updatedAt
    : right.updatedAt;
  return rightTime.localeCompare(leftTime);
}

function selectActivePeerConnection(
  connections: TetiConnectionRecord[],
  remoteTetiId: string
): TetiConnectionRecord | undefined {
  const priority: Record<TetiConnectionState, number> = {
    [TetiConnectionState.Blocked]: 6,
    [TetiConnectionState.Confirmed]: 5,
    [TetiConnectionState.PendingApproval]: 4,
    [TetiConnectionState.Accepted]: 3,
    [TetiConnectionState.Requested]: 2,
    [TetiConnectionState.Rejected]: 1
  };
  return connections
    .filter((connection) =>
      connection.remoteTetiId === remoteTetiId &&
      connection.state !== TetiConnectionState.Rejected
    )
    .sort((left, right) => priority[right.state] - priority[left.state])[0];
}

function requestOutcomeKind(
  state: TetiConnectionState
): PeerConnectionRequestOutcome["kind"] {
  switch (state) {
    case TetiConnectionState.Requested:
      return "alreadyRequested";
    case TetiConnectionState.PendingApproval:
      return "approvalRequired";
    case TetiConnectionState.Accepted:
      return "confirming";
    case TetiConnectionState.Confirmed:
      return "alreadyConfirmed";
    case TetiConnectionState.Blocked:
      return "blocked";
    case TetiConnectionState.Rejected:
      return "created";
  }
}
