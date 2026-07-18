import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_HEARTBEAT_INTERVAL_MS,
  DiscoveryHeartbeatController
} from "../src/discovery/heartbeat.ts";

test("discovery heartbeat runs immediately and then every five minutes without overlap", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number; handle: number }> = [];
  const cancelled: unknown[] = [];
  let calls = 0;
  const controller = new DiscoveryHeartbeatController({
    client: { async heartbeat() { calls += 1; } },
    schedule(callback, delayMs) {
      const entry = { callback, delayMs, handle: scheduled.length + 1 };
      scheduled.push(entry);
      return entry.handle;
    },
    cancel: (handle) => cancelled.push(handle)
  });

  controller.start();
  controller.start();
  await drainMicrotasks();

  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, DISCOVERY_HEARTBEAT_INTERVAL_MS);

  scheduled[0].callback();
  await drainMicrotasks();
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 2);

  controller.stop();
  assert.deepEqual(cancelled, [scheduled[1].handle]);
});

test("discovery heartbeat keeps retrying after a transient registry failure", async () => {
  const scheduled: Array<() => void> = [];
  let calls = 0;
  let failures = 0;
  const controller = new DiscoveryHeartbeatController({
    client: {
      async heartbeat() {
        calls += 1;
        throw new Error("registry temporarily unavailable");
      }
    },
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => undefined,
    onFailure: () => { failures += 1; }
  });

  controller.start();
  await drainMicrotasks();

  assert.equal(calls, 1);
  assert.equal(failures, 1);
  assert.equal(scheduled.length, 1);
});

test("stopping discovery heartbeat cancels the timer and prevents an in-flight call from rescheduling", async () => {
  let resolveHeartbeat: (() => void) | undefined;
  const heartbeat = new Promise<void>((resolve) => { resolveHeartbeat = resolve; });
  const scheduled: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const controller = new DiscoveryHeartbeatController({
    client: { heartbeat: () => heartbeat },
    schedule(callback) {
      scheduled.push(callback);
      return "heartbeat-timer";
    },
    cancel: (handle) => cancelled.push(handle)
  });

  controller.start();
  controller.stop();
  resolveHeartbeat?.();
  await drainMicrotasks();

  assert.equal(controller.isRunning, false);
  assert.equal(scheduled.length, 0);
  assert.deepEqual(cancelled, []);
});

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
