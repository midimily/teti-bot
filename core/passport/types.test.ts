import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PASSPORT_SHARING_POLICY,
  TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
  type AiAgent,
  type AiResource,
  type TetiCapabilityPassport
} from "./types.ts";

test("Beta Passport sharing defaults fail closed for confirmed peers", () => {
  assert.equal(Object.isFrozen(DEFAULT_PASSPORT_SHARING_POLICY), true);
  assert.deepEqual(DEFAULT_PASSPORT_SHARING_POLICY, {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: false,
    resourceQuota: false,
    agents: false,
    capabilities: false
  });
});

test("Resource, Agent, Capability, and Binding remain separate Passport entities", () => {
  const resource: AiResource = {
    id: "openai.codex.subscription",
    provider: "OpenAI",
    product: "Codex",
    kind: "subscription",
    plan: { key: "plus", displayName: "Plus" },
    availability: "available",
    quotas: [],
    assurance: "provider_observed",
    observedAt: "2026-07-21T00:00:00.000Z"
  };
  const agent: AiAgent = {
    id: "openai.codex-cli",
    name: "Codex CLI",
    type: "cli",
    installationStatus: "installed",
    detectionSource: "command",
    observedAt: "2026-07-21T00:00:00.000Z"
  };
  const passport: TetiCapabilityPassport = {
    schemaVersion: TETI_CAPABILITY_PASSPORT_SCHEMA_VERSION,
    generatedAt: "2026-07-21T00:00:00.000Z",
    resources: [resource],
    agents: [agent],
    capabilities: [{
      id: "coding",
      name: "Coding",
      category: "coding",
      description: "Coding capability derived from known local resources and agents.",
      availability: "available",
      observedAt: "2026-07-21T00:00:00.000Z"
    }],
    bindings: [{
      capabilityId: "coding",
      agentIds: [agent.id],
      resourceIds: [resource.id]
    }]
  };

  assert.equal(passport.resources[0]?.id, "openai.codex.subscription");
  assert.equal(passport.agents[0]?.installationStatus, "installed");
  assert.deepEqual(passport.bindings[0], {
    capabilityId: "coding",
    agentIds: ["openai.codex-cli"],
    resourceIds: ["openai.codex.subscription"]
  });
});
