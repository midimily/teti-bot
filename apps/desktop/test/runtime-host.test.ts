import assert from "node:assert/strict";
import test from "node:test";
import {
  TetiRuntimeHost,
  type TetiRuntimeScheduledJob
} from "../lifecycle-sidecar/runtime/host.ts";

test("Runtime Host is inert until started and repeated start does not duplicate scheduling", async () => {
  const clock = fakeClock();
  let runs = 0;
  const host = new TetiRuntimeHost({
    jobs: [{ id: "registry-heartbeat", intervalMs: 300_000, run: () => { runs += 1; } }],
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  assert.equal(host.isRunning, false);
  assert.equal(clock.pending().length, 0);

  host.start();
  host.start();
  assert.equal(host.isRunning, true);
  assert.equal(runs, 0);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0]?.delayMs, 300_000);

  clock.runNext();
  await drainMicrotasks();
  assert.equal(runs, 1);
  assert.equal(clock.pending().length, 1);
  await host.stop();
});

test("Runtime Host prevents overlap and schedules the next run only after completion", async () => {
  const clock = fakeClock();
  let runs = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const host = new TetiRuntimeHost({
    jobs: [{
      id: "chatmail-poll",
      intervalMs: 3_000,
      runOnStart: true,
      async run() {
        runs += 1;
        await blocked;
      }
    }],
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  host.start();
  await drainMicrotasks();
  assert.equal(runs, 1);
  assert.equal(clock.pending().length, 0);
  assert.equal(host.runNow("chatmail-poll"), false);

  release();
  await drainMicrotasks();
  assert.equal(clock.pending().length, 1);
  assert.equal(host.snapshot.jobs[0]?.state, "scheduled");
  await host.stop();
});

test("Runtime Host isolates job failures and continues scheduling every job", async () => {
  const clock = fakeClock();
  const errors: string[] = [];
  let healthyRuns = 0;
  const jobs: TetiRuntimeScheduledJob[] = [
    {
      id: "failing-job",
      intervalMs: 1_000,
      runOnStart: true,
      async run() { throw new Error("temporary failure"); }
    },
    {
      id: "healthy-job",
      intervalMs: 2_000,
      runOnStart: true,
      run() { healthyRuns += 1; }
    }
  ];
  const host = new TetiRuntimeHost({
    jobs,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onJobError: ({ jobId }) => errors.push(jobId)
  });

  host.start();
  await drainMicrotasks();

  assert.equal(healthyRuns, 1);
  assert.deepEqual(errors, ["failing-job"]);
  assert.deepEqual(clock.pending().map((entry) => entry.delayMs).sort((a, b) => a - b), [1_000, 2_000]);
  assert.ok(host.snapshot.jobs.find((job) => job.id === "failing-job")?.lastFailedAt);
  assert.ok(host.snapshot.jobs.find((job) => job.id === "healthy-job")?.lastSucceededAt);
  await host.stop();
});

test("Runtime Host can keep account-bound jobs idle and trigger them when an account becomes available", async () => {
  const clock = fakeClock();
  let accountExists = false;
  let runs = 0;
  const host = new TetiRuntimeHost({
    jobs: [{
      id: "account-job",
      intervalMs: 60_000,
      runOnStart: true,
      shouldRun: () => accountExists,
      run: () => { runs += 1; }
    }],
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  host.start();
  await drainMicrotasks();
  assert.equal(runs, 0);
  assert.equal(clock.pending().length, 1);
  assert.ok(host.snapshot.jobs[0]?.lastSkippedAt);
  assert.equal(host.snapshot.jobs[0]?.lastSucceededAt, undefined);

  accountExists = true;
  assert.equal(host.runNow("account-job"), true);
  await drainMicrotasks();
  assert.equal(runs, 1);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.cancelled.length, 1);
  await host.stop();
});

test("Runtime Host stop cancels timers and an in-flight job cannot reschedule", async () => {
  const clock = fakeClock();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const host = new TetiRuntimeHost({
    jobs: [{ id: "long-job", intervalMs: 5_000, runOnStart: true, run: () => blocked }],
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  host.start();
  await drainMicrotasks();
  const stopping = host.stop();
  assert.equal(host.snapshot.state, "stopping");
  release();
  await stopping;

  assert.equal(host.snapshot.state, "stopped");
  assert.equal(host.snapshot.jobs[0]?.state, "idle");
  assert.equal(clock.pending().length, 0);
});

test("Runtime Host rejects ambiguous job registrations before startup", () => {
  assert.throws(
    () => new TetiRuntimeHost({
      jobs: [
        { id: "duplicate", intervalMs: 1_000, run() {} },
        { id: "duplicate", intervalMs: 2_000, run() {} }
      ]
    }),
    /Duplicate Teti Runtime job ID/
  );
  assert.throws(
    () => new TetiRuntimeHost({ jobs: [{ id: "invalid", intervalMs: 0, run() {} }] }),
    /positive interval/
  );
});

function fakeClock() {
  let nextHandle = 1;
  const entries: Array<{
    callback: () => void;
    delayMs: number;
    handle: number;
    cancelled: boolean;
    fired: boolean;
  }> = [];
  const cancelled: unknown[] = [];

  return {
    cancelled,
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, handle: nextHandle++, cancelled: false, fired: false };
      entries.push(entry);
      return entry.handle;
    },
    cancel(handle: unknown) {
      cancelled.push(handle);
      const entry = entries.find((candidate) => candidate.handle === handle);
      if (entry) entry.cancelled = true;
    },
    pending() {
      return entries.filter((entry) => !entry.cancelled && !entry.fired);
    },
    runNext() {
      const entry = entries.find((candidate) => !candidate.cancelled && !candidate.fired);
      if (!entry) throw new Error("No scheduled callback is available.");
      entry.fired = true;
      entry.callback();
    }
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
