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

function passportPayload(): Record<string, unknown> {
  return {
    ...enabledPayload(),
    schemaVersion: 2,
    agents: [{
      agentId: "codex",
      name: "Codex",
      provider: "openai",
      type: "cli",
      surfaces: ["cli"],
      installationStatus: "installed",
      detectionSource: "command",
      version: "codex-cli 1.2.3",
      runtimeStatus: "running",
      processCount: 1,
      confidence: "high",
      lastSeenAt: "2026-07-18T00:59:00.000Z",
      observedAt: "2026-07-18T00:59:00.000Z"
    }]
  };
}

function callablePassportPayload(): Record<string, unknown> {
  return {
    ...enabledPayload(),
    schemaVersion: 3,
    agents: [{
      id: "codex",
      name: "Codex",
      provider: "OpenAI",
      capabilityIds: ["code-analysis"],
      inputModes: ["text"],
      outputModes: ["text"],
      availability: "available",
      observedAt: "2026-07-18T00:59:00.000Z"
    }],
    capabilities: [{
      id: "code-analysis",
      name: "Code analysis",
      category: "coding",
      description: "Analyze code through a locally qualified AI Agent.",
      availability: "available",
      observedAt: "2026-07-18T00:59:00.000Z"
    }],
    bindings: [{
      capabilityId: "code-analysis",
      agentIds: ["codex"],
      resourceIds: []
    }]
  };
}

function computePassportPayload(): Record<string, unknown> {
  return {
    ...callablePassportPayload(),
    schemaVersion: 4,
    agents: [{
      id: "osaurus-runtime",
      name: "Osaurus Runtime (Bonsai)",
      provider: "Osaurus",
      capabilityIds: ["general-text-assistance"],
      inputModes: ["text"],
      outputModes: ["text"],
      availability: "available",
      observedAt: "2026-07-18T00:59:00.000Z"
    }],
    capabilities: [{
      id: "general-text-assistance",
      name: "General text assistance",
      category: "language",
      description: "Use receiver-local compute for tool-free general text assistance.",
      availability: "available",
      observedAt: "2026-07-18T00:59:00.000Z"
    }],
    bindings: [{
      capabilityId: "general-text-assistance",
      agentIds: ["osaurus-runtime"],
      resourceIds: []
    }],
    computeOffers: [{
      offerId: "local.compute.general-text-assistance.v1",
      capability: "general-text-assistance",
      resourceClass: "local_model",
      executionLocation: "receiver_local",
      inputModes: ["text"],
      outputModes: ["text"],
      concurrency: 1,
      approval: "allow_once",
      observedAt: "2026-07-18T00:59:00.000Z"
    }]
  };
}

test("accepts legacy resource payloads and current privacy-minimized Passport payloads", () => {
  assert.doesNotThrow(() => validateAiStatusSyncPayload(enabledPayload()));
  assert.doesNotThrow(() => validateAiStatusSyncPayload(passportPayload()));
  const boundedCustomAgent = passportPayload();
  (boundedCustomAgent.agents as Array<Record<string, unknown>>)[0].agentId =
    `user.${"a".repeat(59)}`;
  (boundedCustomAgent.agents as Array<Record<string, unknown>>)[0].provider = "p".repeat(64);
  assert.doesNotThrow(() => validateAiStatusSyncPayload(boundedCustomAgent));
  assert.doesNotThrow(() => validateAiStatusSyncPayload({
    schemaVersion: 2,
    sharing: "disabled",
    generatedAt: "2026-07-18T01:00:00.000Z",
    expiresAt: "2026-07-18T01:30:00.000Z",
    tools: [],
    agents: []
  }));
});

test("accepts Callable Passport and rejects observation or execution fields", () => {
  assert.doesNotThrow(() => validateAiStatusSyncPayload(callablePassportPayload()));
  assert.doesNotThrow(() => validateAiStatusSyncPayload(computePassportPayload()));

  const withProcess = callablePassportPayload();
  (withProcess.agents as Array<Record<string, unknown>>)[0].runtimeStatus = "running";
  assert.throws(() => validateAiStatusSyncPayload(withProcess), /unsupported field/);

  const withEntrypoint = callablePassportPayload();
  (withEntrypoint.agents as Array<Record<string, unknown>>)[0].entrypoint = "/usr/bin/codex";
  assert.throws(() => validateAiStatusSyncPayload(withEntrypoint), /unsupported field/);

  const brokenBinding = callablePassportPayload();
  (brokenBinding.bindings as Array<Record<string, unknown>>)[0].agentIds = ["claude-code"];
  assert.throws(() => validateAiStatusSyncPayload(brokenBinding), /references are invalid/);
});

test("Compute Offers are exact, receiver-local, allow-once, and privacy minimized", () => {
  assert.doesNotThrow(() => validateAiStatusSyncPayload(computePassportPayload()));
  const native = computePassportPayload();
  (native.computeOffers as Array<Record<string, unknown>>)[0]!.resourceClass = "native_agent";
  assert.doesNotThrow(() => validateAiStatusSyncPayload(native));
  for (const field of ["bonsaiPath", "osaurusPort", "hardware", "credential", "model", "agentConfig"]) {
    const payload = computePassportPayload();
    (payload.computeOffers as Array<Record<string, unknown>>)[0]![field] = "private";
    assert.throws(() => validateAiStatusSyncPayload(payload), /unsupported field/);
  }
  for (const [field, value] of [
    ["concurrency", 2],
    ["approval", "always"],
    ["executionLocation", "requester_local"],
    ["inputModes", ["text", "image"]]
  ] as const) {
    const payload = computePassportPayload();
    (payload.computeOffers as Array<Record<string, unknown>>)[0]![field] = value;
    assert.throws(() => validateAiStatusSyncPayload(payload), /contract is invalid/);
  }
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

  const withPrompt = passportPayload();
  (withPrompt.agents as Array<Record<string, unknown>>)[0].prompt = "private";
  assert.throws(() => validateAiStatusSyncPayload(withPrompt), /unsupported field/);

  const withPath = passportPayload();
  (withPath.agents as Array<Record<string, unknown>>)[0].version = "/Users/private/Codex 1.2.3";
  assert.throws(() => validateAiStatusSyncPayload(withPath), /version is invalid/);
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

  const invalidAgentRevocation = passportPayload();
  invalidAgentRevocation.sharing = "disabled";
  invalidAgentRevocation.tools = [];
  assert.throws(() => validateAiStatusSyncPayload(invalidAgentRevocation), /cannot contain agents/);

  const invalidCallableRevocation = callablePassportPayload();
  invalidCallableRevocation.sharing = "disabled";
  invalidCallableRevocation.tools = [];
  assert.throws(() => validateAiStatusSyncPayload(invalidCallableRevocation), /cannot contain agents/);
});

test("rejects maliciously oversized Passport payloads before field parsing", () => {
  const oversized = passportPayload();
  oversized.padding = "x".repeat(70 * 1024);
  assert.throws(() => validateAiStatusSyncPayload(oversized), /exceeds the allowed size/);
});
