import assert from "node:assert/strict";
import test from "node:test";
import { validateAiStatusSyncPayload } from "../../../core/ai-status/protocol.ts";
import {
  DEFAULT_PASSPORT_SHARING_POLICY
} from "../../../core/passport/types.ts";
import { createShareableCodexStatus } from "../src/codex-usage/presentation.ts";
import type { CodexUsageState } from "../src/codex-usage/types.ts";
import {
  mapCodexUsageResource,
  mapRemoteAiStatus
} from "../lifecycle-sidecar/runtime/passport/mappers.ts";

const OBSERVED_AT = "2026-07-25T00:00:00.000Z";

test("legacy AI Status and Passport retain the characterized Codex field mapping", () => {
  const state = readyUsage();
  const legacyTool = createShareableCodexStatus(state, new Date(OBSERVED_AT));
  assert.deepEqual(legacyTool, {
    toolId: "openai.codex",
    status: "ready",
    plan: { key: "plus", membershipVerified: false },
    quotas: [{
      period: "week",
      remainingPercent: 42,
      resetAt: "2026-07-26T00:00:00.000Z",
      windowSeconds: 604_800,
      identification: "exact"
    }],
    observedAt: OBSERVED_AT
  });

  const resource = mapCodexUsageResource(state, OBSERVED_AT);
  assert.equal(resource.id, legacyTool.toolId);
  assert.equal(resource.plan?.key, legacyTool.plan.key);
  assert.deepEqual(resource.quotas, legacyTool.quotas);
  assert.equal(resource.availability, "available");
});

test("legacy teti.ai.status.sync payload remains valid and Agent discovery is not shared by default", () => {
  const generatedAt = "2026-07-25T00:00:00.000Z";
  const payload = {
    schemaVersion: 1 as const,
    sharing: "enabled" as const,
    generatedAt,
    expiresAt: "2026-07-25T00:30:00.000Z",
    tools: [createShareableCodexStatus(readyUsage(), new Date(generatedAt))]
  };
  assert.doesNotThrow(() => validateAiStatusSyncPayload(payload));
  const mapped = mapRemoteAiStatus({ ...payload, receivedAt: generatedAt }, new Date(generatedAt));
  assert.equal(mapped.state, "fresh");
  assert.equal(mapped.resources[0]?.product, "Codex");
  assert.equal(DEFAULT_PASSPORT_SHARING_POLICY.agents, false);
  assert.equal(DEFAULT_PASSPORT_SHARING_POLICY.capabilities, false);
});

function readyUsage(): CodexUsageState {
  return {
    status: "ready",
    snapshot: {
      source: "live",
      planTypeRaw: "plus",
      planDisplayName: null,
      membershipVerified: false,
      weekly: {
        remainingPercent: 42,
        usedPercent: 58,
        resetAt: "2026-07-26T00:00:00.000Z",
        windowSeconds: 604_800,
        identification: "exact"
      },
      observedAt: OBSERVED_AT,
      fetchedAt: OBSERVED_AT,
      stale: false
    }
  };
}
