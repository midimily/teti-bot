import { randomUUID } from "node:crypto";
import type { WorkspaceAccess } from "../workspace/types.ts";
import {
  DELEGATION_LIMITS,
  TETI_DELEGATION_DEPTH,
  TETI_DELEGATION_PLAN_SCHEMA_VERSION,
  TETI_HOST_AGGREGATION_RESOURCE_ID,
  type DelegationPlanCreationInput,
  type DelegationPlanState,
  type DelegationTargetOption
} from "./types.ts";
import { DelegationContractError, validateDelegationPlanState } from "./validation.ts";

export interface DelegationPlanner {
  readonly enabled: boolean;
  plan(input: unknown): Promise<DelegationPlanState>;
}

/** Beta 0.2 keeps the Planner boundary disabled and never autonomously selects a Child. */
export class DisabledDelegationPlanner implements DelegationPlanner {
  readonly enabled = false;

  async plan(_input: unknown): Promise<DelegationPlanState> {
    throw new DelegationContractError(
      "DELEGATION_PLANNER_DISABLED",
      "Autonomous Delegation Planner is disabled in Beta 0.2.10."
    );
  }
}

export function createDeterministicDelegationPlan(
  input: DelegationPlanCreationInput
): DelegationPlanState {
  if (!Array.isArray(input.targets)
    || input.targets.length < 1
    || input.targets.length > DELEGATION_LIMITS.maximumChildSteps) {
    throw new DelegationContractError("DELEGATION_STEP_LIMIT", "Select one to four Child Agent steps.");
  }
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const idFactory = input.idFactory ?? randomUUID;
  const steps = input.targets.map((target, index) => {
    const workspaceAccess = delegationWorkspaceAccess(target, input.workspaceAccess);
    return {
      kind: "child_execution" as const,
      stepId: `step:${index + 1}`,
      stepIndex: index + 1,
      dependsOnStepId: index === 0 ? null : `step:${index}`,
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      capabilityId: target.capabilityId,
      resourceBindingId: target.resourceBindingId,
      budget: {
        maxInputBytes: DELEGATION_LIMITS.maximumInputBytes,
        maxOutputBytes: Math.min(target.maxOutputBytes, DELEGATION_LIMITS.maximumOutputBytes),
        timeoutMs: Math.min(target.timeoutMs, DELEGATION_LIMITS.maximumStepTimeoutMs)
      },
      workspaceRevision: input.workspaceRevision,
      workspaceAccess,
      remoteAgentAccess: "deny" as const,
      instructionMode: "task_then_prior_artifacts" as const,
      state: "pending" as const,
      executionTaskId: null,
      artifactIds: []
    };
  });
  const plan: DelegationPlanState = {
    schemaVersion: TETI_DELEGATION_PLAN_SCHEMA_VERSION,
    planId: idFactory(),
    taskId: input.taskId,
    phase: "pending_approval",
    delegationDepth: TETI_DELEGATION_DEPTH,
    plannerMode: "disabled",
    source: "explicit_user",
    maximumChildCalls: steps.length,
    currentStepIndex: 0,
    steps: [
      ...steps,
      {
        kind: "artifact_aggregation",
        stepId: "step:aggregate",
        stepIndex: steps.length + 1,
        dependsOnStepIds: steps.map((step) => step.stepId),
        resourceId: TETI_HOST_AGGREGATION_RESOURCE_ID,
        strategy: "ordered_artifact_bundle",
        state: "pending",
        artifactId: null
      }
    ],
    artifacts: [],
    audit: [{
      eventId: idFactory(),
      sequence: 1,
      action: "plan_created",
      actor: "local_user",
      stepId: null,
      timestamp
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  validateDelegationPlanState(plan);
  return plan;
}

function delegationWorkspaceAccess(
  target: DelegationTargetOption,
  granted: WorkspaceAccess[]
): WorkspaceAccess[] {
  if (!granted.includes("read")) {
    throw new DelegationContractError("DELEGATION_WORKSPACE_SCOPE", "Delegation requires read access.");
  }
  if (target.workspacePolicy !== "snapshot") return ["read"];
  return [...granted];
}
