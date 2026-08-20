import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDesktopI18n } from "../src/i18n/index.ts";
import {
  executionProgressLabel,
  formatTaskTimestamp,
  longHorizonPhaseLabel,
  longHorizonProgressLabel,
  stateLabel,
  taskErrorMessage,
  taskPeerHeading
} from "../src/tasks/view.ts";

const english = createDesktopI18n("en");
const chinese = createDesktopI18n("zh-Hans");
const localTaskTimestamp = new Date(2026, 6, 27, 12, 34, 56).toISOString();

test("Task execution and Runtime progress map semantic state instead of receiver UI copy", () => {
  assert.equal(executionProgressLabel("running", english), "Local Child Agent is running");
  assert.equal(executionProgressLabel("running", chinese), "本机 Child Agent 正在执行");
  assert.equal(executionProgressLabel("future_state", english), "Execution status is updating");
  assert.equal(executionProgressLabel("future_state", chinese), "执行状态正在更新");

  const semanticProgress = {
    state: "running",
    phase: "working",
    stageIndex: 3,
    completedUnits: 1,
    totalUnits: 4
  };
  assert.equal(
    longHorizonProgressLabel(semanticProgress, english),
    "Stage 3 is running · 1/4"
  );
  assert.equal(
    longHorizonProgressLabel(semanticProgress, chinese),
    "阶段 3 正在执行 · 1/4"
  );
  assert.equal(longHorizonPhaseLabel("input_required", english), "Awaiting additional instructions");
  assert.equal(longHorizonPhaseLabel("input_required", chinese), "等待补充指令");
  assert.equal(stateLabel("future_state", english), "Unknown status");
  assert.equal(stateLabel("future_state", chinese), "状态未知");
});

test("Task dates, counts, plurals, native dialogs, and safe errors expose both catalogs", () => {
  assert.equal(formatTaskTimestamp(localTaskTimestamp, english), "07/27/2026, 12:34:56");
  assert.equal(formatTaskTimestamp(localTaskTimestamp, chinese), "2026/07/27 12:34:56");
  assert.equal(english.formatPlural(1, english.messages.tasks.header.pending), "1 awaiting confirmation");
  assert.equal(english.formatPlural(2, english.messages.tasks.header.pending), "2 awaiting confirmation");
  assert.equal(chinese.formatPlural(2, chinese.messages.tasks.header.pending), "2 个待确认");
  assert.equal(taskErrorMessage("operation_failed", english), "This task can’t be processed right now.");
  assert.equal(taskErrorMessage("operation_failed", chinese), "暂时无法处理这个任务。");
  assert.deepEqual(english.messages.nativeDialogs.taskImages, {
    selectTitle: "Choose task images",
    selectFilter: "Images",
    saveTitle: "Save result image",
    saveFilter: "Image"
  });
  assert.deepEqual(chinese.messages.nativeDialogs.taskImages, {
    selectTitle: "选择任务图片",
    selectFilter: "图片",
    saveTitle: "保存结果图片",
    saveFilter: "图片"
  });
});

test("two Mac locales render one collaboration record without changing protocol semantics", () => {
  const semanticRecord = Object.freeze({
    schemaVersion: 6,
    taskId: "task-dual-mac",
    direction: "incoming",
    peerTetiId: "teti_alpha0001",
    state: "working",
    progress: Object.freeze({ state: "running", completedUnits: 2, totalUnits: 5 }),
    createdAt: localTaskTimestamp
  });
  const before = JSON.stringify(semanticRecord);
  const connections = [{
    identity: { tetiId: "teti_alpha0001", displayName: "Alpha Mac" }
  }] as never;

  const englishHeading = taskPeerHeading(
    "incoming",
    semanticRecord.peerTetiId,
    semanticRecord.createdAt,
    connections,
    english
  );
  const chineseHeading = taskPeerHeading(
    "incoming",
    semanticRecord.peerTetiId,
    semanticRecord.createdAt,
    connections,
    chinese
  );

  assert.equal(englishHeading, "Collaboration request from Alpha Mac [07/27/2026, 12:34:56]");
  assert.equal(chineseHeading, "来自 Alpha Mac 的协作请求【2026/07/27 12:34:56】");
  assert.equal(JSON.stringify(semanticRecord), before);
});

test("Task presentation has no inline Chinese copy and English layout wraps long controls", async () => {
  const [view, styles, native] = await Promise.all([
    readFile(new URL("../src/tasks/view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(view, /\p{Script=Han}/u);
  assert.doesNotMatch(native, /\p{Script=Han}/u);
  assert.doesNotMatch(view, /selectedExecution\.progress\?\.message/);
  assert.doesNotMatch(view, /peer\?\.progressMessage/);
  assert.match(styles, /:root:lang\(en\) \.teti-task-selectors/);
  assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(140px, 1fr\)\)/);
  assert.match(styles, /\.teti-task-actionbar[\s\S]*?flex-wrap: wrap/);
  assert.match(styles, /\.teti-task-primary,[\s\S]*?white-space: normal/);
});
