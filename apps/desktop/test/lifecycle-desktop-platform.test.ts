import assert from "node:assert/strict";
import test from "node:test";
import { resolveLifecycleDesktopPlatform } from "../lifecycle-sidecar/desktop-platform.ts";

test("lifecycle desktop platform maps native hosts to stable Network identity fields", () => {
  assert.equal(resolveLifecycleDesktopPlatform({}, "darwin"), "macos");
  assert.equal(resolveLifecycleDesktopPlatform({}, "win32"), "windows");
  assert.equal(resolveLifecycleDesktopPlatform({ TETI_DESKTOP_PLATFORM: "windows" }, "win32"), "windows");
});

test("lifecycle desktop platform rejects mismatched or unsupported native shells", () => {
  assert.throws(
    () => resolveLifecycleDesktopPlatform({ TETI_DESKTOP_PLATFORM: "macos" }, "win32"),
    /does not match/
  );
  assert.throws(() => resolveLifecycleDesktopPlatform({}, "linux"), /supports macOS and Windows/);
});
