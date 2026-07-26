import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApp } from "../src/app.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { bootstrapDesktopApp } from "../src/startup.ts";

test("Desktop bootstrap expands a visible error panel when lifecycle startup fails", async () => {
  const tauri = new RecordingTauriInvoker();
  let renderedFailure = 0;
  const app = await bootstrapDesktopApp({
    root: {} as HTMLElement,
    env: {},
    createTauri: async () => tauri,
    createApp: async () => { throw new Error("lifecycle health timed out"); },
    renderFailure: () => { renderedFailure += 1; }
  });

  assert.equal(app, null);
  assert.equal(renderedFailure, 1);
  assert.deepEqual(tauri.calls, [{
    command: "set_island_mode",
    args: { mode: "error", reason: "startup-failed" }
  }]);
});

test("Desktop bootstrap returns the initialized App without invoking its failure path", async () => {
  const tauri = new RecordingTauriInvoker();
  const expected = fakeDesktopApp();
  let renderedFailure = 0;
  const app = await bootstrapDesktopApp({
    root: {} as HTMLElement,
    env: {},
    createTauri: async () => tauri,
    createApp: async () => expected,
    renderFailure: () => { renderedFailure += 1; }
  });

  assert.equal(app, expected);
  assert.equal(renderedFailure, 0);
  assert.deepEqual(tauri.calls, []);
});

function fakeDesktopApp(): DesktopApp {
  return {
    coordinator: {} as DesktopApp["coordinator"],
    connections: {} as DesktopApp["connections"],
    passport: {} as DesktopApp["passport"],
    config: { mode: "real", mockScenario: "success", delayMs: 0 },
    render() {},
    dispose() {}
  };
}
