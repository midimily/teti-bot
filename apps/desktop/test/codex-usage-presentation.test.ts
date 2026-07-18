import assert from "node:assert/strict";
import test from "node:test";
import {
  createShareableCodexStatus,
  normalizeCodexPlan,
  presentCodexUsage
} from "../src/codex-usage/presentation.ts";
import type { CodexUsageState } from "../src/codex-usage/types.ts";

function ready(planTypeRaw: string | null, remainingPercent = 42.4): CodexUsageState {
  return {
    status: "ready",
    snapshot: {
      source: "live",
      planTypeRaw,
      planDisplayName: "must-not-be-shared",
      membershipVerified: false,
      weekly: {
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        resetAt: "2026-07-20T00:00:00.000Z",
        windowSeconds: 604_800,
        identification: "exact"
      },
      observedAt: "2026-07-18T01:00:00.000Z",
      fetchedAt: "2026-07-18T01:00:01.000Z",
      stale: false
    }
  };
}

test("only exact known plan identifiers control the logo color", () => {
  assert.deepEqual(normalizeCodexPlan("FREE"), { key: "free", label: "Free" });
  assert.deepEqual(normalizeCodexPlan(" plus "), { key: "plus", label: "Plus" });
  assert.deepEqual(normalizeCodexPlan("pro"), { key: "pro", label: "Pro" });
  assert.equal(normalizeCodexPlan("team"), null);
  assert.equal(normalizeCodexPlan("enterprise"), null);
  assert.equal(presentCodexUsage(ready("unexpected-plan")).tone, "unknown");
});

test("distinguishes signed-out and temporary unavailable states", () => {
  const signedOut = presentCodexUsage({
    status: "unavailable",
    error: { code: "AUTH_TOKEN_MISSING", message: "safe", recoverable: true }
  });
  const offline = presentCodexUsage({
    status: "unavailable",
    error: { code: "NETWORK_UNAVAILABLE", message: "safe", recoverable: true }
  });
  assert.equal(signedOut.unavailableReason, "signed-out");
  assert.equal(offline.unavailableReason, "unavailable");
});

test("shareable data is rounded and excludes raw account and response metadata", () => {
  const shared = createShareableCodexStatus(ready("plus"));
  assert.equal(shared.plan.key, "plus");
  assert.equal(shared.plan.membershipVerified, false);
  assert.equal(shared.quotas[0].remainingPercent, 42);
  const json = JSON.stringify(shared);
  assert.doesNotMatch(json, /planDisplayName|planTypeRaw|fetchedAt|usedPercent|account|token|must-not-be-shared/);
});
