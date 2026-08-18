import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("Windows uses the shared font stack and WebView2 layout fallbacks", async () => {
  const css = await source("../src/styles.css");
  assert.match(css, /:root\[data-platform="windows"\][\s\S]*"Segoe UI Variable"/);
  assert.match(css, /"Segoe UI"/);
  assert.match(css, /"Microsoft YaHei UI"/);
  assert.match(css, /"Microsoft YaHei"/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@supports not \(\(backdrop-filter:/);
  assert.match(css, /select,[\s\S]*textarea[\s\S]*font:\s*inherit/);
});

test("shared UI exposes keyboard focus, high contrast, and reduced-motion semantics", async () => {
  const css = await source("../src/styles.css");
  assert.match(css, /:where\(button, input, select, textarea, a\[href\]\):focus-visible/);
  assert.match(css, /@media \(forced-colors:\s*active\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*scroll-behavior:\s*auto !important/);

  const passportView = await source("../src/passport/view.ts");
  assert.match(passportView, /panel\.setAttribute\("aria-labelledby", "teti-ai-passport-panel-title"\)/);
  assert.match(passportView, /panel\.setAttribute\("aria-labelledby", "teti-passport-settings-panel-title"\)/);
  assert.match(passportView, /error\.setAttribute\("role", "alert"\)/);

  const app = await source("../src/app.ts");
  assert.match(app, /button\.setAttribute\("aria-controls", panel\.id\)/);
  assert.match(app, /face\.disabled = \["opening", "connecting", "closing"\]/);
  assert.match(app, /panel\.setAttribute\("aria-busy", String\(state === "connecting"\)\)/);

  const tasks = await source("../src/tasks/view.ts");
  assert.match(tasks, /heading\.setAttribute\("aria-level", "1"\)/);
  assert.match(tasks, /status\.setAttribute\("aria-live", "polite"\)/);
  assert.match(tasks, /error\.setAttribute\("role", "alert"\)/);
});

test("Windows reuses the two shared catalogs and stable semantic native errors", async () => {
  const localeDirectory = new URL("../src/i18n/locales/", import.meta.url);
  const catalogs = (await readdir(localeDirectory))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  assert.deepEqual(catalogs, ["en.ts", "zh-hans.ts"]);

  const windowsSources = await Promise.all([
    source("../src-tauri/src/windows_native.rs"),
    source("../src-tauri/src/windows_job.rs"),
    source("../src-tauri/src/platform/windows_security.rs")
  ]);
  for (const windowsSource of windowsSources) {
    assert.doesNotMatch(windowsSource, /\p{Script=Han}/u);
  }

  const windowCommands = await source("../src-tauri/src/window.rs");
  const nativeCommands = await source("../src-tauri/src/lib.rs");
  assert.match(windowCommands, /NATIVE_WINDOW_REASON_INVALID/);
  assert.match(windowCommands, /NATIVE_WINDOW_UNAVAILABLE/);
  assert.match(nativeCommands, /LOCAL_PROFILE_TARGET_INVALID/);
  assert.match(nativeCommands, /TASK_RESULT_IMAGE_OUTSIDE_SCOPE/);
  assert.doesNotMatch(`${windowCommands}\n${nativeCommands}`, /NativeCommandError::new\("(?:WINDOWS|WIN32)_/);
});
