import assert from "node:assert/strict";
import test from "node:test";
import { auditCloudflareFreeRuntime } from "../scripts/check-cloudflare-free-runtime.ts";

test("Beta 0.4.0 production runtime is free of legacy Worker and provider dependencies", async () => {
  const result = await auditCloudflareFreeRuntime();

  assert.ok(result.filesScanned > 100);
  assert.deepEqual(result.violations, []);
});
