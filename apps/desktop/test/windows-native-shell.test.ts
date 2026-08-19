import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDesktopI18n } from "../src/i18n/index.ts";
import {
  isWindowsLaunchFocusGuardActive,
  shouldRevealMainPanelOnLaunch,
  WINDOWS_LAUNCH_FOCUS_GUARD_MS
} from "../src/platform/launch-presentation.ts";
import { TaskController, type TaskClient } from "../src/tasks/controller.ts";
import type { TetiAccount } from "../../../core/account/model.ts";
import type { DesktopPlatformInfo } from "../src/platform/contract.ts";

test("Windows release binary uses the GUI subsystem without hiding debug output", async () => {
  const main = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");

  assert.match(main, /all\(not\(debug_assertions\), target_os = "windows"\)/);
  assert.match(main, /windows_subsystem = "windows"/);
});

test("desktop runtime detection uses Tauri's public API and Windows starts visibly", async () => {
  const [tauriApi, shellWindow, index] = await Promise.all([
    readFile(new URL("../src/platform/tauri-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8")
  ]);

  assert.match(tauriApi, /if \(!isTauri\(\)\)/);
  assert.doesNotMatch(tauriApi, /import\("@tauri-apps\/api\/(?:core|event|window)"\)/);
  assert.doesNotMatch(tauriApi, /__TAURI_INTERNALS__/);
  assert.match(shellWindow, /target_os = "windows"[\s\S]*IslandMode::Onboarding/);
  assert.match(shellWindow, /let _ = window\.set_focus\(\)/);
  assert.match(index, /data-teti-boot/);
  assert.match(index, /15_000/);
});

test("Windows launches an existing account into a discoverable full panel", () => {
  const account = existingAccount();
  assert.equal(shouldRevealMainPanelOnLaunch(WINDOWS_PLATFORM, {
    state: "idle",
    nameInput: "",
    submitting: false,
    account
  }), true);
  assert.equal(shouldRevealMainPanelOnLaunch(MACOS_PLATFORM, {
    state: "idle",
    nameInput: "",
    submitting: false,
    account
  }), false);
  const startedAt = 10_000;
  const deadline = startedAt + WINDOWS_LAUNCH_FOCUS_GUARD_MS;
  assert.equal(isWindowsLaunchFocusGuardActive(deadline, startedAt + 1), true);
  assert.equal(isWindowsLaunchFocusGuardActive(deadline, deadline + 1), false);
});

test("Windows native shell is single-instance and reopens the existing panel", async () => {
  const [manifest, native] = await Promise.all([
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8")
  ]);

  assert.match(manifest, /tauri-plugin-single-instance = "=2\.4\.3"/);
  assert.match(native, /plugin\(tauri_plugin_single_instance::init/);
  assert.match(native, /get_webview_window\("island"\)/);
  assert.match(native, /window\.show\(\)/);
  assert.match(native, /window\.set_focus\(\)/);
  assert.match(native, /window::create_island_window\(&app\)/);
  assert.match(native, /WindowEvent::CloseRequested/);
  assert.match(native, /api\.prevent_close\(\)/);
  assert.match(native, /WindowEvent::Destroyed/);
  assert.match(native, /emit\("teti:\/\/dock-activate"/);
  assert.ok(
    native.indexOf("tauri_plugin_single_instance::init")
      < native.indexOf("tauri_plugin_opener::init"),
    "single-instance must remain the first registered Tauri plugin"
  );
});

test("Windows companion observes power, DPI, monitor, focus, and work-area changes", async () => {
  const [nativeWindow, shellWindow, platform, styles] = await Promise.all([
    readFile(new URL("../src-tauri/src/windows_native.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/platform/mod.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(nativeWindow, /WM_POWERBROADCAST/);
  assert.match(nativeWindow, /WM_CLOSE/);
  assert.match(nativeWindow, /event=window\.wm_close state=prevented/);
  assert.match(nativeWindow, /PBT_APMSUSPEND/);
  assert.match(nativeWindow, /PBT_APMRESUMEAUTOMATIC/);
  assert.match(nativeWindow, /WM_DISPLAYCHANGE \| WM_DPICHANGED \| WM_SETTINGCHANGE/);
  assert.match(nativeWindow, /GetMonitorInfoW/);
  assert.match(nativeWindow, /rcWork/);
  assert.match(shellWindow, /top_center_physical_position/);
  assert.match(shellWindow, /builder\.closable\(false\)/);
  assert.match(shellWindow, /set_focus\(\)/);
  assert.match(platform, /DesktopPlatform::Macos \| DesktopPlatform::Windows/);
  assert.match(styles, /\.teti-island\s*\{[\s\S]*?border-radius:\s*0 0 12px 12px/);
  assert.match(styles, /\.teti-island--expanded\s*\{[\s\S]*?border-radius:\s*0 0 var\(--teti-radius-island\) var\(--teti-radius-island\)/);
  assert.match(styles, /\.teti-island--expanded\s*\{[\s\S]*?border-top:\s*0/);
  assert.doesNotMatch(styles, /data-platform="windows"\]\s+\.teti-island/);
  assert.match(styles, /data-platform="windows"\]\s+\.teti-shell--collapsed\s*\{[\s\S]*?overflow:\s*hidden[\s\S]*?border-radius:\s*0 0 12px 12px/);
  assert.match(styles, /data-platform="windows"\]\s+:is\([\s\S]*?\.teti-shell--expanded[\s\S]*?overflow:\s*hidden[\s\S]*?border-radius:\s*0 0 var\(--teti-radius-island\) var\(--teti-radius-island\)/);
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

test("Windows Runtime launches its sidecar relative to the packaged resource directory", async () => {
  const bridge = await readFile(
    new URL("../src-tauri/src/lifecycle_bridge.rs", import.meta.url),
    "utf8"
  );

  assert.match(bridge, /sidecar_path\s*\.strip_prefix\(&resource_dir\)/);
  assert.match(bridge, /command\.current_dir\(&resource_dir\)\.arg\(sidecar_argument\)/);
});

test("Windows Runtime stays background-only and the tray owns reopen and clean exit", async () => {
  const [manifest, bridge, native, tray] = await Promise.all([
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lifecycle_bridge.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/windows_tray.rs", import.meta.url), "utf8")
  ]);

  assert.match(manifest, /"tray-icon"/);
  assert.match(bridge, /CREATE_NO_WINDOW/);
  assert.match(bridge, /command\.creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(native, /windows_tray::install\(app\)/);
  assert.match(tray, /TrayIconBuilder::with_id\("teti"\)/);
  assert.match(tray, /show_menu_on_left_click\(false\)/);
  assert.match(tray, /MouseButton::Left/);
  assert.match(tray, /WINDOWS_TRAY_SHOW_ID => show_island/);
  assert.match(tray, /WINDOWS_TRAY_QUIT_ID =>[\s\S]*?\.shutdown\(\);[\s\S]*?app\.exit\(0\)/);
  assert.match(tray, /platform::read_locale_preference/);
  assert.match(tray, /GetUserDefaultLocaleName/);
});

const WINDOWS_PLATFORM: DesktopPlatformInfo = {
  platform: "windows",
  architecture: "x64",
  shell: "top-center-companion",
  lifecycleRuntime: "bundled",
  supportsDockReopen: false,
  supportsNativeSleepEvents: true,
  supportsRevealInFileManager: true
};

const MACOS_PLATFORM: DesktopPlatformInfo = {
  platform: "macos",
  architecture: "arm64",
  shell: "notch-panel",
  lifecycleRuntime: "bundled",
  supportsDockReopen: true,
  supportsNativeSleepEvents: true,
  supportsRevealInFileManager: true
};

function existingAccount(): TetiAccount {
  return {
    version: 1,
    id: "teti_milo00000",
    address: "milo00000@mail.seep.im",
    displayName: "Milo",
    chatmailAccountId: 1,
    publicKey: "public-key",
    publicProfile: {
      platform: "Windows",
      category: ["developer"],
      aiEnvironment: ["Teti Desktop"]
    },
    createdAt: "2026-08-19T00:00:00.000Z"
  };
}
