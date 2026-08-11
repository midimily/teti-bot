import assert from "node:assert/strict";
import test from "node:test";
import type { LocalReleaseStatus } from "../../../core/release/policy.ts";
import {
  ReleaseController,
  type ReleaseStatusClient
} from "../src/release/controller.ts";

test("Release polling ignores checkedAt-only churn but renders semantic changes", async () => {
  let status = supported("2026-08-11T00:00:00.000Z");
  let scheduled: (() => void) | undefined;
  let changes = 0;
  const controller = new ReleaseController({
    client: { async getStatus() { return structuredClone(status); } } satisfies ReleaseStatusClient,
    onChange: () => { changes += 1; },
    schedule(callback, delayMs) {
      assert.equal(delayMs, 5_000);
      scheduled = callback;
      return 1;
    },
    cancel: () => undefined
  });

  await controller.start();
  assert.equal(changes, 1, "checking to supported is visible");

  status = supported("2026-08-11T00:00:05.000Z");
  scheduled?.();
  await flushPromises();
  assert.equal(changes, 1, "a fresh observation timestamp must not replace the Desktop DOM");

  status = { ...status, state: "update_required", minimumSupportedVersion: "0.3.7" };
  scheduled?.();
  await flushPromises();
  assert.equal(changes, 2, "a release policy state change remains visible");
  controller.stop();
});

function supported(checkedAt: string): LocalReleaseStatus {
  return {
    schemaVersion: 1,
    state: "supported",
    currentVersion: "0.3.6",
    buildTimestamp: "2026-08-11T00:00:00.000Z",
    source: "network",
    checkedAt,
    minimumSupportedVersion: "0.3.6",
    policyVersion: 1,
    effectiveAt: "2026-08-11T00:00:00.000Z"
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
