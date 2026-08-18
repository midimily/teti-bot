import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDesktopI18n } from "../src/i18n/index.ts";
import { TaskController, type TaskClient } from "../src/tasks/controller.ts";

test("Windows companion observes power, DPI, monitor, focus, and work-area changes", async () => {
  const [nativeWindow, shellWindow, platform] = await Promise.all([
    readFile(new URL("../src-tauri/src/windows_native.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/platform/mod.rs", import.meta.url), "utf8")
  ]);

  assert.match(nativeWindow, /WM_POWERBROADCAST/);
  assert.match(nativeWindow, /PBT_APMSUSPEND/);
  assert.match(nativeWindow, /PBT_APMRESUMEAUTOMATIC/);
  assert.match(nativeWindow, /WM_DISPLAYCHANGE \| WM_DPICHANGED \| WM_SETTINGCHANGE/);
  assert.match(nativeWindow, /GetMonitorInfoW/);
  assert.match(nativeWindow, /rcWork/);
  assert.match(shellWindow, /top_center_physical_position/);
  assert.match(shellWindow, /set_focus\(\)/);
  assert.match(platform, /DesktopPlatform::Macos \| DesktopPlatform::Windows/);
});

test("native image operations are cross-platform and never expose arbitrary attachment trees", async () => {
  const [native, macConfig, windowsConfig] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8")
  ]);

  assert.match(native, /\.open_path\(/);
  assert.match(native, /\.reveal_item_in_dir\(/);
  assert.match(native, /TASK_RESULT_IMAGE_OUTSIDE_SCOPE/);
  assert.match(native, /TASK_RESULT_IMAGE_SAVE_DESTINATION_INVALID/);
  assert.doesNotMatch(native, /TASK_RESULT_IMAGE_ACTION_UNSUPPORTED/);

  for (const config of [JSON.parse(macConfig), JSON.parse(windowsConfig)]) {
    const scope = config.app.security.assetProtocol.scope as string[];
    assert.equal(scope.length, 2);
    assert.ok(scope.every((entry) => entry.includes("task-attachments/")));
    assert.ok(scope.every((entry) => entry.endsWith("/input/**") || entry.endsWith("/artifact/**")));
    assert.ok(scope.every((entry) => !entry.includes("artifact-document")));
  }
});

test("stable native image failures map to safe messages in both locales", async () => {
  let failure: unknown = { code: "TASK_RESULT_IMAGE_OUTSIDE_SCOPE", detail: "C:\\private" };
  const controller = new TaskController({
    client: {} as TaskClient,
    tauri: { invoke: async () => { throw failure; } },
    notchWindow: { setMode: async () => undefined } as never,
    onChange: () => undefined
  });

  await controller.openResultImage("C:\\Users\\teti\\outside.png");
  assert.equal(controller.snapshot.errorCode, "result_image_invalid");
  for (const locale of ["en", "zh-Hans"] as const) {
    const messages = createDesktopI18n(locale).messages.tasks.errors;
    assert.ok(messages.result_image_invalid.length > 0);
    assert.equal(messages.result_image_invalid.includes("C:\\private"), false);
  }

  failure = { code: "TASK_RESULT_IMAGE_SAVE_DESTINATION_INVALID" };
  await controller.saveResultImage("C:\\Users\\teti\\artifact.png", {
    selectTitle: "unused",
    selectFilter: "unused",
    saveTitle: "Save",
    saveFilter: "Image"
  });
  assert.equal(controller.snapshot.errorCode, "result_image_save_failed");
  controller.dispose();
});

test("local reset validates the exact resolved Profile and restarts after Runtime shutdown", async () => {
  const [native, platform] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/platform/mod.rs", import.meta.url), "utf8")
  ]);

  assert.match(platform, /validate_profile_reset_target/);
  assert.match(platform, /target != expected/);
  assert.match(native, /LOCAL_PROFILE_TARGET_INVALID/);
  assert.match(native, /profile_reset_error_is_retryable/);
  assert.match(native, /bridge\.shutdown\(\);[\s\S]*?app\.restart\(\)/);
});
