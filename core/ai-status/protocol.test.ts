import assert from "node:assert/strict";
import test from "node:test";
import { validateAiStatusSyncPayload } from "./protocol.ts";

function enabledPayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sharing: "enabled",
    generatedAt: "2026-07-18T01:00:00.000Z",
    expiresAt: "2026-07-18T01:30:00.000Z",
    tools: [{
      toolId: "openai.codex",
      status: "ready",
      plan: { key: "plus", membershipVerified: false },
      quotas: [{
        period: "week",
        remainingPercent: 42,
        resetAt: "2026-07-20T00:00:00.000Z",
        windowSeconds: 604_800,
        identification: "exact"
      }],
      observedAt: "2026-07-18T00:59:00.000Z"
    }]
  };
}

test("accepts an extensible, privacy-minimized AI status payload", () => {
  assert.doesNotThrow(() => validateAiStatusSyncPayload(enabledPayload()));
  assert.doesNotThrow(() => validateAiStatusSyncPayload({
    schemaVersion: 1,
    sharing: "disabled",
    generatedAt: "2026-07-18T01:00:00.000Z",
    expiresAt: "2026-07-18T01:30:00.000Z",
    tools: []
  }));
});

test("rejects fields that could smuggle account or credential data", () => {
  const withToken = enabledPayload();
  (withToken.tools as Array<Record<string, unknown>>)[0].token = "secret";
  assert.throws(() => validateAiStatusSyncPayload(withToken), /unsupported field/);

  const withAccount = enabledPayload();
  (withAccount.tools as Array<Record<string, unknown>>)[0].plan = {
    key: "plus",
    membershipVerified: false,
    accountId: "private@example.com"
  };
  assert.throws(() => validateAiStatusSyncPayload(withAccount), /unsupported field/);

  const accountInPlan = enabledPayload();
  (accountInPlan.tools as Array<Record<string, unknown>>)[0].plan = {
    key: "private@example.com",
    membershipVerified: false
  };
  assert.throws(() => validateAiStatusSyncPayload(accountInPlan), /plan key is invalid/);
});

test("rejects invalid quota bounds, expiry, and non-empty revocations", () => {
  const invalidQuota = enabledPayload();
  const tool = (invalidQuota.tools as Array<Record<string, unknown>>)[0];
  (tool.quotas as Array<Record<string, unknown>>)[0].remainingPercent = 101;
  assert.throws(() => validateAiStatusSyncPayload(invalidQuota), /remainingPercent/);

  const invalidExpiry = enabledPayload();
  invalidExpiry.expiresAt = invalidExpiry.generatedAt;
  assert.throws(() => validateAiStatusSyncPayload(invalidExpiry), /after generatedAt/);

  const excessiveTtl = enabledPayload();
  excessiveTtl.expiresAt = "2026-07-19T01:00:01.000Z";
  assert.throws(() => validateAiStatusSyncPayload(excessiveTtl), /allowed TTL/);

  const invalidRevocation = enabledPayload();
  invalidRevocation.sharing = "disabled";
  assert.throws(() => validateAiStatusSyncPayload(invalidRevocation), /cannot contain tools/);
});
