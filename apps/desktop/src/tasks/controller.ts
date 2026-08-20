import type {
  CollaborationTaskSummarySnapshot,
  CollaborationTaskTransportRecord,
  SendCollaborationTaskInput
} from "../../../../core/task/transport.ts";
import { taskArtifactImages, taskInputImages, type TaskImagePart } from "../../../../core/task/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type { TauriInvoker } from "../platform/tauri-api.ts";
import type { TauriNotchWindowController } from "../platform/tauri-notch-window.ts";
import type { PanelDiagnosticSink } from "../platform/panel-diagnostics.ts";
import type { StagedTaskImageDto } from "../lifecycle-bridge/protocol.ts";
import type { ExecutionHandle } from "../../../../core/callability/execution.ts";
import type {
  DelegationTargetOption,
  DelegationTargetSelection
} from "../../../../core/delegation/types.ts";
import { readStableErrorCode } from "../errors/stable-error-code.ts";
import type { AppMessages } from "../i18n/index.ts";
import type { LongHorizonTaskMemorySnapshot } from "../../../../core/memory/structured-task.ts";

export const TASK_REFRESH_DELAYS_MS = {
  visibleActive: 2_000,
  visibleIdle: 5_000,
  hiddenActive: 5_000,
  hiddenIdle: 10_000,
  failureInitial: 5_000,
  failureMaximum: 30_000
} as const;
const EMPTY_SUMMARY: CollaborationTaskSummarySnapshot = {
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  pendingIncomingCount: 0,
  tasks: []
};

export type TaskWorkspaceScreen = "inbox" | "compose" | "detail";

export type TaskUiErrorCode =
  | "draft_incomplete"
  | "operation_timeout"
  | "transport_failed"
  | "result_image_unavailable"
  | "result_image_invalid"
  | "result_image_unsupported"
  | "result_image_open_failed"
  | "result_image_reveal_failed"
  | "result_image_save_failed"
  | "result_image_action_unsupported"
  | "operation_failed";

export interface TaskDraftImage extends StagedTaskImageDto {}
export type TaskNativeDialogCopy = AppMessages["nativeDialogs"]["taskImages"];

export interface TaskControllerSnapshot {
  open: boolean;
  screen: TaskWorkspaceScreen;
  summary: CollaborationTaskSummarySnapshot;
  selectedTask: CollaborationTaskTransportRecord | null;
  selectedExecution: ExecutionHandle | null;
  selectedStructuredMemory: LongHorizonTaskMemorySnapshot | null;
  delegationTargets: DelegationTargetOption[];
  delegationSelections: DelegationTargetSelection[];
  selectedImagePaths: Record<string, string>;
  draft: {
    connectionRequestId: string;
    offerId: string;
    capabilityId: string;
    text: string;
    images: TaskDraftImage[];
    executionMode: "single_stage" | "long_horizon";
  };
  busy: boolean;
  errorCode?: TaskUiErrorCode;
}

export interface TaskCloseOptions {
  notify?: boolean;
  updateWindowMode?: boolean;
}

export interface TaskClient {
  summaries(): Promise<CollaborationTaskSummarySnapshot>;
  get(taskId: string): Promise<CollaborationTaskTransportRecord>;
  getStructuredMemory(taskId: string): Promise<LongHorizonTaskMemorySnapshot>;
  resolveImage(taskId: string, attachmentId: string): Promise<string>;
  stageImage(path: string): Promise<StagedTaskImageDto>;
  send(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord>;
  approve(taskId: string): Promise<CollaborationTaskTransportRecord>;
  delegationTargets(taskId: string): Promise<DelegationTargetOption[]>;
  approveDelegation(
    taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord>;
  reject(taskId: string): Promise<CollaborationTaskTransportRecord>;
  cancel(taskId: string): Promise<CollaborationTaskTransportRecord>;
  getExecution(taskId: string): Promise<ExecutionHandle | null>;
  resume(taskId: string): Promise<CollaborationTaskTransportRecord>;
  submitInput(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord>;
  pause(taskId: string): Promise<CollaborationTaskTransportRecord>;
  continue(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord>;
  complete(taskId: string): Promise<CollaborationTaskTransportRecord>;
  renew(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord>;
}

export type TaskRefreshMode =
  | "visible_active"
  | "visible_idle"
  | "hidden_active"
  | "hidden_idle"
  | "failure_backoff";

export interface TaskRefreshDecision {
  mode: TaskRefreshMode;
  delayMs: number;
}

export function resolveTaskRefreshDecision(
  snapshot: Pick<TaskControllerSnapshot, "open" | "summary" | "selectedTask">,
  consecutiveFailures = 0
): TaskRefreshDecision {
  if (consecutiveFailures > 0) {
    return {
      mode: "failure_backoff",
      delayMs: Math.min(
        TASK_REFRESH_DELAYS_MS.failureMaximum,
        TASK_REFRESH_DELAYS_MS.failureInitial * (2 ** Math.min(consecutiveFailures - 1, 3))
      )
    };
  }
  const active = snapshot.summary.tasks.some(taskSummaryNeedsFrequentRefresh)
    || Boolean(snapshot.selectedTask && taskRecordNeedsFrequentRefresh(snapshot.selectedTask));
  if (snapshot.open) {
    return active
      ? { mode: "visible_active", delayMs: TASK_REFRESH_DELAYS_MS.visibleActive }
      : { mode: "visible_idle", delayMs: TASK_REFRESH_DELAYS_MS.visibleIdle };
  }
  return active
    ? { mode: "hidden_active", delayMs: TASK_REFRESH_DELAYS_MS.hiddenActive }
    : { mode: "hidden_idle", delayMs: TASK_REFRESH_DELAYS_MS.hiddenIdle };
}

export class TaskController {
  private readonly client: TaskClient;
  private readonly tauri: TauriInvoker;
  private readonly notchWindow: TauriNotchWindowController;
  private readonly onChange: () => void;
  private readonly onReturnToIsland?: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;
  private readonly diagnostic: PanelDiagnosticSink;
  private snapshotValue: TaskControllerSnapshot = {
    open: false,
    screen: "inbox",
    summary: structuredClone(EMPTY_SUMMARY),
    selectedTask: null,
    selectedExecution: null,
    selectedStructuredMemory: null,
    delegationTargets: [],
    delegationSelections: [],
    selectedImagePaths: {},
    draft: {
      connectionRequestId: "",
      offerId: "",
      capabilityId: "",
      text: "",
      images: [],
      executionMode: "single_stage"
    },
    busy: false
  };
  private timer: unknown;
  private refreshInFlight = false;
  private consecutiveRefreshFailures = 0;
  private active = false;
  private disposed = false;
  private outsideDismissPending = false;
  private readonly imageResolutionFailures = new Map<string, string>();

  constructor(options: {
    client: TaskClient;
    tauri: TauriInvoker;
    notchWindow: TauriNotchWindowController;
    onChange: () => void;
    onReturnToIsland?: () => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    diagnostic?: PanelDiagnosticSink;
  }) {
    this.client = options.client;
    this.tauri = options.tauri;
    this.notchWindow = options.notchWindow;
    this.onChange = options.onChange;
    this.onReturnToIsland = options.onReturnToIsland;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.diagnostic = options.diagnostic ?? (() => undefined);
  }

  get snapshot(): TaskControllerSnapshot {
    return structuredClone(this.snapshotValue);
  }

  start(): void {
    if (this.active || this.disposed) return;
    this.active = true;
    void this.refresh();
  }

  openInbox(): void {
    this.snapshotValue.open = true;
    this.snapshotValue.screen = "inbox";
    delete this.snapshotValue.errorCode;
    this.onChange();
    void this.notchWindow.setMode("task", "open-task-inbox").catch(() => undefined);
    void this.refresh();
  }

  openCompose(connectionRequestId = "", capabilityId = "", offerId = ""): void {
    this.snapshotValue.open = true;
    this.snapshotValue.screen = "compose";
    this.snapshotValue.draft.connectionRequestId ||= connectionRequestId;
    this.snapshotValue.draft.capabilityId ||= capabilityId;
    this.snapshotValue.draft.offerId ||= offerId;
    delete this.snapshotValue.errorCode;
    this.onChange();
    this.scheduleNextRefresh();
    void this.notchWindow.setMode("task", "compose-task").catch(() => undefined);
  }

  close(reason = "close-task-workspace", options: TaskCloseOptions = {}): void {
    if (!this.snapshotValue.open && this.snapshotValue.errorCode === undefined) return;
    this.outsideDismissPending = false;
    this.snapshotValue.open = false;
    delete this.snapshotValue.errorCode;
    if (options.notify !== false) this.onChange();
    this.scheduleNextRefresh();
    if (options.updateWindowMode !== false) {
      void this.notchWindow.setMode("idle", reason).catch(() => undefined);
    }
  }

  dismissFromOutside(): void {
    if (!this.snapshotValue.open) return;
    if (this.snapshotValue.busy) {
      if (!this.outsideDismissPending) {
        this.outsideDismissPending = true;
        this.diagnostic({
          level: "warn",
          event: "panel.dismiss.deferred",
          fields: { surface: "task", screen: this.snapshotValue.screen, blocker: "busy" }
        });
      }
      return;
    }
    this.diagnostic({
      level: "debug",
      event: "panel.dismiss.immediate",
      fields: { surface: "task", screen: this.snapshotValue.screen }
    });
    this.close("task-focus-lost");
  }

  cancelPendingOutsideDismiss(): void {
    if (!this.outsideDismissPending) return;
    this.outsideDismissPending = false;
    this.diagnostic({
      level: "debug",
      event: "panel.dismiss.cancelled",
      fields: { surface: "task", reason: "focus_regained" }
    });
  }

  back(): void {
    if (this.snapshotValue.screen === "inbox") {
      if (this.onReturnToIsland) {
        this.close("task-back-to-island", { notify: false, updateWindowMode: false });
        this.onReturnToIsland();
      } else {
        this.close();
      }
      return;
    }
    this.snapshotValue.screen = "inbox";
    this.snapshotValue.selectedTask = null;
    this.snapshotValue.selectedExecution = null;
    this.snapshotValue.selectedStructuredMemory = null;
    this.snapshotValue.delegationTargets = [];
    this.snapshotValue.delegationSelections = [];
    this.snapshotValue.selectedImagePaths = {};
    this.imageResolutionFailures.clear();
    delete this.snapshotValue.errorCode;
    this.onChange();
    this.scheduleNextRefresh();
  }

  updateDraft(input: Partial<Pick<
    TaskControllerSnapshot["draft"],
    "connectionRequestId" | "offerId" | "capabilityId" | "text" | "executionMode"
  >>): void {
    if (input.connectionRequestId !== undefined) this.snapshotValue.draft.connectionRequestId = input.connectionRequestId;
    if (input.offerId !== undefined) this.snapshotValue.draft.offerId = input.offerId;
    if (input.capabilityId !== undefined) this.snapshotValue.draft.capabilityId = input.capabilityId;
    if (input.text !== undefined) this.snapshotValue.draft.text = [...input.text].slice(0, 6_000).join("");
    if (input.executionMode !== undefined) this.snapshotValue.draft.executionMode = input.executionMode;
    delete this.snapshotValue.errorCode;
  }

  canSendDraft(): boolean {
    const draft = this.snapshotValue.draft;
    return !this.snapshotValue.busy
      && Boolean(draft.connectionRequestId)
      && Boolean(draft.offerId)
      && Boolean(draft.capabilityId)
      && Boolean(draft.text.trim())
      && (draft.executionMode !== "long_horizon" || draft.images.length === 0);
  }

  removeDraftImage(attachmentId: string): void {
    this.snapshotValue.draft.images = this.snapshotValue.draft.images.filter(
      (image) => image.part.attachmentId !== attachmentId
    );
    this.onChange();
  }

  async attachImages(dialogCopy: TaskNativeDialogCopy): Promise<void> {
    if (this.snapshotValue.busy || this.snapshotValue.draft.images.length >= 4) return;
    await this.run(async () => {
      const paths = await this.tauri.invoke<string[]>("pick_task_images", {
        title: dialogCopy.selectTitle,
        filterName: dialogCopy.selectFilter
      });
      const remaining = 4 - this.snapshotValue.draft.images.length;
      for (const path of paths.slice(0, remaining)) {
        const staged = await this.client.stageImage(path);
        if (!this.snapshotValue.draft.images.some((image) =>
          image.part.sha256 === staged.part.sha256
        )) this.snapshotValue.draft.images.push(staged);
      }
    });
  }

  async send(): Promise<void> {
    const draft = this.snapshotValue.draft;
    if (!draft.connectionRequestId || !draft.offerId || !draft.capabilityId || !draft.text.trim()) {
      this.snapshotValue.errorCode = "draft_incomplete";
      this.onChange();
      return;
    }
    await this.run(async () => {
      const record = await this.client.send({
        connectionRequestId: draft.connectionRequestId,
        offerId: draft.offerId,
        capabilityId: draft.capabilityId,
        text: draft.text.trim(),
        attachments: draft.images.map((image) => structuredClone(image.part)),
        executionMode: draft.executionMode
      });
      this.beginDetail(record);
      this.snapshotValue.screen = "detail";
      this.onChange();
      this.snapshotValue.draft = {
        connectionRequestId: "",
        offerId: "",
        capabilityId: "",
        text: "",
        images: [],
        executionMode: "single_stage"
      };
      const [execution, structuredMemory, imagePaths, summary] = await Promise.all([
        this.readExecution(record.request.taskId),
        this.readStructuredMemory(record),
        this.resolveSelectedImagePaths(record),
        this.client.summaries()
      ]);
      if (this.isSelected(record.request.taskId)) {
        this.snapshotValue.selectedExecution = execution;
        this.snapshotValue.selectedStructuredMemory = structuredMemory;
        this.snapshotValue.selectedImagePaths = imagePaths;
      }
      this.snapshotValue.summary = summary;
    });
  }

  openResultImage(path: string): Promise<void> {
    return this.run(() => this.tauri.invoke("open_task_result_image", { path }));
  }

  revealResultImage(path: string): Promise<void> {
    return this.run(() => this.tauri.invoke("reveal_task_result_image", { path }));
  }

  saveResultImage(path: string, dialogCopy: TaskNativeDialogCopy): Promise<void> {
    return this.run(() => this.tauri.invoke("save_task_result_image", {
      path,
      title: dialogCopy.saveTitle,
      filterName: dialogCopy.saveFilter
    }));
  }

  async select(taskId: string): Promise<void> {
    await this.run(async () => {
      const executionPromise = this.readExecution(taskId);
      const record = await this.client.get(taskId);
      this.beginDetail(record);
      this.snapshotValue.screen = "detail";
      this.onChange();
      const [execution, structuredMemory, imagePaths, delegation] = await Promise.all([
        executionPromise,
        this.readStructuredMemory(record),
        this.resolveSelectedImagePaths(record),
        this.readDelegationState(record)
      ]);
      if (!this.isSelected(taskId)) return;
      this.snapshotValue.selectedExecution = execution;
      this.snapshotValue.selectedStructuredMemory = structuredMemory;
      this.snapshotValue.selectedImagePaths = imagePaths;
      this.snapshotValue.delegationTargets = delegation.targets;
      this.snapshotValue.delegationSelections = delegation.selections;
    });
  }

  approve(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.approve(taskId));
  }

  addDelegationStep(): void {
    if (this.snapshotValue.delegationSelections.length >= 4
      || this.snapshotValue.delegationTargets.length === 0) return;
    const target = this.snapshotValue.delegationTargets[
      Math.min(this.snapshotValue.delegationSelections.length, this.snapshotValue.delegationTargets.length - 1)
    ]!;
    this.snapshotValue.delegationSelections.push(delegationSelection(target));
    delete this.snapshotValue.errorCode;
    this.onChange();
  }

  removeDelegationStep(index: number): void {
    if (this.snapshotValue.delegationSelections.length <= 1) return;
    this.snapshotValue.delegationSelections.splice(index, 1);
    delete this.snapshotValue.errorCode;
    this.onChange();
  }

  setDelegationStep(index: number, targetKey: string): void {
    const target = this.snapshotValue.delegationTargets.find((candidate) =>
      delegationTargetKey(candidate) === targetKey
    );
    if (!target || index < 0 || index >= this.snapshotValue.delegationSelections.length) return;
    this.snapshotValue.delegationSelections[index] = delegationSelection(target);
    delete this.snapshotValue.errorCode;
    this.onChange();
  }

  async approveDelegation(): Promise<void> {
    const taskId = this.snapshotValue.selectedTask?.request.taskId;
    if (!taskId || this.snapshotValue.delegationSelections.length === 0) return;
    await this.run(async () => {
      this.snapshotValue.selectedTask = await this.client.approveDelegation(
        taskId,
        structuredClone(this.snapshotValue.delegationSelections)
      );
      this.snapshotValue.delegationTargets = [];
      this.snapshotValue.delegationSelections = [];
      this.onChange();
      const record = this.snapshotValue.selectedTask;
      const [execution, structuredMemory, imagePaths, summary] = await Promise.all([
        this.readExecution(taskId),
        this.readStructuredMemory(record),
        this.resolveSelectedImagePaths(record),
        this.client.summaries()
      ]);
      if (this.isSelected(taskId)) {
        this.snapshotValue.selectedExecution = execution;
        this.snapshotValue.selectedStructuredMemory = structuredMemory;
        this.snapshotValue.selectedImagePaths = imagePaths;
      }
      this.snapshotValue.summary = summary;
    });
  }

  reject(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.reject(taskId));
  }

  cancel(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.cancel(taskId));
  }

  resume(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.resume(taskId));
  }

  submitInput(instruction: string): Promise<void> {
    return this.mutateSelected((taskId) => this.client.submitInput(taskId, instruction));
  }

  pause(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.pause(taskId));
  }

  continue(childAgentId?: string): Promise<void> {
    return this.mutateSelected((taskId) => this.client.continue(taskId, childAgentId));
  }

  complete(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.complete(taskId));
  }

  renew(ttlMs = 60 * 60 * 1_000): Promise<void> {
    return this.mutateSelected((taskId) => this.client.renew(taskId, ttlMs));
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    this.timer = undefined;
  }

  private async mutateSelected(
    operation: (taskId: string) => Promise<CollaborationTaskTransportRecord>
  ): Promise<void> {
    const taskId = this.snapshotValue.selectedTask?.request.taskId;
    if (!taskId) return;
    await this.run(async () => {
      const record = await operation(taskId);
      this.snapshotValue.selectedTask = record;
      this.onChange();
      const [execution, structuredMemory, imagePaths, summary] = await Promise.all([
        this.readExecution(taskId),
        this.readStructuredMemory(record),
        this.resolveSelectedImagePaths(record),
        this.client.summaries()
      ]);
      if (this.isSelected(taskId)) {
        this.snapshotValue.selectedExecution = execution;
        this.snapshotValue.selectedStructuredMemory = structuredMemory;
        this.snapshotValue.selectedImagePaths = imagePaths;
      }
      this.snapshotValue.summary = summary;
    });
  }

  private async refresh(): Promise<void> {
    if (!this.active || this.disposed || this.refreshInFlight) return;
    if (this.snapshotValue.busy) {
      this.scheduleNextRefresh();
      return;
    }
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
    this.refreshInFlight = true;
    try {
      const previousPresentation = this.refreshPresentationKey();
      const taskId = this.snapshotValue.open && this.snapshotValue.screen === "detail"
        ? this.snapshotValue.selectedTask?.request.taskId
        : undefined;
      const summaryPromise = this.client.summaries();
      const detailPromise = taskId
        ? Promise.all([
          this.client.get(taskId),
          this.readExecution(taskId),
          this.snapshotValue.selectedTask?.direction === "incoming"
            && this.snapshotValue.selectedTask.request.executionMode === "long_horizon"
            && Boolean(this.snapshotValue.selectedTask.longHorizon)
            ? this.client.getStructuredMemory(taskId).catch(() => null)
            : Promise.resolve(null)
        ] as const)
        : null;
      const [summaryResult, detailResult] = await Promise.all([
        summaryPromise.then(
          (summary) => ({ ok: true as const, summary }),
          () => ({ ok: false as const })
        ),
        detailPromise
          ? detailPromise.then(
            ([record, execution, structuredMemory]) => ({
              ok: true as const,
              record,
              execution,
              structuredMemory
            }),
            () => ({ ok: false as const })
          )
          : Promise.resolve(null)
      ]);
      if (summaryResult.ok) this.snapshotValue.summary = summaryResult.summary;
      if (taskId && detailResult?.ok && this.isVisibleDetail(taskId)) {
        this.snapshotValue.selectedTask = detailResult.record;
        this.snapshotValue.selectedExecution = detailResult.execution;
        this.snapshotValue.selectedStructuredMemory = detailResult.structuredMemory;
        this.snapshotValue.selectedImagePaths = await this.resolveSelectedImagePaths(
          detailResult.record
        );
      }
      if (summaryResult.ok && (!taskId || detailResult?.ok)) {
        this.consecutiveRefreshFailures = 0;
      } else {
        this.consecutiveRefreshFailures = Math.min(this.consecutiveRefreshFailures + 1, 4);
      }
      // Runtime summaries carry a fresh generatedAt value on every read. Only
      // visible Task semantics may notify the global renderer; otherwise an
      // unrelated open Peer Passport accordion is destroyed every two seconds.
      const presentationChanged = previousPresentation !== this.refreshPresentationKey();
      if (presentationChanged
        && !(this.snapshotValue.open && this.snapshotValue.screen === "compose")) {
        this.onChange();
      }
    } catch {
      // Chatmail polling and Task persistence remain Runtime-owned; UI retries.
      this.consecutiveRefreshFailures = Math.min(this.consecutiveRefreshFailures + 1, 4);
    } finally {
      this.refreshInFlight = false;
      this.scheduleNextRefresh();
    }
  }

  private async resolveSelectedImagePaths(
    record: CollaborationTaskTransportRecord
  ): Promise<Record<string, string>> {
    const images = [
      ...taskInputImages(record.request.input),
      ...(record.artifacts ?? []).flatMap(taskArtifactImages)
    ];
    const imageIds = new Set(images.map((image) => image.attachmentId));
    const paths = Object.fromEntries(Object.entries(this.snapshotValue.selectedImagePaths)
      .filter(([attachmentId]) => imageIds.has(attachmentId)));
    for (const key of [...this.imageResolutionFailures.keys()]) {
      if (!key.startsWith(`${record.request.taskId}:`)
        || !imageIds.has(key.slice(record.request.taskId.length + 1))) {
        this.imageResolutionFailures.delete(key);
      }
    }
    const unresolved = images.filter((image) => {
      if (paths[image.attachmentId]) return false;
      const key = `${record.request.taskId}:${image.attachmentId}`;
      return this.imageResolutionFailures.get(key) !== imageResolutionVersion(record, image);
    });
    const resolved = await Promise.all(unresolved.map(async (image) => {
      const key = `${record.request.taskId}:${image.attachmentId}`;
      try {
        const path = await this.client.resolveImage(record.request.taskId, image.attachmentId);
        this.imageResolutionFailures.delete(key);
        return { attachmentId: image.attachmentId, path };
      } catch {
        this.imageResolutionFailures.set(key, imageResolutionVersion(record, image));
        return { attachmentId: image.attachmentId, path: null };
      }
    }));
    for (const result of resolved) {
      if (result.path) paths[result.attachmentId] = result.path;
    }
    return paths;
  }

  private async readExecution(taskId: string): Promise<ExecutionHandle | null> {
    try {
      return await this.client.getExecution(taskId);
    } catch {
      return null;
    }
  }

  private async readStructuredMemory(
    record: CollaborationTaskTransportRecord
  ): Promise<LongHorizonTaskMemorySnapshot | null> {
    if (record.direction !== "incoming"
      || record.request.executionMode !== "long_horizon"
      || !record.longHorizon) return null;
    try {
      return await this.client.getStructuredMemory(record.request.taskId);
    } catch {
      return null;
    }
  }

  private async readDelegationState(record: CollaborationTaskTransportRecord): Promise<{
    targets: DelegationTargetOption[];
    selections: DelegationTargetSelection[];
  }> {
    if (record.direction !== "incoming"
      || record.approval !== "pending"
      || record.request.executionMode !== "long_horizon"
      || record.delegationPlan) return { targets: [], selections: [] };
    try {
      const targets = await this.client.delegationTargets(record.request.taskId);
      return {
        targets,
        selections: targets[0] ? [delegationSelection(targets[0])] : []
      };
    } catch {
      // Normal single-Child approval remains available when delegation is unavailable.
      return { targets: [], selections: [] };
    }
  }

  private beginDetail(record: CollaborationTaskTransportRecord): void {
    this.snapshotValue.selectedTask = record;
    this.snapshotValue.selectedExecution = null;
    this.snapshotValue.selectedStructuredMemory = null;
    this.snapshotValue.delegationTargets = [];
    this.snapshotValue.delegationSelections = [];
    this.snapshotValue.selectedImagePaths = {};
    this.imageResolutionFailures.clear();
  }

  private isSelected(taskId: string): boolean {
    return this.snapshotValue.selectedTask?.request.taskId === taskId;
  }

  private isVisibleDetail(taskId: string): boolean {
    return this.snapshotValue.open
      && this.snapshotValue.screen === "detail"
      && this.isSelected(taskId);
  }

  private scheduleNextRefresh(): void {
    if (!this.active || this.disposed || this.refreshInFlight) return;
    if (this.timer !== undefined) this.cancelTimer(this.timer);
    const decision = resolveTaskRefreshDecision(
      this.snapshotValue,
      this.consecutiveRefreshFailures
    );
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.refresh();
    }, decision.delayMs);
  }

  private refreshPresentationKey(): string {
    const { generatedAt: _generatedAt, tasks, ...summaryState } = this.snapshotValue.summary;
    const summary = {
      ...summaryState,
      tasks: tasks.map((task) => {
        const { updatedAt: _updatedAt, expiresAt: _expiresAt, ...visibleTask } = task;
        return visibleTask;
      })
    };
    const execution = this.snapshotValue.selectedExecution;
    const detailVisible = this.snapshotValue.open && this.snapshotValue.screen === "detail";
    const selectedTask = detailVisible && this.snapshotValue.selectedTask
      ? (() => {
          const { updatedAt: _updatedAt, ...visibleTask } = this.snapshotValue.selectedTask!;
          return visibleTask;
        })()
      : null;
    return JSON.stringify({
      summary,
      selectedTask,
      selectedExecution: detailVisible && execution ? {
        taskId: execution.taskId,
        workspaceId: execution.workspaceId,
        childAgentId: execution.childAgentId,
        connectorId: execution.connectorId,
        executionEpoch: execution.executionEpoch,
        progress: {
          state: execution.progress.state,
          completedUnits: execution.progress.completedUnits,
          totalUnits: execution.progress.totalUnits,
          message: execution.progress.message
        },
        resumeCapability: execution.resumeCapability
      } : null,
      selectedStructuredMemory: detailVisible ? this.snapshotValue.selectedStructuredMemory : null,
      selectedImagePaths: detailVisible ? this.snapshotValue.selectedImagePaths : {}
    });
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.snapshotValue.busy) return;
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
    this.snapshotValue.busy = true;
    delete this.snapshotValue.errorCode;
    this.onChange();
    try {
      await operation();
    } catch (error) {
      this.snapshotValue.errorCode = taskErrorCode(error);
    } finally {
      this.snapshotValue.busy = false;
      if (this.outsideDismissPending && this.snapshotValue.open && !this.disposed) {
        this.outsideDismissPending = false;
        this.diagnostic({
          level: "warn",
          event: "panel.dismiss.resolved",
          fields: { surface: "task", screen: this.snapshotValue.screen, blocker: "busy" }
        });
        this.close("task-focus-lost-after-busy");
        return;
      }
      this.outsideDismissPending = false;
      if (!this.disposed) this.onChange();
      this.scheduleNextRefresh();
    }
  }
}

export class BridgeTaskClient implements TaskClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  summaries(): Promise<CollaborationTaskSummarySnapshot> {
    return this.bridge.request("task.summary") as Promise<CollaborationTaskSummarySnapshot>;
  }

  get(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.get", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  getStructuredMemory(taskId: string): Promise<LongHorizonTaskMemorySnapshot> {
    return this.bridge.request("task.memory.get", { taskId }) as Promise<LongHorizonTaskMemorySnapshot>;
  }

  async resolveImage(taskId: string, attachmentId: string): Promise<string> {
    const result = await this.bridge.request("task.attachment.resolve", { taskId, attachmentId }) as {
      path: string;
    };
    return result.path;
  }

  stageImage(path: string): Promise<StagedTaskImageDto> {
    return this.bridge.request("task.attachment.stage", { path }) as Promise<StagedTaskImageDto>;
  }

  send(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.send", input as unknown as Record<string, unknown>) as Promise<CollaborationTaskTransportRecord>;
  }

  approve(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.approve", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  delegationTargets(taskId: string): Promise<DelegationTargetOption[]> {
    return this.bridge.request("task.delegation.targets", { taskId }) as Promise<DelegationTargetOption[]>;
  }

  approveDelegation(
    taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request(
      "task.delegation.approve",
      { taskId, selections }
    ) as Promise<CollaborationTaskTransportRecord>;
  }

  reject(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.reject", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  cancel(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.cancel", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  getExecution(taskId: string): Promise<ExecutionHandle | null> {
    return this.bridge.request("task.execution.get", { taskId }) as Promise<ExecutionHandle | null>;
  }

  resume(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.execution.resume", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  submitInput(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.input.submit", { taskId, instruction }) as Promise<CollaborationTaskTransportRecord>;
  }

  pause(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.pause", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  continue(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request(
      "task.continue",
      { taskId, ...(childAgentId ? { childAgentId } : {}) }
    ) as Promise<CollaborationTaskTransportRecord>;
  }

  complete(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.complete", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  renew(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.renew", { taskId, ttlMs }) as Promise<CollaborationTaskTransportRecord>;
  }
}

export class MockTaskClient implements TaskClient {
  async summaries(): Promise<CollaborationTaskSummarySnapshot> { return structuredClone(EMPTY_SUMMARY); }
  async get(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async getStructuredMemory(): Promise<LongHorizonTaskMemorySnapshot> { throw new Error("MEMORY_STORE_UNAVAILABLE"); }
  async resolveImage(): Promise<string> { throw new Error("TASK_ATTACHMENT_NOT_FOUND"); }
  async stageImage(_path: string): Promise<StagedTaskImageDto> { throw new Error("TASK_ATTACHMENTS_UNAVAILABLE"); }
  async send(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_TRANSPORT_UNAVAILABLE"); }
  async approve(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async delegationTargets(): Promise<DelegationTargetOption[]> { return []; }
  async approveDelegation(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_DELEGATION_UNAVAILABLE"); }
  async reject(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async cancel(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async getExecution(): Promise<ExecutionHandle | null> { return null; }
  async resume(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_RESUME_UNAVAILABLE"); }
  async submitInput(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_INPUT_UNAVAILABLE"); }
  async pause(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_PAUSE_UNAVAILABLE"); }
  async continue(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_CONTINUE_UNAVAILABLE"); }
  async complete(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_COMPLETE_UNAVAILABLE"); }
  async renew(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_RENEW_UNAVAILABLE"); }
}

export function delegationTargetKey(target: DelegationTargetSelection): string {
  return `${target.childAgentId}|${target.connectorId}|${target.capabilityId}`;
}

function delegationSelection(target: DelegationTargetSelection): DelegationTargetSelection {
  return {
    childAgentId: target.childAgentId,
    connectorId: target.connectorId,
    capabilityId: target.capabilityId
  };
}

function imageResolutionVersion(
  record: CollaborationTaskTransportRecord,
  image: TaskImagePart
): string {
  const diagnostics = (record.attachmentDiagnostics ?? [])
    .filter((diagnostic) => diagnostic.attachmentId === image.attachmentId)
    .map((diagnostic) => [diagnostic.purpose, diagnostic.state, diagnostic.safeErrorCode ?? ""])
    .sort((left, right) => left.join(":").localeCompare(right.join(":")));
  return JSON.stringify({
    sha256: image.sha256,
    attachmentsReady: record.attachmentsReady ?? null,
    artifactAttachmentsReady: record.artifactAttachmentsReady ?? null,
    diagnostics
  });
}

function taskSummaryNeedsFrequentRefresh(
  task: CollaborationTaskSummarySnapshot["tasks"][number]
): boolean {
  return task.cancelPending
    || !task.attachmentsReady
    || (task.direction === "incoming" && task.approval === "pending")
    || task.delivery === "queued"
    || task.delivery === "send_failed"
    || ["submitted", "working", "input_required", "auth_required"].includes(task.state)
    || (task.direction === "outgoing" && task.state === "completed" && task.artifactCount === 0);
}

function taskRecordNeedsFrequentRefresh(record: CollaborationTaskTransportRecord): boolean {
  return record.cancelPending === true
    || record.attachmentsReady === false
    || record.artifactAttachmentsReady === false
    || (record.direction === "incoming" && record.approval === "pending")
    || record.delivery === "queued"
    || record.delivery === "send_failed"
    || ["submitted", "working", "input_required", "auth_required"].includes(record.state)
    || (record.direction === "outgoing"
      && record.state === "completed"
      && !(record.artifacts?.length));
}

function taskErrorCode(error: unknown): TaskUiErrorCode {
  switch (readStableErrorCode(error)) {
    case "REQUEST_TIMEOUT":
      return "operation_timeout";
    case "TASK_TRANSPORT_FAILED":
      return "transport_failed";
    case "TASK_RESULT_IMAGE_UNAVAILABLE":
      return "result_image_unavailable";
    case "TASK_RESULT_IMAGE_INVALID":
    case "TASK_RESULT_IMAGE_OUTSIDE_SCOPE":
      return "result_image_invalid";
    case "TASK_RESULT_IMAGE_UNSUPPORTED":
      return "result_image_unsupported";
    case "TASK_RESULT_IMAGE_OPEN_FAILED":
      return "result_image_open_failed";
    case "TASK_RESULT_IMAGE_REVEAL_FAILED":
      return "result_image_reveal_failed";
    case "TASK_RESULT_IMAGE_SAVE_FAILED":
    case "TASK_RESULT_IMAGE_SAVE_DESTINATION_INVALID":
      return "result_image_save_failed";
    case "TASK_RESULT_IMAGE_ACTION_UNSUPPORTED":
      return "result_image_action_unsupported";
    default:
      return "operation_failed";
  }
}

export function taskImageParts(images: readonly TaskDraftImage[]): TaskImagePart[] {
  return images.map((image) => structuredClone(image.part));
}
