import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPOSURE_POLICY,
  type AgentObservation,
  type ResourceObservation
} from "./types.ts";
import {
  assertPrivacySafeObservation,
  ObservationPrivacyError
} from "./privacy.ts";

test("frozen observations support partial Agent levels without fake fields", () => {
  const observation: AgentObservation = {
    schemaVersion: 1,
    observationId: "agent:codex:2026-07-25",
    agentId: "codex",
    provider: "openai",
    displayName: "Codex",
    surfaces: ["cli"],
    supportedLevels: [1, 2],
    installation: {
      state: "installed",
      version: "0.146.0",
      evidence: [{
        source: "executable",
        confidence: "high",
        assurance: "locally_observed",
        adapterId: "builtin.codex",
        adapterRevision: 1,
        observedAt: "2026-07-25T00:00:00.000Z"
      }]
    },
    observedAt: "2026-07-25T00:00:00.000Z",
    errors: []
  };

  assert.equal(observation.runtime, undefined);
  assert.equal(observation.activity, undefined);
  assert.doesNotThrow(() => assertPrivacySafeObservation(observation));
});

test("Resource, Entitlement, and Quota observations keep field evidence separate", () => {
  const evidence = [{
    source: "provider_observed" as const,
    confidence: "high" as const,
    assurance: "provider_observed" as const,
    adapterId: "openai.codex.resource",
    adapterRevision: 1,
    observedAt: "2026-07-25T00:00:00.000Z"
  }];
  const resource: ResourceObservation = {
    schemaVersion: 1,
    observationId: "resource:openai.codex:2026-07-25",
    resourceId: "openai.codex",
    provider: "OpenAI",
    product: "Codex",
    availability: "available",
    entitlement: {
      planKey: "plus",
      displayName: "Plus",
      billingModel: "subscription",
      loginState: "signed_in",
      evidence
    },
    quotas: [{
      period: "week",
      remainingPercent: 42,
      resetAt: "2026-07-26T00:00:00.000Z",
      windowSeconds: 604_800,
      identification: "exact",
      evidence
    }],
    observedAt: "2026-07-25T00:00:00.000Z",
    errors: []
  };

  assert.equal(resource.entitlement?.planKey, "plus");
  assert.equal(resource.quotas[0]?.evidence[0]?.assurance, "provider_observed");
  assert.doesNotThrow(() => assertPrivacySafeObservation(resource));
});

test("Exposure defaults allow local discovery but expose no fields or Agent reports", () => {
  assert.equal(DEFAULT_EXPOSURE_POLICY.discoveryEnabled, true);
  assert.equal(DEFAULT_EXPOSURE_POLICY.agentReportingEnabled, false);
  assert.equal(DEFAULT_EXPOSURE_POLICY.audience, "none");
  assert.equal(Object.values(DEFAULT_EXPOSURE_POLICY.fields).every((value) => value === false), true);
});

test("privacy denylist rejects content, paths, commands, credentials, and process IDs", () => {
  for (const field of ["prompt", "cwd", "tool_input", "accessToken", "filename", "pid"]) {
    assert.throws(
      () => assertPrivacySafeObservation({ safe: { [field]: "private" } }),
      ObservationPrivacyError
    );
  }
  assert.doesNotThrow(() => assertPrivacySafeObservation({
    agentId: "codex",
    source: "process",
    processCount: 1,
    observedAt: "2026-07-25T00:00:00.000Z"
  }));
});
