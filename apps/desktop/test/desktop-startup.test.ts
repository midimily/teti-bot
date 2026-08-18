import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApp, DesktopAppOptions } from "../src/app.ts";
import { createDesktopI18n } from "../src/i18n/index.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import type { DesktopPlatformInfo } from "../src/platform/contract.ts";
import { bootstrapDesktopApp } from "../src/startup.ts";

test("Desktop bootstrap expands a visible error panel when lifecycle startup fails", async () => {
  const tauri = new RecordingTauriInvoker();
  tauri.responses.set("desktop_platform_info", MACOS_PLATFORM);
  const { root, documentElement } = startupRoot();
  const i18n = createDesktopI18n("zh-Hans");
  let renderedFailure = 0;
  const app = await bootstrapDesktopApp({
    root,
    env: {},
    i18n,
    createTauri: async () => tauri,
    createApp: async () => { throw new Error("lifecycle health timed out"); },
    renderFailure: () => { renderedFailure += 1; }
  });

  assert.equal(app, null);
  assert.equal(renderedFailure, 1);
  assert.equal(documentElement.lang, "zh-Hans");
  assert.equal(documentElement.dir, "ltr");
  assert.deepEqual(tauri.calls, [
    { command: "desktop_platform_info", args: undefined },
    {
      command: "set_island_mode",
      args: { mode: "error", reason: "startup-failed" }
    }
  ]);
});

test("Desktop bootstrap returns the initialized App without invoking its failure path", async () => {
  const tauri = new RecordingTauriInvoker();
  tauri.responses.set("desktop_platform_info", WINDOWS_PLATFORM);
  const { root, documentElement } = startupRoot();
  const i18n = createDesktopI18n("en");
  const expected = fakeDesktopApp(i18n);
  let receivedOptions: DesktopAppOptions | undefined;
  let renderedFailure = 0;
  const app = await bootstrapDesktopApp({
    root,
    env: {},
    i18n,
    createTauri: async () => tauri,
    createApp: async (options) => {
      receivedOptions = options;
      return expected;
    },
    renderFailure: () => { renderedFailure += 1; }
  });

  assert.equal(app, expected);
  assert.equal(renderedFailure, 0);
  assert.deepEqual(tauri.calls, [{ command: "desktop_platform_info", args: undefined }]);
  assert.equal(receivedOptions!.i18n, i18n);
  assert.equal(receivedOptions!.platform, WINDOWS_PLATFORM);
  assert.equal(documentElement.dataset.platform, "windows");
  assert.equal(documentElement.dataset.desktopShell, "top-center-companion");
  assert.equal(documentElement.dataset.lifecycleRuntime, "mock");
  assert.equal(documentElement.lang, "en");
  assert.equal(documentElement.dir, "ltr");
});

function startupRoot(): {
  root: HTMLElement;
  documentElement: { lang: string; dir: string; dataset: Record<string, string> };
} {
  const documentElement = { lang: "", dir: "", dataset: {} };
  return {
    root: { ownerDocument: { documentElement } } as unknown as HTMLElement,
    documentElement
  };
}

function fakeDesktopApp(i18n: DesktopApp["i18n"]): DesktopApp {
  return {
    i18n,
    platform: MACOS_PLATFORM,
    coordinator: {} as DesktopApp["coordinator"],
    connections: {} as DesktopApp["connections"],
    passport: {} as DesktopApp["passport"],
    tasks: {} as DesktopApp["tasks"],
    memory: {} as DesktopApp["memory"],
    release: {} as DesktopApp["release"],
    config: { mode: "real", mockScenario: "success", delayMs: 0 },
    render() {},
    dispose() {}
  };
}

const MACOS_PLATFORM: DesktopPlatformInfo = {
  platform: "macos",
  architecture: "arm64",
  shell: "notch-panel",
  lifecycleRuntime: "bundled",
  supportsDockReopen: true,
  supportsNativeSleepEvents: true,
  supportsRevealInFileManager: true
};

const WINDOWS_PLATFORM: DesktopPlatformInfo = {
  platform: "windows",
  architecture: "x64",
  shell: "top-center-companion",
  lifecycleRuntime: "mock",
  supportsDockReopen: false,
  supportsNativeSleepEvents: false,
  supportsRevealInFileManager: false
};
