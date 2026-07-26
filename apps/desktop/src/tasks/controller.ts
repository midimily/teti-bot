import type {
  CollaborationTaskSummarySnapshot,
  CollaborationTaskTransportRecord,
  SendCollaborationTaskInput
} from "../../../../core/task/transport.ts";
import { taskInputImages, type TaskImagePart } from "../../../../core/task/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type { TauriInvoker } from "../platform/tauri-api.ts";
import type { TauriNotchWindowController } from "../platform/tauri-notch-window.ts";
import type { StagedTaskImageDto } from "../lifecycle-bridge/protocol.ts";

const TASK_REFRESH_INTERVAL_MS = 2_000;
const EMPTY_SUMMARY: CollaborationTaskSummarySnapshot = {
  schemaVersion: 1,
  generatedAt: new Date(0).toISOString(),
  pendingIncomingCount: 0,
  tasks: []
};

export type TaskWorkspaceScreen = "inbox" | "compose" | "detail";

export interface TaskDraftImage extends StagedTaskImageDto {}

export interface TaskControllerSnapshot {
  open: boolean;
  screen: TaskWorkspaceScreen;
  summary: CollaborationTaskSummarySnapshot;
  selectedTask: CollaborationTaskTransportRecord | null;
  selectedImagePaths: Record<string, string>;
  draft: {
    connectionRequestId: string;
    capabilityId: string;
    text: string;
    images: TaskDraftImage[];
  };
  busy: boolean;
  error?: string;
}

export interface TaskClient {
  summaries(): Promise<CollaborationTaskSummarySnapshot>;
  get(taskId: string): Promise<CollaborationTaskTransportRecord>;
  resolveImage(taskId: string, attachmentId: string): Promise<string>;
  stageImage(path: string): Promise<StagedTaskImageDto>;
  send(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord>;
  approve(taskId: string): Promise<CollaborationTaskTransportRecord>;
  reject(taskId: string): Promise<CollaborationTaskTransportRecord>;
  cancel(taskId: string): Promise<CollaborationTaskTransportRecord>;
}

export class TaskController {
  private readonly client: TaskClient;
  private readonly tauri: TauriInvoker;
  private readonly notchWindow: TauriNotchWindowController;
  private readonly onChange: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;
  private snapshotValue: TaskControllerSnapshot = {
    open: false,
    screen: "inbox",
    summary: structuredClone(EMPTY_SUMMARY),
    selectedTask: null,
    selectedImagePaths: {},
    draft: { connectionRequestId: "", capabilityId: "", text: "", images: [] },
    busy: false
  };
  private timer: unknown;
  private refreshInFlight = false;
  private active = false;
  private disposed = false;

  constructor(options: {
    client: TaskClient;
    tauri: TauriInvoker;
    notchWindow: TauriNotchWindowController;
    onChange: () => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
  }) {
    this.client = options.client;
    this.tauri = options.tauri;
    this.notchWindow = options.notchWindow;
    this.onChange = options.onChange;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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
    delete this.snapshotValue.error;
    this.onChange();
    void this.notchWindow.setMode("task", "open-task-inbox").catch(() => undefined);
    void this.refresh();
  }

  openCompose(connectionRequestId = "", capabilityId = ""): void {
    this.snapshotValue.open = true;
    this.snapshotValue.screen = "compose";
    this.snapshotValue.draft.connectionRequestId ||= connectionRequestId;
    this.snapshotValue.draft.capabilityId ||= capabilityId;
    delete this.snapshotValue.error;
    this.onChange();
    void this.notchWindow.setMode("task", "compose-task").catch(() => undefined);
  }

  close(reason = "close-task-workspace"): void {
    this.snapshotValue.open = false;
    delete this.snapshotValue.error;
    this.onChange();
    void this.notchWindow.setMode("idle", reason).catch(() => undefined);
  }

  dismissFromOutside(): void {
    if (this.snapshotValue.open && !this.snapshotValue.busy) this.close("task-focus-lost");
  }

  back(): void {
    if (this.snapshotValue.screen === "inbox") {
      this.close();
      return;
    }
    this.snapshotValue.screen = "inbox";
    this.snapshotValue.selectedTask = null;
    this.snapshotValue.selectedImagePaths = {};
    delete this.snapshotValue.error;
    this.onChange();
  }

  updateDraft(input: Partial<Pick<TaskControllerSnapshot["draft"], "connectionRequestId" | "capabilityId" | "text">>): void {
    if (input.connectionRequestId !== undefined) this.snapshotValue.draft.connectionRequestId = input.connectionRequestId;
    if (input.capabilityId !== undefined) this.snapshotValue.draft.capabilityId = input.capabilityId;
    if (input.text !== undefined) this.snapshotValue.draft.text = [...input.text].slice(0, 6_000).join("");
    delete this.snapshotValue.error;
  }

  removeDraftImage(attachmentId: string): void {
    this.snapshotValue.draft.images = this.snapshotValue.draft.images.filter(
      (image) => image.part.attachmentId !== attachmentId
    );
    this.onChange();
  }

  async attachImages(): Promise<void> {
    if (this.snapshotValue.busy || this.snapshotValue.draft.images.length >= 4) return;
    await this.run(async () => {
      const paths = await this.tauri.invoke<string[]>("pick_task_images");
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
    if (!draft.connectionRequestId || !draft.capabilityId || !draft.text.trim()) {
      this.snapshotValue.error = "请选择已建联的 Teti 和能力，并写明任务。";
      this.onChange();
      return;
    }
    await this.run(async () => {
      const record = await this.client.send({
        connectionRequestId: draft.connectionRequestId,
        capabilityId: draft.capabilityId,
        text: draft.text.trim(),
        attachments: draft.images.map((image) => structuredClone(image.part))
      });
      this.snapshotValue.selectedTask = record;
      await this.loadSelectedImages(record);
      this.snapshotValue.screen = "detail";
      this.snapshotValue.draft = { connectionRequestId: "", capabilityId: "", text: "", images: [] };
      await this.refreshSummary();
    });
  }

  async select(taskId: string): Promise<void> {
    await this.run(async () => {
      this.snapshotValue.selectedTask = await this.client.get(taskId);
      await this.loadSelectedImages(this.snapshotValue.selectedTask);
      this.snapshotValue.screen = "detail";
    });
  }

  approve(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.approve(taskId));
  }

  reject(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.reject(taskId));
  }

  cancel(): Promise<void> {
    return this.mutateSelected((taskId) => this.client.cancel(taskId));
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
      this.snapshotValue.selectedTask = await operation(taskId);
      await this.loadSelectedImages(this.snapshotValue.selectedTask);
      await this.refreshSummary();
    });
  }

  private async refresh(): Promise<void> {
    if (!this.active || this.disposed || this.refreshInFlight) return;
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
    this.refreshInFlight = true;
    try {
      await this.refreshSummary();
      const taskId = this.snapshotValue.selectedTask?.request.taskId;
      if (taskId) {
        this.snapshotValue.selectedTask = await this.client.get(taskId);
        await this.loadSelectedImages(this.snapshotValue.selectedTask);
      }
      delete this.snapshotValue.error;
      this.onChange();
    } catch {
      // Chatmail polling and Task persistence remain Runtime-owned; UI retries.
    } finally {
      this.refreshInFlight = false;
      if (this.active && !this.disposed) {
        this.timer = this.schedule(() => {
          this.timer = undefined;
          void this.refresh();
        }, TASK_REFRESH_INTERVAL_MS);
      }
    }
  }

  private async refreshSummary(): Promise<void> {
    this.snapshotValue.summary = await this.client.summaries();
  }

  private async loadSelectedImages(record: CollaborationTaskTransportRecord): Promise<void> {
    const paths: Record<string, string> = {};
    for (const image of taskInputImages(record.request.input)) {
      try {
        paths[image.attachmentId] = await this.client.resolveImage(
          record.request.taskId,
          image.attachmentId
        );
      } catch {
        // Attachment readiness remains visible in the authoritative Task record.
      }
    }
    this.snapshotValue.selectedImagePaths = paths;
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.snapshotValue.busy) return;
    this.snapshotValue.busy = true;
    delete this.snapshotValue.error;
    this.onChange();
    try {
      await operation();
    } catch (error) {
      this.snapshotValue.error = taskErrorMessage(error);
    } finally {
      this.snapshotValue.busy = false;
      if (!this.disposed) this.onChange();
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

  reject(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.reject", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }

  cancel(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.bridge.request("task.cancel", { taskId }) as Promise<CollaborationTaskTransportRecord>;
  }
}

export class MockTaskClient implements TaskClient {
  async summaries(): Promise<CollaborationTaskSummarySnapshot> { return structuredClone(EMPTY_SUMMARY); }
  async get(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async resolveImage(): Promise<string> { throw new Error("TASK_ATTACHMENT_NOT_FOUND"); }
  async stageImage(_path: string): Promise<StagedTaskImageDto> { throw new Error("TASK_ATTACHMENTS_UNAVAILABLE"); }
  async send(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_TRANSPORT_UNAVAILABLE"); }
  async approve(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async reject(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
  async cancel(): Promise<CollaborationTaskTransportRecord> { throw new Error("TASK_NOT_FOUND"); }
}

function taskErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "REQUEST_TIMEOUT") return "操作超时，Runtime 会继续保留任务状态。";
    if (error.name === "TASK_TRANSPORT_FAILED") return error.message || "暂时无法处理这个任务。";
    return error.message || "暂时无法处理这个任务。";
  }
  return "暂时无法处理这个任务。";
}

export function taskImageParts(images: readonly TaskDraftImage[]): TaskImagePart[] {
  return images.map((image) => structuredClone(image.part));
}
