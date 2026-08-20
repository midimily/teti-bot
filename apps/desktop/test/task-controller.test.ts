import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  CollaborationTaskSummarySnapshot,
  CollaborationTaskTransportRecord,
  SendCollaborationTaskInput
} from "../../../core/task/transport.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { createDesktopI18n } from "../src/i18n/index.ts";
import {
  TASK_REFRESH_DELAYS_MS,
  TaskController,
  resolveTaskRefreshDecision,
  type TaskClient
} from "../src/tasks/controller.ts";
import { formatTaskTimestamp, taskPeerHeading } from "../src/tasks/view.ts";
import type {
  DelegationTargetOption,
  DelegationTargetSelection
} from "../../../core/delegation/types.ts";
import type { LongHorizonTaskMemorySnapshot } from "../../../core/memory/structured-task.ts";

const chinese = createDesktopI18n("zh-Hans");
const english = createDesktopI18n("en");

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

  controller.openCompose("connection-1", "code-analysis", "capability:code-analysis");
  controller.updateDraft({ text: "Analyze this image." });
  await controller.attachImages(chinese.messages.nativeDialogs.taskImages);
  controller.dismissFromOutside();
  assert.equal(controller.snapshot.open, false);
  assert.equal(controller.snapshot.draft.text, "Analyze this image.");
  assert.equal(controller.snapshot.draft.images.length, 1);
  assert.deepEqual(tauri.calls[0], {
    command: "pick_task_images",
    args: { title: "选择任务图片", filterName: "图片" }
  });

  controller.openCompose();
  await controller.send();
  assert.equal(client.sent.length, 1);
  assert.deepEqual(client.sent[0]?.attachments, [client.staged.part]);
  assert.equal(JSON.stringify(client.sent[0]).includes("/Users/test/private/source.png"), false);
  assert.equal(controller.snapshot.screen, "detail");
  controller.dispose();
});

test("Task headings prefer the peer nickname and include an exact local timestamp", () => {
  const timestamp = new Date(2026, 6, 27, 12, 34, 56).toISOString();
  assert.equal(formatTaskTimestamp(timestamp, chinese), "2026/07/27 12:34:56");
  assert.equal(taskPeerHeading(
    "outgoing",
    "teti_air072700",
    timestamp,
    [{ identity: { tetiId: "teti_air072700", displayName: "Air0727" } }] as never,
    chinese
  ), "发送给 Air0727 的协作请求【2026/07/27 12:34:56】");
  assert.equal(taskPeerHeading(
    "outgoing",
    "teti_air072700",
    timestamp,
    [{ identity: { tetiId: "teti_air072700", displayName: "Air0727" } }] as never,
    english
  ), "Collaboration request sent to Air0727 [07/27/2026, 12:34:56]");
});

test("Task send eligibility follows the live draft instead of a stale render snapshot", () => {
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });

  controller.openCompose("connection-1", "code-analysis", "capability:code-analysis");
  assert.equal(controller.canSendDraft(), false);
  controller.updateDraft({ text: "Describe the task." });
  assert.equal(controller.canSendDraft(), true);
  controller.updateDraft({ capabilityId: "" });
  assert.equal(controller.canSendDraft(), false);
  controller.dispose();
});

test("Task result images expose native open, reveal, and save actions", async () => {
  const tauri = new RecordingTauriInvoker();
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri,
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });
  const path = "/Users/test/.teti/task-attachments/artifact/task-1/result.png";

  await controller.openResultImage(path);
  await controller.revealResultImage(path);
  await controller.saveResultImage(path, english.messages.nativeDialogs.taskImages);

  assert.deepEqual(tauri.calls, [
    { command: "open_task_result_image", args: { path } },
    { command: "reveal_task_result_image", args: { path } },
    {
      command: "save_task_result_image",
      args: { path, title: "Save result image", filterName: "Image" }
    }
  ]);
  controller.dispose();
});

test("Task controller maps native and unknown failures to safe semantic codes", async () => {
  let failure: unknown = { code: "TASK_RESULT_IMAGE_OPEN_FAILED", message: "private detail" };
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: {
      invoke: async () => { throw failure; }
    },
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });

  await controller.openResultImage("/Users/example/private.png");
  assert.equal(controller.snapshot.errorCode, "result_image_open_failed");

  failure = new Error("token=secret /Users/example/private.png");
  await controller.openResultImage("/Users/example/private.png");
  assert.equal(controller.snapshot.errorCode, "operation_failed");
  assert.equal(JSON.stringify(controller.snapshot).includes("token=secret"), false);
  controller.dispose();
});

test("Task UI keeps send state live, catalog-driven, and parents native image dialogs", async () => {
  const [view, native, englishCatalog, chineseCatalog] = await Promise.all([
    readFile(new URL("../src/tasks/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n/locales/zh-hans.ts", import.meta.url), "utf8")
  ]);

  assert.match(view, /prompt\.addEventListener\("input", syncSendState\)/);
  assert.match(view, /send\.disabled = !controller\.canSendDraft\(\)/);
  assert.match(view, /artifactImagePreview/);
  assert.match(view, /i18n\.messages\.tasks\.images\.open/);
  assert.doesNotMatch(view, /[\p{Script=Han}]/u);
  assert.match(englishCatalog, /Open result image/);
  assert.match(chineseCatalog, /打开结果图片/);
  assert.match(native, /async fn pick_task_images\(/);
  assert.match(native, /title: String/);
  assert.match(native, /filter_name: String/);
  assert.match(native, /set_title\(&title\)/);
  assert.match(native, /add_filter\(&filter_name/);
  assert.doesNotMatch(native, /选择任务图片|保存结果图片/);
  assert.ok(native.match(/\.set_parent\(&window\)/g)?.length === 2);
  assert.match(native, /open_task_result_image/);
  assert.match(native, /save_task_result_image/);
  assert.match(view, /messages\.plannerDisabled/);
  assert.match(view, /messages\.approve/);
  assert.match(chineseCatalog, /Teti Host 委派计划/);
  assert.match(chineseCatalog, /Planner 关闭/);
  assert.match(chineseCatalog, /按计划委派/);
  assert.match(view, /content\.dataset\.scrollKey = "tasks-inbox"/);
  assert.match(view, /content\.dataset\.scrollKey = `task-detail:\$\{record\.request\.taskId\}`/);
});

test("Task controller builds an explicit ordered Delegation selection and never invokes a Planner", async () => {
  const client = new RecordingTaskClient();
  const now = new Date().toISOString();
  client.seed({
    schemaVersion: 1,
    direction: "incoming",
    peerTetiId: "teti_alpha0001",
    protocolVersion: 6,
    request: {
      schemaVersion: 6,
      taskId: "task-delegation-ui",
      requesterTetiId: "teti_alpha0001",
      targetTetiId: "teti_beta00002",
      offerId: "capability:code-analysis",
      capabilityId: "code-analysis",
      input: { kind: "text", text: "Analyze, then edit." },
      workspace: { kind: "temporary", access: ["read", "write", "create_artifact"] },
      executionMode: "long_horizon",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    state: "received",
    approval: "pending",
    delivery: "received",
    attachmentsReady: true,
    createdAt: now,
    updatedAt: now
  } as CollaborationTaskTransportRecord);
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });

  await controller.select("task-delegation-ui");
  assert.equal(controller.snapshot.delegationSelections.length, 1);
  controller.addDelegationStep();
  assert.deepEqual(controller.snapshot.delegationSelections.map((selection) => selection.childAgentId), [
    "osaurus-runtime",
    "codex"
  ]);
  await controller.approveDelegation();
  assert.deepEqual(client.approvedDelegations[0]?.map((selection) => selection.childAgentId), [
    "osaurus-runtime",
    "codex"
  ]);
  assert.deepEqual(controller.snapshot.delegationSelections, []);
  controller.dispose();
});

test("Task detail paints after the record and resolves execution plus all images in parallel", async () => {
  const client = new DeferredDetailTaskClient();
  client.seed(imageDetailRecord("task-detail-parallel", 2));
  let renders = 0;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => { renders += 1; }
  });
  controller.openInbox();
  renders = 0;

  const selecting = controller.select("task-detail-parallel");
  await flushMicrotasks();

  assert.equal(controller.snapshot.screen, "detail");
  assert.equal(controller.snapshot.selectedTask?.request.taskId, "task-detail-parallel");
  assert.equal(controller.snapshot.busy, true);
  assert.ok(renders >= 2, "the authoritative record must paint before enrichment settles");
  assert.deepEqual(new Set(client.started), new Set([
    "execution",
    "get",
    "image:image-1",
    "image:image-2"
  ]));

  client.releaseEnrichment();
  await selecting;
  assert.equal(controller.snapshot.busy, false);
  assert.deepEqual(Object.keys(controller.snapshot.selectedImagePaths).sort(), ["image-1", "image-2"]);
  controller.dispose();
});

test("Task focus loss during a busy detail read is deferred and collapses after it settles", async () => {
  const client = new DeferredDetailTaskClient();
  client.seed(imageDetailRecord("task-deferred-focus-collapse", 1));
  const diagnostics: Array<{ event: string }> = [];
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    diagnostic: (entry) => diagnostics.push(entry)
  });
  controller.openInbox();

  const selecting = controller.select("task-deferred-focus-collapse");
  await flushMicrotasks();
  assert.equal(controller.snapshot.busy, true);

  controller.dismissFromOutside();
  assert.equal(controller.snapshot.open, true, "an in-flight read is not interrupted");

  client.releaseEnrichment();
  await selecting;
  assert.equal(controller.snapshot.open, false, "the deferred focus loss is reconciled");
  assert.deepEqual(diagnostics.map(({ event }) => event), [
    "panel.dismiss.deferred",
    "panel.dismiss.resolved"
  ]);
  controller.dispose();
});

test("Task focus regain cancels a deferred outside dismissal", async () => {
  const client = new DeferredDetailTaskClient();
  client.seed(imageDetailRecord("task-cancel-deferred-collapse", 1));
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });
  controller.openInbox();

  const selecting = controller.select("task-cancel-deferred-collapse");
  await flushMicrotasks();
  controller.dismissFromOutside();
  controller.cancelPendingOutsideDismiss();
  client.releaseEnrichment();
  await selecting;

  assert.equal(controller.snapshot.open, true);
  controller.dispose();
});

test("long-horizon detail loads execution and delegation targets without a serial waterfall", async () => {
  const client = new DeferredDetailTaskClient();
  client.seed(longHorizonDetailRecord("task-detail-delegation"));
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });
  controller.openInbox();

  const selecting = controller.select("task-detail-delegation");
  await flushMicrotasks();
  assert.ok(client.started.includes("execution"));
  assert.ok(client.started.includes("delegation"));
  assert.ok(client.started.includes("structured-memory"));
  assert.equal(controller.snapshot.screen, "detail");

  client.releaseEnrichment();
  await selecting;
  assert.equal(controller.snapshot.delegationTargets.length, 2);
  assert.equal(controller.snapshot.selectedStructuredMemory?.status, "ready");
  controller.dispose();
});

test("visible refresh reuses resolved images and hidden detail stops supplemental reads", async () => {
  const client = new CountingDetailTaskClient();
  client.seed(imageDetailRecord("task-detail-efficient-refresh", 1));
  let scheduled: (() => void) | undefined;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    schedule(callback) {
      scheduled = callback;
      return callback;
    },
    cancel: () => undefined
  });
  controller.openInbox();
  await controller.select("task-detail-efficient-refresh");
  assert.equal(client.imageCalls, 1);

  controller.start();
  await flushMicrotasks();
  assert.equal(client.imageCalls, 1, "a successful local path must not be resolved every two seconds");
  const visibleGetCalls = client.getCalls;
  const visibleExecutionCalls = client.executionCalls;

  controller.close();
  scheduled?.();
  await flushMicrotasks();
  assert.equal(client.getCalls, visibleGetCalls, "closed detail must not read its hidden Task record");
  assert.equal(
    client.executionCalls,
    visibleExecutionCalls,
    "closed detail must not query its hidden execution handle"
  );
  assert.equal(client.imageCalls, 1);
  controller.dispose();
});

test("an unavailable image retries only after its attachment readiness changes", async () => {
  const client = new FailingImageDetailTaskClient();
  const pending = imageDetailRecord("task-detail-image-retry", 1);
  pending.attachmentsReady = false;
  client.seed(pending);
  let scheduled: (() => void) | undefined;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    schedule(callback) {
      scheduled = callback;
      return callback;
    },
    cancel: () => undefined
  });
  controller.openInbox();
  await controller.select("task-detail-image-retry");
  assert.equal(client.imageCalls, 1);

  controller.start();
  await flushMicrotasks();
  assert.equal(client.imageCalls, 1, "unchanged readiness must not cause a two-second failure loop");

  const ready = imageDetailRecord("task-detail-image-retry", 1);
  ready.attachmentsReady = true;
  client.seed(ready);
  scheduled?.();
  await flushMicrotasks();
  assert.equal(client.imageCalls, 2, "a readiness transition must permit one recovery attempt");
  controller.dispose();
});

test("Task refresh policy adapts to visibility, activity, and bounded failure backoff", () => {
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });
  const hiddenIdle = controller.snapshot;
  assert.deepEqual(resolveTaskRefreshDecision(hiddenIdle), {
    mode: "hidden_idle",
    delayMs: TASK_REFRESH_DELAYS_MS.hiddenIdle
  });

  const visibleIdle = { ...hiddenIdle, open: true };
  assert.deepEqual(resolveTaskRefreshDecision(visibleIdle), {
    mode: "visible_idle",
    delayMs: TASK_REFRESH_DELAYS_MS.visibleIdle
  });

  const activeTask = taskSummary("working");
  const visibleActive = {
    ...visibleIdle,
    summary: { ...visibleIdle.summary, tasks: [activeTask] }
  };
  assert.deepEqual(resolveTaskRefreshDecision(visibleActive), {
    mode: "visible_active",
    delayMs: TASK_REFRESH_DELAYS_MS.visibleActive
  });
  assert.deepEqual(resolveTaskRefreshDecision({ ...visibleActive, open: false }), {
    mode: "hidden_active",
    delayMs: TASK_REFRESH_DELAYS_MS.hiddenActive
  });

  const completedOutgoing = taskSummary("completed");
  assert.equal(
    resolveTaskRefreshDecision({
      ...hiddenIdle,
      summary: { ...hiddenIdle.summary, tasks: [{ ...completedOutgoing, artifactCount: 1 }] }
    }).mode,
    "hidden_idle",
    "outgoing approval metadata must not keep a completed result on the fast interval"
  );
  assert.deepEqual([1, 2, 3, 4, 8].map((failures) =>
    resolveTaskRefreshDecision(hiddenIdle, failures).delayMs
  ), [5_000, 10_000, 20_000, 30_000, 30_000]);
  controller.dispose();
});

test("Task controller reschedules one timer when visible activity changes", async () => {
  const client = new RecordingTaskClient();
  const delays: number[] = [];
  let scheduled: (() => void) | undefined;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    schedule(callback, delayMs) {
      scheduled = callback;
      delays.push(delayMs);
      return callback;
    },
    cancel(handle) {
      if (scheduled === handle) scheduled = undefined;
    }
  });

  controller.start();
  await flushMicrotasks();
  assert.equal(delays.at(-1), TASK_REFRESH_DELAYS_MS.hiddenIdle);

  controller.openInbox();
  await flushMicrotasks();
  assert.equal(delays.at(-1), TASK_REFRESH_DELAYS_MS.visibleIdle);

  client.summary.tasks = [taskSummary("working")];
  scheduled?.();
  await flushMicrotasks();
  assert.equal(delays.at(-1), TASK_REFRESH_DELAYS_MS.visibleActive);

  controller.close();
  assert.equal(delays.at(-1), TASK_REFRESH_DELAYS_MS.hiddenActive);
  controller.dispose();
});

test("Task controller backs off repeated read failures and resets after recovery", async () => {
  const client = new RecoveringSummaryTaskClient(3);
  const delays: number[] = [];
  let scheduled: (() => void) | undefined;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined,
    schedule(callback, delayMs) {
      scheduled = callback;
      delays.push(delayMs);
      return callback;
    },
    cancel(handle) {
      if (scheduled === handle) scheduled = undefined;
    }
  });

  controller.start();
  await flushMicrotasks();
  assert.equal(delays.at(-1), 5_000);
  scheduled?.();
  await flushMicrotasks();
  assert.equal(delays.at(-1), 10_000);
  scheduled?.();
  await flushMicrotasks();
  assert.equal(delays.at(-1), 20_000);

  controller.openInbox();
  await flushMicrotasks();
  assert.equal(delays.at(-1), TASK_REFRESH_DELAYS_MS.visibleIdle);
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
  await flushMicrotasks();
  assert.equal(scheduled.length, 1);
  controller.dispose();
  assert.equal(scheduled.length, 0);
});

test("periodic Runtime refresh does not rebuild the open Task composer", async () => {
  const scheduled: Array<() => void> = [];
  let renders = 0;
  const controller = new TaskController({
    client: new RecordingTaskClient(),
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => { renders += 1; },
    schedule: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancel: () => undefined
  });

  controller.openCompose("connection-1", "code-analysis");
  renders = 0;
  controller.start();
  await flushMicrotasks();
  assert.equal(renders, 0);
  assert.equal(scheduled.length, 1);

  scheduled.shift()?.();
  await flushMicrotasks();
  assert.equal(renders, 0);
  controller.dispose();
});

test("timestamp-only Task polling does not rebuild an expanded Peer Passport surface", async () => {
  const client = new RecordingTaskClient();
  let scheduled: (() => void) | undefined;
  let renders = 0;
  const controller = new TaskController({
    client,
    tauri: new RecordingTauriInvoker(),
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => { renders += 1; },
    schedule(callback) {
      scheduled = callback;
      return 1;
    },
    cancel: () => undefined
  });

  controller.start();
  await flushMicrotasks();
  assert.equal(renders, 0);
  client.summary.generatedAt = "2026-07-29T00:00:02.000Z";
  scheduled?.();
  await flushMicrotasks();
  assert.equal(renders, 0, "generatedAt churn must not replace unrelated Peer detail DOM");

  client.summary.pendingIncomingCount = 1;
  scheduled?.();
  await flushMicrotasks();
  assert.equal(renders, 1, "a visible Task semantic change must still notify the shell");
  controller.dispose();
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
  readonly summary: CollaborationTaskSummarySnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-07-29T00:00:00.000Z",
    pendingIncomingCount: 0,
    tasks: []
  };
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
  readonly approvedDelegations: DelegationTargetSelection[][] = [];
  readonly availableDelegationTargets: DelegationTargetOption[] = [
    {
      childAgentId: "osaurus-runtime",
      connectorId: "osaurus.runtime",
      capabilityId: "general-text-assistance",
      resourceBindingId: "binding:osaurus.runtime",
      workspacePolicy: "none",
      inputModes: ["text"],
      outputModes: ["text"],
      timeoutMs: 60_000,
      maxOutputBytes: 24 * 1_024
    },
    {
      childAgentId: "codex",
      connectorId: "codex.image",
      capabilityId: "image-editing",
      resourceBindingId: "binding:codex.image",
      workspacePolicy: "snapshot",
      inputModes: ["text", "image"],
      outputModes: ["text", "image"],
      timeoutMs: 120_000,
      maxOutputBytes: 56 * 1_024
    }
  ];
  private record: CollaborationTaskTransportRecord | null = null;

  seed(record: CollaborationTaskTransportRecord): void {
    this.record = structuredClone(record);
  }

  async summaries(): Promise<CollaborationTaskSummarySnapshot> {
    return structuredClone(this.summary);
  }

  async get(): Promise<CollaborationTaskTransportRecord> {
    if (!this.record) throw new Error("TASK_NOT_FOUND");
    return structuredClone(this.record);
  }

  async getStructuredMemory(taskId: string): Promise<LongHorizonTaskMemorySnapshot> {
    return {
      schemaVersion: 1,
      taskId,
      status: "ready",
      recordCount: 0,
      latestStageIndex: null,
      updatedAt: null,
      records: []
    };
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
  async delegationTargets(): Promise<DelegationTargetOption[]> {
    return structuredClone(this.availableDelegationTargets);
  }
  async approveDelegation(
    _taskId: string,
    selections: DelegationTargetSelection[]
  ): Promise<CollaborationTaskTransportRecord> {
    this.approvedDelegations.push(structuredClone(selections));
    if (!this.record) throw new Error("TASK_NOT_FOUND");
    this.record.approval = "consumed";
    this.record.state = "working";
    return structuredClone(this.record);
  }
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

class RecoveringSummaryTaskClient extends RecordingTaskClient {
  private failuresRemaining: number;

  constructor(failures: number) {
    super();
    this.failuresRemaining = failures;
  }

  override async summaries(): Promise<CollaborationTaskSummarySnapshot> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Runtime temporarily unavailable");
    }
    return super.summaries();
  }
}

class DeferredDetailTaskClient extends RecordingTaskClient {
  readonly started: string[] = [];
  private release!: () => void;
  private readonly enrichment = new Promise<void>((resolve) => { this.release = resolve; });

  releaseEnrichment(): void {
    this.release();
  }

  override async get(): Promise<CollaborationTaskTransportRecord> {
    this.started.push("get");
    return super.get();
  }

  async getExecution(): Promise<null> {
    this.started.push("execution");
    await this.enrichment;
    return null;
  }

  override async resolveImage(_taskId: string, attachmentId: string): Promise<string> {
    this.started.push(`image:${attachmentId}`);
    await this.enrichment;
    return `/private/task-images/${attachmentId}.png`;
  }

  override async delegationTargets(): Promise<DelegationTargetOption[]> {
    this.started.push("delegation");
    await this.enrichment;
    return super.delegationTargets();
  }

  override async getStructuredMemory(taskId: string): Promise<LongHorizonTaskMemorySnapshot> {
    this.started.push("structured-memory");
    await this.enrichment;
    return super.getStructuredMemory(taskId);
  }
}

class CountingDetailTaskClient extends RecordingTaskClient {
  getCalls = 0;
  executionCalls = 0;
  imageCalls = 0;

  override async get(): Promise<CollaborationTaskTransportRecord> {
    this.getCalls += 1;
    return super.get();
  }

  async getExecution(): Promise<null> {
    this.executionCalls += 1;
    return null;
  }

  override async resolveImage(_taskId: string, attachmentId: string): Promise<string> {
    this.imageCalls += 1;
    return `/private/task-images/${attachmentId}.png`;
  }
}

class FailingImageDetailTaskClient extends CountingDetailTaskClient {
  override async resolveImage(): Promise<string> {
    this.imageCalls += 1;
    throw new Error("TASK_ATTACHMENT_NOT_FOUND");
  }
}

function imageDetailRecord(taskId: string, imageCount: number): CollaborationTaskTransportRecord {
  const now = "2026-08-14T09:00:00.000Z";
  return {
    schemaVersion: 1,
    direction: "incoming",
    peerTetiId: "teti_alpha0001",
    protocolVersion: 7,
    request: {
      schemaVersion: 7,
      taskId,
      requesterTetiId: "teti_alpha0001",
      targetTetiId: "teti_beta00002",
      offerId: "capability:image-editing",
      capabilityId: "image-editing",
      input: {
        kind: "parts",
        parts: [
          { kind: "text", text: "Inspect these images." },
          ...Array.from({ length: imageCount }, (_, index) => ({
            kind: "image" as const,
            attachmentId: `image-${index + 1}`,
            mimeType: "image/png" as const,
            byteLength: 68,
            width: 1,
            height: 1,
            sha256: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`
          }))
        ]
      },
      executionMode: "single_stage",
      createdAt: now,
      expiresAt: "2026-08-14T10:00:00.000Z"
    },
    state: "received",
    approval: "pending",
    delivery: "received",
    attachmentsReady: true,
    createdAt: now,
    updatedAt: now
  };
}

function longHorizonDetailRecord(taskId: string): CollaborationTaskTransportRecord {
  const record = imageDetailRecord(taskId, 0);
  record.request.offerId = "capability:code-analysis";
  record.request.capabilityId = "code-analysis";
  record.request.executionMode = "long_horizon";
  record.longHorizon = {
    schemaVersion: 1,
    sessionId: `session-${taskId}`,
    phase: "awaiting_approval",
    stageIndex: 0,
    stages: [],
    pauseRequested: false,
    inputRequest: null,
    pendingInput: null,
    continuationExpiresAt: record.request.expiresAt,
    progress: {
      state: "queued",
      completedUnits: null,
      totalUnits: null,
      message: null,
      updatedAt: record.updatedAt
    }
  };
  return record;
}

function taskSummary(
  state: CollaborationTaskSummarySnapshot["tasks"][number]["state"]
): CollaborationTaskSummarySnapshot["tasks"][number] {
  return {
    taskId: `task-summary-${state}`,
    direction: "outgoing",
    peerTetiId: "teti_beta00002",
    capabilityId: "code-analysis",
    textPreview: "Adaptive refresh fixture",
    imageCount: 0,
    receivedImageCount: 0,
    artifactCount: 0,
    state,
    approval: "pending",
    delivery: state === "completed" ? "acknowledged" : "sent",
    attachmentsReady: true,
    cancelPending: false,
    createdAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-14T09:00:00.000Z",
    expiresAt: "2026-08-14T10:00:00.000Z"
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
