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

test("focus loss during the Dock guard is reconciled once after the latest activation", () => {
  let now = 1_000;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let reconciliations = 0;
  const guard = new DockActivationGuard(() => now);
  const schedule = (callback: () => void, delayMs: number) => {
    scheduled.push({ callback, delayMs });
  };

  guard.begin();
  const first = guard.deferFocusLoss(schedule, () => {
    reconciliations += 1;
  });
  const repeated = guard.deferFocusLoss(schedule, () => {
    reconciliations += 1;
  });

  assert.deepEqual(first, { state: "scheduled", delayMs: DOCK_ACTIVATION_FOCUS_GUARD_MS + 1 });
  assert.deepEqual(repeated, { state: "pending", delayMs: DOCK_ACTIVATION_FOCUS_GUARD_MS + 1 });
  assert.equal(scheduled.length, 1);

  now += DOCK_ACTIVATION_FOCUS_GUARD_MS + 1;
  scheduled[0]?.callback();
  assert.equal(reconciliations, 1);
});

test("regaining focus cancels a deferred Dock focus reconciliation", () => {
  let now = 2_000;
  const scheduled: Array<() => void> = [];
  let reconciliations = 0;
  const guard = new DockActivationGuard(() => now);

  guard.begin();
  guard.deferFocusLoss((callback) => scheduled.push(callback), () => {
    reconciliations += 1;
  });

  assert.equal(guard.cancelPendingFocusLoss(), true);
  now += DOCK_ACTIVATION_FOCUS_GUARD_MS + 1;
  scheduled[0]?.();
  assert.equal(reconciliations, 0);
  assert.equal(guard.cancelPendingFocusLoss(), false);
});

test("a repeated Dock activation extends deferred focus protection without duplicating recovery", () => {
  let now = 3_000;
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let reconciliations = 0;
  const guard = new DockActivationGuard(() => now);
  const schedule = (callback: () => void, delayMs: number) => {
    scheduled.push({ callback, delayMs });
  };

  guard.begin();
  guard.deferFocusLoss(schedule, () => {
    reconciliations += 1;
  });
  now += DOCK_ACTIVATION_COALESCE_MS - 1;
  assert.equal(guard.begin(), false);

  now = 3_000 + DOCK_ACTIVATION_FOCUS_GUARD_MS + 1;
  scheduled[0]?.callback();
  assert.equal(reconciliations, 0);
  assert.equal(scheduled.length, 2);

  now = 3_000 + DOCK_ACTIVATION_COALESCE_MS - 1 + DOCK_ACTIVATION_FOCUS_GUARD_MS + 1;
  scheduled[1]?.callback();
  assert.equal(reconciliations, 1);
});

test("a later Dock activation starts a new surface-open transaction", () => {
  let now = 2_000;
  const guard = new DockActivationGuard(() => now);

  assert.equal(guard.begin(), true);
  now += DOCK_ACTIVATION_COALESCE_MS + 1;
  assert.equal(guard.begin(), true);
});
