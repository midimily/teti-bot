import type { CollaborationTaskArtifact } from "../task/types.ts";
import type { WorkspaceAccess } from "../workspace/types.ts";

export const TETI_DELEGATION_PLAN_SCHEMA_VERSION = 1 as const;
export const TETI_DELEGATION_DEPTH = 1 as const;
export const TETI_HOST_AGGREGATION_RESOURCE_ID = "teti.host.artifact-aggregation.v1";

export const DELEGATION_LIMITS = {
  maximumChildSteps: 4,
  maximumArtifacts: 8,
  maximumAuditEvents: 64,
  maximumStepTimeoutMs: 15 * 60 * 1_000,
  maximumInputBytes: 24 * 1024,
  maximumOutputBytes: 56 * 1024
} as const;

export type DelegationPlanPhase =
  | "pending_approval"
  | "working"
  | "aggregating"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type DelegationStepState =
  | "pending"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export interface DelegationTargetSelection {
  childAgentId: string;
  connectorId: string;
  capabilityId: string;
}

/** Receiver-local option. Connector and Resource identities never enter peer messages. */
export interface DelegationTargetOption extends DelegationTargetSelection {
  resourceBindingId: string;
  workspacePolicy: "snapshot" | "bounded_context" | "none";
  inputModes: Array<"text" | "image">;
  outputModes: Array<"text" | "image">;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface DelegationStepBudget {
  maxInputBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface DelegationChildStep {
  kind: "child_execution";
  stepId: string;
  stepIndex: number;
  dependsOnStepId: string | null;
  childAgentId: string;
  connectorId: string;
  capabilityId: string;
  resourceBindingId: string;
  budget: DelegationStepBudget;
  workspaceRevision: number;
  workspaceAccess: WorkspaceAccess[];
  remoteAgentAccess: "deny";
  instructionMode: "task_then_prior_artifacts";
  state: DelegationStepState;
  executionTaskId: string | null;
  artifactIds: string[];
  startedAt?: string;
  completedAt?: string;
  safeErrorCode?: string;
}

export interface DelegationAggregationStep {
  kind: "artifact_aggregation";
  stepId: string;
  stepIndex: number;
  dependsOnStepIds: string[];
  resourceId: typeof TETI_HOST_AGGREGATION_RESOURCE_ID;
  strategy: "ordered_artifact_bundle";
  state: DelegationStepState;
  artifactId: string | null;
  startedAt?: string;
  completedAt?: string;
  safeErrorCode?: string;
}

export type DelegationStep = DelegationChildStep | DelegationAggregationStep;

export type DelegationArtifactProducer =
  | {
      kind: "child_agent";
      childAgentId: string;
      connectorId: string;
      resourceBindingId: string;
    }
  | {
      kind: "teti_host";
      resourceId: typeof TETI_HOST_AGGREGATION_RESOURCE_ID;
    };

export interface DelegationArtifactProvenance {
  artifactId: string;
  stepId: string;
  producer: DelegationArtifactProducer;
  workspaceRevision: number;
  role: "intermediate" | "final";
  createdAt: string;
}

export interface DelegationAuditEvent {
  eventId: string;
  sequence: number;
  action:
    | "plan_created"
    | "plan_approved"
    | "step_started"
    | "artifact_recorded"
    | "step_completed"
    | "step_failed"
    | "aggregation_started"
    | "plan_completed"
    | "plan_canceled"
    | "restart_reconciled";
  actor: "host" | "local_user" | "child_agent";
  stepId: string | null;
  timestamp: string;
  artifactId?: string;
  safeErrorCode?: string;
}

/** Receiver-local deterministic plan. It is never serialized into Task or Passport. */
export interface DelegationPlanState {
  schemaVersion: typeof TETI_DELEGATION_PLAN_SCHEMA_VERSION;
  planId: string;
  taskId: string;
  phase: DelegationPlanPhase;
  delegationDepth: typeof TETI_DELEGATION_DEPTH;
  plannerMode: "disabled";
  source: "explicit_user";
  maximumChildCalls: number;
  currentStepIndex: number;
  steps: DelegationStep[];
  artifacts: DelegationArtifactProvenance[];
  audit: DelegationAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface DelegationPlanCreationInput {
  taskId: string;
  workspaceRevision: number;
  workspaceAccess: WorkspaceAccess[];
  targets: DelegationTargetOption[];
  now?: Date;
  idFactory?: () => string;
}

export interface DelegationArtifactAggregationInput {
  taskId: string;
  artifacts: readonly CollaborationTaskArtifact[];
  maximumTextBytes: number;
  artifactId: string;
  createdAt: string;
}
