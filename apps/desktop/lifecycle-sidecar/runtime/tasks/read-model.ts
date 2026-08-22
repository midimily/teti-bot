import { TetiConnectionState, type TetiConnectionRecord } from "../../../../../core/connection/types.ts";
import {
  type CollaborationTaskSummary,
  type CollaborationTaskSummarySnapshot,
  type CollaborationTaskTransportRecord,
  type CollaborationTaskTransportSnapshot,
  type TetiTaskTransportStoreState
} from "../../../../../core/task/transport.ts";
import { taskInputImages, taskInputText } from "../../../../../core/task/types.ts";
import type { TaskTransportStore } from "./store.ts";

const MAX_CACHED_TASK_DETAILS = 16;

type CachedTaskSummary = Omit<CollaborationTaskSummary, "connectionRequestId">;
interface CachedTaskSummaryEntry {
  summary: CachedTaskSummary;
  verifiedSingleStageCompletion: boolean;
}

/**
 * A bounded, disposable projection of successfully persisted Task state.
 *
 * It is never consulted by Task commands for authorization or transitions.
 * Commands keep loading the durable store under PeerConnectionRuntime's write
 * queue; App-facing reads may safely return the last complete committed view.
 */
export class TaskReadModel {
  private readonly source: TaskTransportStore;
  private readonly now: () => Date;
  private summaries: CachedTaskSummaryEntry[] = [];
  private initialized = false;
  private generation = 0;
  private readonly details = new Map<string, CollaborationTaskTransportRecord>();

  constructor(options: { source: TaskTransportStore; now?: () => Date }) {
    this.source = options.source;
    this.now = options.now ?? (() => new Date());
  }

  publish(state: TetiTaskTransportStoreState): void {
    this.generation += 1;
    this.summaries = state.records
      .map((record) => ({
        summary: projectSummary(record),
        verifiedSingleStageCompletion: canRecoverVerifiedSingleStageCompletion(record)
      }))
      .sort((left, right) => compareTaskSummaryPresentation(left.summary, right.summary))
      .slice(0, 100);

    for (const taskId of [...this.details.keys()]) {
      const record = state.records.find((candidate) => candidate.request.taskId === taskId);
      if (record) this.details.set(taskId, structuredClone(record));
      else this.details.delete(taskId);
    }
    this.initialized = true;
  }

  async listSummaries(
    connections: readonly TetiConnectionRecord[]
  ): Promise<CollaborationTaskSummarySnapshot> {
    await this.ensureInitialized();
    const confirmedByPeer = new Map(connections
      .filter((connection) => connection.state === TetiConnectionState.Confirmed)
      .map((connection) => [connection.remoteTetiId, connection.requestId] as const));
    const tasks = this.summaries
      .map((entry) => projectCurrentSummary(entry, this.now()))
      .sort(compareTaskSummaryPresentation);
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      pendingIncomingCount: tasks.filter((task) =>
        task.direction === "incoming"
        && task.approval === "pending"
        && task.state === "submitted"
      ).length,
      unreadStageResultCount: 0,
      unreadTaskUpdateCount: tasks.filter((task) => task.hasUnreadTaskUpdate).length,
      tasks: tasks.map((summary) => {
        const connectionRequestId = confirmedByPeer.get(summary.peerTetiId);
        return {
          ...structuredClone(summary),
          ...(connectionRequestId ? { connectionRequestId } : {})
        };
      })
    };
  }

  async get(taskId: string): Promise<CollaborationTaskTransportRecord | null> {
    const cached = this.details.get(taskId);
    if (cached) {
      this.details.delete(taskId);
      this.details.set(taskId, cached);
      return projectCurrentRecord(cached, this.now());
    }

    const generation = this.generation;
    const state = await this.source.load();
    if (!this.initialized) this.publish(state);
    const record = state.records.find((candidate) => candidate.request.taskId === taskId);
    if (!record) return null;
    if (generation === this.generation) this.remember(record);
    return projectCurrentRecord(record, this.now());
  }

  async list(): Promise<CollaborationTaskTransportSnapshot> {
    const wasInitialized = this.initialized;
    const generation = this.generation;
    let state = await this.source.load();
    if (!this.initialized) this.publish(state);
    else if (wasInitialized && generation !== this.generation) state = await this.source.load();
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      records: state.records
        .map((record) => projectCurrentRecord(record, this.now()))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      peers: structuredClone(state.peers)
        .sort((left, right) => left.tetiId.localeCompare(right.tetiId))
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const generation = this.generation;
    const state = await this.source.load();
    if (!this.initialized && generation === this.generation) this.publish(state);
  }

  private remember(record: CollaborationTaskTransportRecord): void {
    const taskId = record.request.taskId;
    this.details.delete(taskId);
    this.details.set(taskId, structuredClone(record));
    while (this.details.size > MAX_CACHED_TASK_DETAILS) {
      const oldest = this.details.keys().next().value;
      if (typeof oldest !== "string") break;
      this.details.delete(oldest);
    }
  }
}

/** Publishes only after the durable store has committed successfully. */
export class PublishingTaskTransportStore implements TaskTransportStore {
  private readonly source: TaskTransportStore;
  private readonly readModel: TaskReadModel;

  constructor(source: TaskTransportStore, readModel: TaskReadModel) {
    this.source = source;
    this.readModel = readModel;
  }

  load(): Promise<TetiTaskTransportStoreState> {
    return this.source.load();
  }

  async save(state: TetiTaskTransportStoreState): Promise<void> {
    await this.source.save(state);
    this.readModel.publish(state);
  }
}

function projectSummary(record: CollaborationTaskTransportRecord): CachedTaskSummary {
  return {
    taskId: record.request.taskId,
    direction: record.direction,
    peerTetiId: record.peerTetiId,
    capabilityId: record.request.capabilityId,
    executionMode: record.request.executionMode ?? "single_stage",
    currentStageIndex: record.longHorizon?.currentStageIndex
      ?? record.peerLongHorizon?.currentStageIndex
      ?? null,
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
    hasUnreadTaskUpdate: (record.attentionRevision ?? 0) > (record.viewedAttentionRevision ?? 0),
    ...(record.safeErrorCode ? { safeErrorCode: record.safeErrorCode } : {})
  };
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

function effectiveTaskExpiry(record: CollaborationTaskTransportRecord): string {
  return record.longHorizon?.continuationExpiresAt
    ?? record.peerLongHorizon?.continuationExpiresAt
    ?? record.request.expiresAt;
}

function projectCurrentSummary(
  entry: CachedTaskSummaryEntry,
  now: Date
): CachedTaskSummary {
  const summary = structuredClone(entry.summary);
  if (entry.verifiedSingleStageCompletion) {
    summary.state = "completed";
    summary.approval = "approved_once";
    summary.delivery = "acknowledged";
    summary.cancelPending = false;
    delete summary.safeErrorCode;
    return summary;
  }
  if (shouldProjectExpiry(summary.state, summary.delivery, summary.expiresAt, now)) {
    summary.state = "rejected";
    summary.approval = "expired";
    summary.delivery = "expired";
    summary.safeErrorCode = "TASK_EXPIRED";
    summary.updatedAt = now.toISOString();
  }
  return summary;
}

function projectCurrentRecord(
  source: CollaborationTaskTransportRecord,
  now: Date
): CollaborationTaskTransportRecord {
  const record = structuredClone(source);
  if (canRecoverVerifiedSingleStageCompletion(record)) {
    record.state = "completed";
    record.approval = "approved_once";
    record.delivery = "acknowledged";
    record.cancelPending = false;
    delete record.cancelSentAt;
    delete record.safeErrorCode;
    return record;
  }
  if (!shouldProjectExpiry(record.state, record.delivery, effectiveTaskExpiry(record), now)) {
    return record;
  }
  const timestamp = now.toISOString();
  record.delivery = "expired";
  record.state = "rejected";
  record.approval = "expired";
  record.safeErrorCode = "TASK_EXPIRED";
  record.updatedAt = timestamp;
  if (record.longHorizon) {
    record.longHorizon.phase = "expired";
    record.longHorizon.pauseRequested = false;
    record.longHorizon.inputRequest = null;
    record.longHorizon.pendingInput = null;
    record.longHorizon.progress = {
      state: "canceled",
      completedUnits: null,
      totalUnits: null,
      message: "长期协作续期已过期",
      updatedAt: timestamp
    };
  }
  if (record.delegationPlan
    && !["completed", "failed", "canceled"].includes(record.delegationPlan.phase)) {
    record.delegationPlan.phase = "canceled";
    record.delegationPlan.updatedAt = timestamp;
  }
  for (const diagnostic of record.attachmentDiagnostics ?? []) {
    if (diagnostic.state === "acknowledged" || diagnostic.state === "stored") continue;
    diagnostic.state = "expired";
    diagnostic.safeErrorCode = "TASK_EXPIRED";
  }
  return record;
}

function canRecoverVerifiedSingleStageCompletion(
  record: CollaborationTaskTransportRecord
): boolean {
  if (record.direction !== "outgoing"
    || record.protocolVersion < 7
    || record.request.executionMode === "long_horizon"
    || !record.artifacts?.length) return false;
  return record.state === "completed"
    || (record.state === "rejected" && record.safeErrorCode === "TASK_EXPIRED")
    || ["submitted", "working", "auth_required", "input_required"].includes(record.state);
}

function shouldProjectExpiry(
  state: CollaborationTaskTransportRecord["state"],
  delivery: CollaborationTaskTransportRecord["delivery"],
  expiresAt: string,
  now: Date
): boolean {
  const terminal = ["completed", "failed", "rejected", "canceled"].includes(state);
  return (!terminal || delivery === "queued" || delivery === "send_failed")
    && Date.parse(expiresAt) <= now.getTime();
}

export function compareTaskSummaryPresentation(
  left: Pick<CollaborationTaskSummary, "direction" | "approval" | "state" | "updatedAt" | "expiresAt">,
  right: Pick<CollaborationTaskSummary, "direction" | "approval" | "state" | "updatedAt" | "expiresAt">
): number {
  const rank = (task: Pick<CollaborationTaskSummary, "direction" | "approval" | "state">): number => {
    if (task.direction === "incoming" && task.approval === "pending" && task.state === "submitted") return 0;
    if (["working", "input_required", "auth_required"].includes(task.state)) return 1;
    return 2;
  };
  const difference = rank(left) - rank(right);
  if (difference !== 0) return difference;
  if (rank(left) === 0) return left.expiresAt.localeCompare(right.expiresAt);
  return right.updatedAt.localeCompare(left.updatedAt);
}
