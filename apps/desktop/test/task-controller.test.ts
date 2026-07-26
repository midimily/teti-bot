import assert from "node:assert/strict";
import test from "node:test";
import type {
  CollaborationTaskSummarySnapshot,
  CollaborationTaskTransportRecord,
  SendCollaborationTaskInput
} from "../../../core/task/transport.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import {
  TaskController,
  type TaskClient
} from "../src/tasks/controller.ts";

test("Task draft survives focus collapse and sends only staged descriptors", async () => {
  const client = new RecordingTaskClient();
  const tauri = new RecordingTauriInvoker();
  tauri.responses.set("pick_task_images", ["/Users/test/private/source.png"]);
  const notch = { setMode: async () => undefined };
  const controller = new TaskController({
    client,
    tauri,
    notchWindow: notch as never,
    onChange: () => undefined
  });

  controller.openCompose("connection-1", "code-analysis");
  controller.updateDraft({ text: "Analyze this image." });
  await controller.attachImages();
  controller.dismissFromOutside();
  assert.equal(controller.snapshot.open, false);
  assert.equal(controller.snapshot.draft.text, "Analyze this image.");
  assert.equal(controller.snapshot.draft.images.length, 1);

  controller.openCompose();
  await controller.send();
  assert.equal(client.sent.length, 1);
  assert.deepEqual(client.sent[0]?.attachments, [client.staged.part]);
  assert.equal(JSON.stringify(client.sent[0]).includes("/Users/test/private/source.png"), false);
  assert.equal(controller.snapshot.screen, "detail");
  controller.dispose();
});

test("Task controller coalesces refresh requests into one poll timer", async () => {
  let releaseSummary!: (value: CollaborationTaskSummarySnapshot) => void;
  const summary = new Promise<CollaborationTaskSummarySnapshot>((resolve) => {
    releaseSummary = resolve;
  });
  const client = new DeferredSummaryTaskClient(summary);
  const scheduled: Array<() => void> = [];
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    schedule: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    }
  });

  controller.start();
  controller.openInbox();
  controller.openInbox();
  assert.equal(client.summaryCalls, 1);
  releaseSummary({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pendingIncomingCount: 0,
    tasks: []
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduled.length, 1);
  controller.dispose();
  assert.equal(scheduled.length, 0);
});

test("Task controller can leave the task surface without rendering an idle frame", async () => {
  const modes: Array<{ mode: string; reason: string }> = [];
  let renders = 0;
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: new RecordingTauriInvoker(),
    notchWindow: {
      setMode: async (mode: string, reason: string) => {
        modes.push({ mode, reason });
      }
    } as never,
    onChange: () => { renders += 1; }
  });

  controller.openInbox();
  await Promise.resolve();
  modes.length = 0;
  renders = 0;
  controller.close("dock-activate-reset", { notify: false, updateWindowMode: false });

  assert.equal(controller.snapshot.open, false);
  assert.equal(renders, 0);
  assert.deepEqual(modes, []);
  controller.dispose();
});

test("Task inbox back returns to the expanded island without entering idle mode", async () => {
  const modes: Array<{ mode: string; reason: string }> = [];
  let renders = 0;
  let returns = 0;
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: new RecordingTauriInvoker(),
    notchWindow: {
      setMode: async (mode: string, reason: string) => {
        modes.push({ mode, reason });
      }
    } as never,
    onChange: () => { renders += 1; },
    onReturnToIsland: () => { returns += 1; }
  });

  controller.openInbox();
  await Promise.resolve();
  modes.length = 0;
  renders = 0;
  controller.back();

  assert.equal(controller.snapshot.open, false);
  assert.equal(returns, 1);
  assert.equal(renders, 0);
  assert.deepEqual(modes, []);
  controller.dispose();
});

class RecordingTaskClient implements TaskClient {
  readonly staged = {
    part: {
      kind: "image" as const,
      attachmentId: "image-1",
      mimeType: "image/png" as const,
      byteLength: 68,
      width: 1,
      height: 1,
      sha256: `sha256:${"a".repeat(64)}`
    },
    path: "/Users/test/.teti/task-attachments/staged/image-1.png",
    safeFileName: "image-1.png"
  };
  readonly sent: SendCollaborationTaskInput[] = [];
  private record: CollaborationTaskTransportRecord | null = null;

  async summaries(): Promise<CollaborationTaskSummarySnapshot> {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      pendingIncomingCount: 0,
      tasks: []
    };
  }

  async get(): Promise<CollaborationTaskTransportRecord> {
    if (!this.record) throw new Error("TASK_NOT_FOUND");
    return structuredClone(this.record);
  }

  async resolveImage(): Promise<string> { return this.staged.path; }
  async stageImage(): Promise<typeof this.staged> { return structuredClone(this.staged); }

  async send(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    this.sent.push(structuredClone(input));
    const now = new Date().toISOString();
    this.record = {
      schemaVersion: 1,
      direction: "outgoing",
      peerTetiId: "teti_beta00002",
      protocolVersion: 2,
      request: {
        schemaVersion: 2,
        taskId: "task-1",
        requesterTetiId: "teti_alpha0001",
        targetTetiId: "teti_beta00002",
        offerId: "capability:code-analysis",
        capabilityId: "code-analysis",
        input: {
          kind: "parts",
          parts: [{ kind: "text", text: input.text }, ...structuredClone(input.attachments ?? [])]
        },
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      state: "submitted",
      approval: "pending",
      delivery: "sent",
      attachmentsReady: true,
      createdAt: now,
      updatedAt: now
    };
    return structuredClone(this.record);
  }

  async approve(): Promise<CollaborationTaskTransportRecord> { return this.get(); }
  async reject(): Promise<CollaborationTaskTransportRecord> { return this.get(); }
  async cancel(): Promise<CollaborationTaskTransportRecord> { return this.get(); }
}

class DeferredSummaryTaskClient extends RecordingTaskClient {
  summaryCalls = 0;
  private readonly summary: Promise<CollaborationTaskSummarySnapshot>;

  constructor(summary: Promise<CollaborationTaskSummarySnapshot>) {
    super();
    this.summary = summary;
  }

  override summaries(): Promise<CollaborationTaskSummarySnapshot> {
    this.summaryCalls += 1;
    return this.summary;
  }
}
