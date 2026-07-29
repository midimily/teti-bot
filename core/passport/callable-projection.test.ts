import assert from "node:assert/strict";
import test from "node:test";
import type { CallableAgent } from "../callability/types.ts";
import { projectCallablePassport } from "./callable-projection.ts";

test("Callable Passport projects qualified Agents and deduplicates capabilities", () => {
  const projection = projectCallablePassport([
    callable("codex", "codex.local"),
    callable("codebuddy", "codebuddy.local")
  ]);
  assert.deepEqual(projection.agents.map((agent) => agent.id), ["codebuddy", "codex"]);
  assert.equal(projection.capabilities.length, 1);
  assert.deepEqual(projection.bindings, [{
    capabilityId: "code-analysis",
    agentIds: ["codebuddy", "codex"],
    resourceIds: []
  }]);
  assert.doesNotMatch(JSON.stringify(projection), /entrypoint|command|path|version|process|token/i);
});

test("an empty qualified set produces no Agent or inferred capability", () => {
  assert.deepEqual(projectCallablePassport([]), {
    agents: [],
    capabilities: [],
    bindings: [],
    computeOffers: []
  });
});

test("multiple qualified Adapters for one Agent become one public Agent", () => {
  const second = callable("codex", "codex.secondary");
  second.capabilityIds = ["image-editing"];
  second.inputModes = ["text", "image"];
  second.outputModes = ["text", "image"];
  second.readyAt = "2026-07-26T00:01:00.000Z";
  const projection = projectCallablePassport([callable("codex", "codex.local"), second]);
  assert.equal(projection.agents.length, 1);
  assert.deepEqual(projection.agents[0]?.capabilityIds, ["code-analysis", "image-editing"]);
  assert.deepEqual(projection.agents[0]?.inputModes, ["text", "image"]);
  assert.deepEqual(projection.agents[0]?.outputModes, ["text", "image"]);
  assert.equal(projection.capabilities.find((capability) => capability.id === "image-editing")?.category, "image");
  assert.equal(projection.agents[0]?.observedAt, "2026-07-26T00:01:00.000Z");
});

test("qualified Osaurus Runtime projects one abstract local-compute offer without local binding", () => {
  const osaurus = callable("osaurus-runtime", "osaurus.runtime.bonsai-chat");
  osaurus.capabilityIds = ["general-text-assistance"];
  const projection = projectCallablePassport([osaurus], [{
    offerId: "local.compute.general-text-assistance.v1",
    capability: "general-text-assistance",
    resourceClass: "local_model",
    executionLocation: "receiver_local",
    inputModes: ["text"],
    outputModes: ["text"],
    concurrency: 1,
    approval: "allow_once"
  }]);
  assert.deepEqual(projection.computeOffers, [{
    offerId: "local.compute.general-text-assistance.v1",
    capability: "general-text-assistance",
    resourceClass: "local_model",
    executionLocation: "receiver_local",
    inputModes: ["text"],
    outputModes: ["text"],
    concurrency: 1,
    approval: "allow_once",
    observedAt: osaurus.readyAt
  }]);
  assert.deepEqual(Object.keys(projection.computeOffers[0]!).sort(), [
    "approval",
    "capability",
    "concurrency",
    "executionLocation",
    "inputModes",
    "observedAt",
    "offerId",
    "outputModes",
    "resourceClass"
  ]);
});

function callable(agentId: string, adapterId: string): CallableAgent {
  return {
    schemaVersion: 1,
    agentId,
    adapterId,
    adapterRevision: 1,
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    readyAt: "2026-07-26T00:00:00.000Z"
  };
}
