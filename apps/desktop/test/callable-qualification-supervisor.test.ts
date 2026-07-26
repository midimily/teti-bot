import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CallableQualificationSupervisor } from "../lifecycle-sidecar/runtime/callable/qualification-supervisor.ts";

test("slow and failing qualifications start in the background and stay isolated", async () => {
  let releaseSlow: (() => void) | undefined;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let slowStarted = false;
  let healthyFinished = false;
  const failures: number[] = [];
  const supervisor = new CallableQualificationSupervisor({
    jobs: [
      async () => {
        slowStarted = true;
        await slowGate;
        healthyFinished = true;
      },
      async () => { throw new Error("damaged local Agent"); }
    ],
    onJobError: ({ index }) => failures.push(index)
  });

  supervisor.start();
  assert.equal(slowStarted, true);
  assert.equal(healthyFinished, false);
  await waitFor(() => failures.length === 1);
  assert.deepEqual(failures, [1]);

  releaseSlow?.();
  await waitFor(() => healthyFinished);
  await supervisor.stop();
});

test("qualification shutdown aborts an in-flight local probe", async () => {
  let observedAbort = false;
  const supervisor = new CallableQualificationSupervisor({
    jobs: [
      (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      })
    ]
  });

  supervisor.start();
  await supervisor.stop();
  assert.equal(observedAbort, true);
});

test("sidecar opens lifecycle input before background Adapter qualification", async () => {
  const source = await readFile(new URL("../lifecycle-sidecar/main.ts", import.meta.url), "utf8");
  const readerReady = source.indexOf('reader.on("line"');
  const qualificationsStart = source.indexOf("qualificationSupervisor.start()");

  assert.ok(readerReady >= 0);
  assert.ok(qualificationsStart > readerReady);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for test state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
