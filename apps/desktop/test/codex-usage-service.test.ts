import assert from "node:assert/strict";
import test from "node:test";
import type { CodexUsageSnapshot } from "../src/codex-usage/types.ts";
import { CodexUsageError } from "../lifecycle-sidecar/codex-usage/errors.ts";
import {
  CODEX_USAGE_REFRESH_INTERVAL_MS,
  CodexUsageService
} from "../lifecycle-sidecar/codex-usage/service.ts";

test("start refreshes immediately, repeats after ten minutes, and repeated start adds no timer", async () => {
  const clock = fakeClock();
  let calls = 0;
  const service = new CodexUsageService({
    provider: { async fetchUsage() { calls += 1; return snapshot(50); } },
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  service.start();
  service.start();
  await drain();
  assert.equal(calls, 1);
  assert.equal(clock.scheduled.length, 1);
  assert.equal(clock.scheduled[0].delayMs, CODEX_USAGE_REFRESH_INTERVAL_MS);

  clock.scheduled[0].callback();
  await drain();
  assert.equal(calls, 2);
  assert.equal(clock.scheduled.length, 2);
});

test("stop cancels the timer and an in-flight refresh cannot schedule after stop", async () => {
  const clock = fakeClock();
  let resolveFetch: ((value: CodexUsageSnapshot) => void) | undefined;
  const service = new CodexUsageService({
    provider: { fetchUsage: () => new Promise((resolve) => { resolveFetch = resolve; }) },
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  service.start();
  service.stop();
  resolveFetch?.(snapshot(55));
  await drain();
  assert.equal(service.isRunning, false);
  assert.equal(clock.scheduled.length, 0);

  service.start();
  resolveFetch?.(snapshot(55));
  await drain();
  service.stop();
  assert.deepEqual(clock.cancelled, [clock.scheduled[0]?.handle]);
});

test("a failed refresh preserves the last snapshot and marks it stale instead of zeroing it", async () => {
  let calls = 0;
  const service = new CodexUsageService({
    provider: {
      async fetchUsage() {
        calls += 1;
        if (calls === 1) return snapshot(37);
        throw new CodexUsageError("HTTP_SERVER_ERROR", { httpStatus: 500 });
      }
    }
  });

  const ready = await service.refreshNow();
  const stale = await service.refreshNow();
  assert.equal(ready.status, "ready");
  assert.equal(stale.status, "stale");
  assert.equal(stale.status === "stale" && stale.snapshot.weekly?.remainingPercent, 37);
  assert.equal(stale.status === "stale" && stale.snapshot.stale, true);
  assert.equal(stale.status === "stale" && stale.error.code, "HTTP_SERVER_ERROR");
});

test("a first failure is unavailable and does not fabricate a snapshot", async () => {
  const service = new CodexUsageService({
    provider: { async fetchUsage() { throw new CodexUsageError("AUTH_FILE_NOT_FOUND"); } }
  });
  const state = await service.refreshNow();
  assert.deepEqual(state, {
    status: "unavailable",
    error: {
      code: "AUTH_FILE_NOT_FOUND",
      message: "Codex authentication is not available on this Mac.",
      recoverable: true
    }
  });
});

test("concurrent refreshNow calls reuse one promise and issue one provider request", async () => {
  let calls = 0;
  let resolveFetch: ((value: CodexUsageSnapshot) => void) | undefined;
  const service = new CodexUsageService({
    provider: {
      fetchUsage() {
        calls += 1;
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
    }
  });

  const first = service.refreshNow();
  const second = service.refreshNow();
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolveFetch?.(snapshot(64));
  assert.equal((await first).status, "ready");
});

test("subscribers receive safe state updates and can unsubscribe", async () => {
  const received: number[] = [];
  const service = new CodexUsageService({ provider: { async fetchUsage() { return snapshot(71); } } });
  const unsubscribe = service.subscribe((state) => {
    if (state.status === "ready") received.push(state.snapshot.weekly?.remainingPercent ?? -1);
  });
  await service.refreshNow();
  unsubscribe();
  await service.refreshNow();
  assert.deepEqual(received, [71]);
});

function snapshot(remainingPercent: number): CodexUsageSnapshot {
  return {
    source: "live",
    planTypeRaw: "plus",
    planDisplayName: null,
    membershipVerified: false,
    weekly: {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetAt: "2026-07-25T00:00:00.000Z",
      windowSeconds: 604_800,
      identification: "exact"
    },
    observedAt: "2026-07-18T00:00:00.000Z",
    fetchedAt: "2026-07-18T00:00:00.000Z",
    stale: false
  };
}

function fakeClock() {
  const scheduled: Array<{ callback: () => void; delayMs: number; handle: number }> = [];
  const cancelled: unknown[] = [];
  return {
    scheduled,
    cancelled,
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, handle: scheduled.length + 1 };
      scheduled.push(entry);
      return entry.handle;
    },
    cancel(handle: unknown) { cancelled.push(handle); }
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
