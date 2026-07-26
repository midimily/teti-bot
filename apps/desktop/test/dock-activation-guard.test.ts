import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCK_ACTIVATION_COALESCE_MS,
  DOCK_ACTIVATION_FOCUS_GUARD_MS,
  DockActivationGuard
} from "../src/platform/dock-activation-guard.ts";

test("Dock activation coalesces a double click and protects the resulting focus transition", () => {
  let now = 1_000;
  const guard = new DockActivationGuard(() => now);

  assert.equal(guard.begin(), true);
  now += DOCK_ACTIVATION_COALESCE_MS - 1;
  assert.equal(guard.begin(), false);
  assert.equal(guard.shouldIgnoreFocusLoss(), true);

  now += DOCK_ACTIVATION_FOCUS_GUARD_MS + 1;
  assert.equal(guard.shouldIgnoreFocusLoss(), false);
});

test("a later Dock activation starts a new surface-open transaction", () => {
  let now = 2_000;
  const guard = new DockActivationGuard(() => now);

  assert.equal(guard.begin(), true);
  now += DOCK_ACTIVATION_COALESCE_MS + 1;
  assert.equal(guard.begin(), true);
});
