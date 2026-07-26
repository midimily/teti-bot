import assert from "node:assert/strict";
import test from "node:test";
import {
  projectCallableAgent,
  type AgentAdapterReadiness
} from "./types.ts";

const checkedAt = "2026-07-26T00:00:00.000Z";

test("an observed or installed Agent is not automatically callable", () => {
  for (const state of ["not_detected", "detected", "adapter_available", "needs_login", "degraded", "disabled"] as const) {
    assert.equal(projectCallableAgent(readiness(state)), null);
  }
});

test("only a validated ready Adapter projects to a text-only callable Agent", () => {
  assert.deepEqual(projectCallableAgent(readiness("ready")), {
    schemaVersion: 1,
    agentId: "codex",
    adapterId: "openai.codex.exec",
    adapterRevision: 1,
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    readyAt: checkedAt
  });
});

test("callable projection fails closed for invalid Adapter claims", () => {
  assert.equal(projectCallableAgent({ ...readiness("ready"), adapterRevision: 0 }), null);
  assert.equal(projectCallableAgent({ ...readiness("ready"), capabilityIds: [] }), null);
  assert.equal(projectCallableAgent({ ...readiness("ready"), capabilityIds: ["code-analysis", "code-analysis"] }), null);
  assert.equal(projectCallableAgent({ ...readiness("ready"), adapterId: "/tmp/codex" }), null);
  assert.equal(projectCallableAgent({ ...readiness("ready"), checkedAt: "invalid" }), null);
});

function readiness(state: AgentAdapterReadiness["state"]): AgentAdapterReadiness {
  return {
    schemaVersion: 1,
    agentId: "codex",
    adapterId: "openai.codex.exec",
    adapterRevision: 1,
    state,
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    checkedAt
  };
}
