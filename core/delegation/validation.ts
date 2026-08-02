import { validateWorkspaceAccess } from "../workspace/validation.ts";
import {
  DELEGATION_LIMITS,
  TETI_DELEGATION_DEPTH,
  TETI_DELEGATION_PLAN_SCHEMA_VERSION,
  TETI_HOST_AGGREGATION_RESOURCE_ID,
  type DelegationPlanState,
  type DelegationStepBudget
} from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class DelegationContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DelegationContractError";
    this.code = code;
  }
}

export function validateDelegationPlanState(value: unknown): asserts value is DelegationPlanState {
  if (!isRecord(value)) fail("DELEGATION_PLAN_INVALID", "Delegation Plan must be an object.");
  exactKeys(value, [
    "schemaVersion", "planId", "taskId", "phase", "delegationDepth", "plannerMode",
    "source", "maximumChildCalls", "currentStepIndex", "steps", "artifacts", "audit",
    "createdAt", "updatedAt"
  ], "Delegation Plan");
  if (value.schemaVersion !== TETI_DELEGATION_PLAN_SCHEMA_VERSION
    || !safeId(value.planId)
    || !safeId(value.taskId)
    || value.delegationDepth !== TETI_DELEGATION_DEPTH
    || value.plannerMode !== "disabled"
    || value.source !== "explicit_user"
    || !Number.isSafeInteger(value.maximumChildCalls)
    || Number(value.maximumChildCalls) < 1
    || Number(value.maximumChildCalls) > DELEGATION_LIMITS.maximumChildSteps
    || !Number.isSafeInteger(value.currentStepIndex)
    || Number(value.currentStepIndex) < 0
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || !["pending_approval", "working", "aggregating", "completed", "failed", "canceled", "interrupted"]
      .includes(String(value.phase))) {
    fail("DELEGATION_PLAN_INVALID", "Delegation Plan metadata is invalid.");
  }
  if (!Array.isArray(value.steps)
    || value.steps.length < 2
    || value.steps.length > DELEGATION_LIMITS.maximumChildSteps + 1) {
    fail("DELEGATION_STEP_LIMIT", "Delegation Plan step count is invalid.");
  }
  const childSteps = value.steps.slice(0, -1);
  const aggregation = value.steps.at(-1);
  if (!isRecord(aggregation) || aggregation.kind !== "artifact_aggregation"
    || childSteps.some((step) => !isRecord(step) || step.kind !== "child_execution")
    || childSteps.length !== value.maximumChildCalls) {
    fail("DELEGATION_PLAN_ORDER", "Delegation Plan must end with one Host aggregation step.");
  }
  const stepIds = new Set<string>();
  childSteps.forEach((raw, index) => {
    const step = raw as Record<string, unknown>;
    exactKeysWithOptional(step, [
      "kind", "stepId", "stepIndex", "dependsOnStepId", "childAgentId", "connectorId",
      "capabilityId", "resourceBindingId", "budget", "workspaceRevision", "workspaceAccess",
      "remoteAgentAccess", "instructionMode", "state", "executionTaskId", "artifactIds"
    ], ["startedAt", "completedAt", "safeErrorCode"], "Delegation Child step");
    const expectedDependency = index === 0 ? null : `step:${index}`;
    if (step.stepId !== `step:${index + 1}`
      || step.stepIndex !== index + 1
      || step.dependsOnStepId !== expectedDependency
      || !safeSlug(step.childAgentId)
      || !safeSlug(step.connectorId)
      || !safeSlug(step.capabilityId)
      || !safeId(step.resourceBindingId)
      || step.remoteAgentAccess !== "deny"
      || step.instructionMode !== "task_then_prior_artifacts"
      || !Number.isSafeInteger(step.workspaceRevision)
      || Number(step.workspaceRevision) < 1
      || !["pending", "working", "completed", "failed", "canceled", "interrupted"]
        .includes(String(step.state))
      || (step.executionTaskId !== null && !safeId(step.executionTaskId))
      || !Array.isArray(step.artifactIds)
      || step.artifactIds.length > 2
      || step.artifactIds.some((id) => !safeId(id))) {
      fail("DELEGATION_STEP_INVALID", "Delegation Child step is invalid.");
    }
    validateBudget(step.budget);
    try { validateWorkspaceAccess(step.workspaceAccess); } catch {
      fail("DELEGATION_WORKSPACE_SCOPE", "Delegation Workspace access is invalid.");
    }
    optionalTimestamp(step.startedAt);
    optionalTimestamp(step.completedAt);
    optionalSafeCode(step.safeErrorCode);
    if (stepIds.has(String(step.stepId))) fail("DELEGATION_STEP_INVALID", "Delegation step IDs must be unique.");
    stepIds.add(String(step.stepId));
  });
  exactKeysWithOptional(aggregation, [
    "kind", "stepId", "stepIndex", "dependsOnStepIds", "resourceId", "strategy",
    "state", "artifactId"
  ], ["startedAt", "completedAt", "safeErrorCode"], "Delegation aggregation step");
  if (aggregation.stepId !== "step:aggregate"
    || aggregation.stepIndex !== childSteps.length + 1
    || !Array.isArray(aggregation.dependsOnStepIds)
    || aggregation.dependsOnStepIds.length !== childSteps.length
    || aggregation.dependsOnStepIds.some((id, index) => id !== `step:${index + 1}`)
    || aggregation.resourceId !== TETI_HOST_AGGREGATION_RESOURCE_ID
    || aggregation.strategy !== "ordered_artifact_bundle"
    || !["pending", "working", "completed", "failed", "canceled", "interrupted"]
      .includes(String(aggregation.state))
    || (aggregation.artifactId !== null && !safeId(aggregation.artifactId))) {
    fail("DELEGATION_AGGREGATION_INVALID", "Delegation aggregation step is invalid.");
  }
  optionalTimestamp(aggregation.startedAt);
  optionalTimestamp(aggregation.completedAt);
  optionalSafeCode(aggregation.safeErrorCode);
  validateArtifacts(value.artifacts, stepIds);
  validateAudit(value.audit, stepIds);
  validateStateRelations(value, childSteps as Record<string, unknown>[], aggregation);
}

export function isWorkspaceAccessSubset(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((access) => granted.includes(access));
}

function validateBudget(value: unknown): asserts value is DelegationStepBudget {
  if (!isRecord(value)) fail("DELEGATION_BUDGET_INVALID", "Delegation step budget is invalid.");
  exactKeys(value, ["maxInputBytes", "maxOutputBytes", "timeoutMs"], "Delegation step budget");
  if (!Number.isSafeInteger(value.maxInputBytes) || Number(value.maxInputBytes) < 1
    || Number(value.maxInputBytes) > DELEGATION_LIMITS.maximumInputBytes
    || !Number.isSafeInteger(value.maxOutputBytes) || Number(value.maxOutputBytes) < 1
    || Number(value.maxOutputBytes) > DELEGATION_LIMITS.maximumOutputBytes
    || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 10
    || Number(value.timeoutMs) > DELEGATION_LIMITS.maximumStepTimeoutMs) {
    fail("DELEGATION_BUDGET_INVALID", "Delegation step budget exceeds Host limits.");
  }
}

function validateArtifacts(value: unknown, childStepIds: Set<string>): void {
  if (!Array.isArray(value) || value.length > DELEGATION_LIMITS.maximumArtifacts) {
    fail("DELEGATION_ARTIFACT_LIMIT", "Delegation Artifact provenance is invalid.");
  }
  const artifactIds = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) fail("DELEGATION_ARTIFACT_INVALID", "Delegation Artifact provenance is invalid.");
    exactKeys(raw, ["artifactId", "stepId", "producer", "workspaceRevision", "role", "createdAt"], "Delegation Artifact provenance");
    if (!safeId(raw.artifactId) || artifactIds.has(String(raw.artifactId))
      || !Number.isSafeInteger(raw.workspaceRevision) || Number(raw.workspaceRevision) < 1
      || (raw.role !== "intermediate" && raw.role !== "final")
      || !validTimestamp(raw.createdAt)
      || !isRecord(raw.producer)) {
      fail("DELEGATION_ARTIFACT_INVALID", "Delegation Artifact provenance is invalid.");
    }
    if (raw.producer.kind === "child_agent") {
      exactKeys(raw.producer, ["kind", "childAgentId", "connectorId", "resourceBindingId"], "Child Artifact producer");
      if (!childStepIds.has(String(raw.stepId))
        || !safeSlug(raw.producer.childAgentId)
        || !safeSlug(raw.producer.connectorId)
        || !safeId(raw.producer.resourceBindingId)
        || raw.role !== "intermediate") {
        fail("DELEGATION_ARTIFACT_INVALID", "Child Artifact producer is invalid.");
      }
    } else {
      exactKeys(raw.producer, ["kind", "resourceId"], "Host Artifact producer");
      if (raw.producer.kind !== "teti_host"
        || raw.producer.resourceId !== TETI_HOST_AGGREGATION_RESOURCE_ID
        || raw.stepId !== "step:aggregate"
        || raw.role !== "final") {
        fail("DELEGATION_ARTIFACT_INVALID", "Host Artifact producer is invalid.");
      }
    }
    artifactIds.add(String(raw.artifactId));
  }
}

function validateAudit(value: unknown, childStepIds: Set<string>): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > DELEGATION_LIMITS.maximumAuditEvents) {
    fail("DELEGATION_AUDIT_LIMIT", "Delegation audit is invalid.");
  }
  value.forEach((raw, index) => {
    if (!isRecord(raw)) fail("DELEGATION_AUDIT_INVALID", "Delegation audit event is invalid.");
    exactKeysWithOptional(raw, ["eventId", "sequence", "action", "actor", "stepId", "timestamp"], ["artifactId", "safeErrorCode"], "Delegation audit event");
    if (!safeId(raw.eventId) || raw.sequence !== index + 1
      || !["plan_created", "plan_approved", "step_started", "artifact_recorded", "step_completed", "step_failed", "aggregation_started", "plan_completed", "plan_canceled", "restart_reconciled"].includes(String(raw.action))
      || !["host", "local_user", "child_agent"].includes(String(raw.actor))
      || (raw.stepId !== null && raw.stepId !== "step:aggregate" && !childStepIds.has(String(raw.stepId)))
      || !validTimestamp(raw.timestamp)) {
      fail("DELEGATION_AUDIT_INVALID", "Delegation audit event is invalid.");
    }
    if (raw.artifactId !== undefined && !safeId(raw.artifactId)) fail("DELEGATION_AUDIT_INVALID", "Delegation audit Artifact is invalid.");
    optionalSafeCode(raw.safeErrorCode);
  });
  if ((value[0] as Record<string, unknown>).action !== "plan_created") {
    fail("DELEGATION_AUDIT_INVALID", "Delegation audit must start with plan creation.");
  }
}

function validateStateRelations(
  plan: Record<string, unknown>,
  childSteps: Record<string, unknown>[],
  aggregation: Record<string, unknown>
): void {
  let foundNonCompleted = false;
  for (const step of childSteps) {
    if (step.state === "completed") {
      if (foundNonCompleted) {
        fail("DELEGATION_PLAN_ORDER", "Completed Delegation steps must form one ordered prefix.");
      }
    } else {
      if (foundNonCompleted && step.state !== "pending") {
        fail("DELEGATION_PLAN_ORDER", "Only one non-pending Delegation step may follow the completed prefix.");
      }
      foundNonCompleted = true;
    }
  }

  const provenance = plan.artifacts as Record<string, unknown>[];
  for (const step of childSteps) {
    const stepArtifacts = step.artifactIds as string[];
    const produced = provenance.filter((entry) => entry.stepId === step.stepId);
    if (step.state === "completed" ? stepArtifacts.length !== 1 : stepArtifacts.length !== 0) {
      fail("DELEGATION_ARTIFACT_INVALID", "Delegation step Artifact state is inconsistent.");
    }
    if (produced.length !== stepArtifacts.length
      || produced.some((entry) => !stepArtifacts.includes(String(entry.artifactId)))) {
      fail("DELEGATION_ARTIFACT_INVALID", "Delegation step Artifact provenance is inconsistent.");
    }
  }
  const finalProvenance = provenance.filter((entry) => entry.stepId === aggregation.stepId);
  if (aggregation.state === "completed") {
    if (typeof aggregation.artifactId !== "string"
      || finalProvenance.length !== 1
      || finalProvenance[0]?.artifactId !== aggregation.artifactId) {
      fail("DELEGATION_AGGREGATION_INVALID", "Completed Host aggregation requires exact final provenance.");
    }
  } else if (aggregation.artifactId !== null || finalProvenance.length !== 0) {
    fail("DELEGATION_AGGREGATION_INVALID", "Incomplete Host aggregation cannot publish final provenance.");
  }

  const phase = String(plan.phase);
  const active = [...childSteps, aggregation].filter((step) => step.state === "working");
  const failed = [...childSteps, aggregation].filter((step) => step.state === "failed");
  const interrupted = childSteps.filter((step) => step.state === "interrupted");
  const canceled = [...childSteps, aggregation].filter((step) => step.state === "canceled");
  const allChildrenCompleted = childSteps.every((step) => step.state === "completed");
  const currentStepIndex = Number(plan.currentStepIndex);
  const phaseTarget = phase === "working" ? active[0]
    : phase === "failed" ? failed[0]
    : phase === "interrupted" ? interrupted[0]
    : phase === "canceled" ? canceled[0]
    : undefined;
  if ((phase === "pending_approval"
      && (currentStepIndex !== 0
        || childSteps.some((step) => step.state !== "pending")
        || aggregation.state !== "pending"))
    || (phase === "working" && (active.length !== 1 || currentStepIndex !== phaseTarget?.stepIndex))
    || (phase === "aggregating"
      && (!allChildrenCompleted || aggregation.state !== "working" || currentStepIndex !== aggregation.stepIndex))
    || (phase === "completed"
      && (!allChildrenCompleted || aggregation.state !== "completed" || currentStepIndex !== aggregation.stepIndex))
    || (phase === "failed" && (failed.length !== 1 || currentStepIndex !== phaseTarget?.stepIndex))
    || (phase === "interrupted" && (interrupted.length !== 1 || currentStepIndex !== phaseTarget?.stepIndex))
    || (phase === "canceled" && (canceled.length !== 1 || currentStepIndex !== phaseTarget?.stepIndex))) {
    fail("DELEGATION_PLAN_STATE", "Delegation Plan phase and step states are inconsistent.");
  }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  exactKeysWithOptional(value, required, [], label);
}

function exactKeysWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail("DELEGATION_CONTRACT_KEYS", `${label} fields are invalid.`);
  }
}

function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function safeSlug(value: unknown): value is string { return typeof value === "string" && SAFE_SLUG.test(value); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function optionalTimestamp(value: unknown): void { if (value !== undefined && !validTimestamp(value)) fail("DELEGATION_TIMESTAMP_INVALID", "Delegation timestamp is invalid."); }
function optionalSafeCode(value: unknown): void { if (value !== undefined && (typeof value !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value))) fail("DELEGATION_ERROR_INVALID", "Delegation safe error code is invalid."); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(code: string, message: string): never { throw new DelegationContractError(code, message); }
