import assert from "node:assert/strict";
import test from "node:test";
import {
  DisabledDelegationPlanner,
  createDeterministicDelegationPlan
} from "./planner.ts";
import type { DelegationTargetOption } from "./types.ts";
import {
  DelegationContractError,
  isWorkspaceAccessSubset,
  validateDelegationPlanState
} from "./validation.ts";

test("an explicit Delegation Plan is linear, depth-one, bounded, and ends in Host aggregation", () => {
  const ids = ["plan-1", "audit-1"];
  const plan = createDeterministicDelegationPlan({
    taskId: "task-1",
    workspaceRevision: 3,
    workspaceAccess: ["read", "write", "create_artifact"],
    targets: [target("osaurus-runtime", "osaurus.runtime", "general-text-assistance", "none"),
      target("codex", "codex.image", "image-editing", "snapshot")],
    now: new Date("2026-08-02T00:00:00.000Z"),
    idFactory: () => ids.shift()!
  });

  validateDelegationPlanState(plan);
  assert.equal(plan.delegationDepth, 1);
  assert.equal(plan.plannerMode, "disabled");
  assert.equal(plan.maximumChildCalls, 2);
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    "child_execution",
    "child_execution",
    "artifact_aggregation"
  ]);
  const first = plan.steps[0];
  const second = plan.steps[1];
  assert.equal(first?.kind, "child_execution");
  assert.equal(second?.kind, "child_execution");
  if (first?.kind !== "child_execution" || second?.kind !== "child_execution") return;
  assert.equal(first.dependsOnStepId, null);
  assert.deepEqual(first.workspaceAccess, ["read"]);
  assert.equal(first.remoteAgentAccess, "deny");
  assert.equal(second.dependsOnStepId, "step:1");
  assert.deepEqual(second.workspaceAccess, ["read", "write", "create_artifact"]);
  assert.ok(second.budget.timeoutMs <= 15 * 60 * 1_000);
  assert.ok(second.budget.maxOutputBytes <= 56 * 1_024);
});

test("Delegation Plan rejects depth, authority, and step-count expansion", () => {
  const plan = createDeterministicDelegationPlan({
    taskId: "task-2",
    workspaceRevision: 1,
    workspaceAccess: ["read"],
    targets: [target("codex", "codex.text", "code-analysis", "snapshot")],
    idFactory: sequenceIds()
  });
  const expanded = structuredClone(plan) as unknown as Record<string, unknown>;
  expanded.delegationDepth = 2;
  assert.throws(() => validateDelegationPlanState(expanded), DelegationContractError);

  const child = plan.steps[0];
  if (child?.kind !== "child_execution") throw new Error("fixture failure");
  child.workspaceAccess = ["read", "write"];
  assert.equal(isWorkspaceAccessSubset(child.workspaceAccess, ["read"]), false);

  const remoteEscalation = structuredClone(plan);
  const remoteStep = remoteEscalation.steps[0];
  if (remoteStep?.kind !== "child_execution") throw new Error("fixture failure");
  (remoteStep as unknown as Record<string, unknown>).remoteAgentAccess = "allow";
  assert.throws(
    () => validateDelegationPlanState(remoteEscalation),
    /Delegation Child step is invalid/
  );

  const budgetEscalation = structuredClone(plan);
  const budgetStep = budgetEscalation.steps[0];
  if (budgetStep?.kind !== "child_execution") throw new Error("fixture failure");
  budgetStep.budget.timeoutMs = 24 * 60 * 60 * 1_000;
  assert.throws(
    () => validateDelegationPlanState(budgetEscalation),
    /budget exceeds Host limits/
  );

  assert.throws(() => createDeterministicDelegationPlan({
    taskId: "task-3",
    workspaceRevision: 1,
    workspaceAccess: ["read"],
    targets: Array.from({ length: 5 }, (_, index) =>
      target(`agent-${index}`, `connector-${index}`, "code-analysis", "none")
    )
  }), /one to four Child Agent steps/);

  const outOfOrder = createDeterministicDelegationPlan({
    taskId: "task-4",
    workspaceRevision: 1,
    workspaceAccess: ["read"],
    targets: [
      target("agent-a", "connector-a", "code-analysis", "none"),
      target("agent-b", "connector-b", "code-analysis", "none")
    ],
    idFactory: sequenceIds()
  });
  const second = outOfOrder.steps[1];
  if (second?.kind !== "child_execution") throw new Error("fixture failure");
  second.state = "working";
  outOfOrder.phase = "working";
  outOfOrder.currentStepIndex = 2;
  assert.throws(() => validateDelegationPlanState(outOfOrder), /ordered|non-pending/);
});

test("the autonomous Planner boundary exists but is fail-closed in Beta 0.2.10", async () => {
  const planner = new DisabledDelegationPlanner();
  assert.equal(planner.enabled, false);
  await assert.rejects(
    () => planner.plan({ prompt: "choose agents" }),
    (error: unknown) => error instanceof DelegationContractError
      && error.code === "DELEGATION_PLANNER_DISABLED"
  );
});

function target(
  childAgentId: string,
  connectorId: string,
  capabilityId: string,
  workspacePolicy: DelegationTargetOption["workspacePolicy"]
): DelegationTargetOption {
  return {
    childAgentId,
    connectorId,
    capabilityId,
    resourceBindingId: `binding:${connectorId}`,
    workspacePolicy,
    inputModes: ["text"],
    outputModes: ["text"],
    timeoutMs: 60_000,
    maxOutputBytes: 32 * 1_024
  };
}

function sequenceIds(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}
