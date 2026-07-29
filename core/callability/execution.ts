export const TETI_EXECUTION_HANDLE_SCHEMA_VERSION = 1;
export const TETI_EXECUTION_LEASE_MS = 30_000;

export interface ConnectorExecutionCapabilities {
  supportsProgress: boolean;
  supportsPause: boolean;
  supportsResume: boolean;
  supportsCheckpoint: boolean;
  supportsCancel: boolean;
}

export type ExecutionSemantics =
  | "workspace_pure_compute"
  | "external_side_effects_possible";

export type ExecutionProgressState =
  | "queued"
  | "running"
  | "paused"
  | "interrupted"
  | "canceling"
  | "canceled"
  | "completed"
  | "failed";

export interface ExecutionProgress {
  state: ExecutionProgressState;
  completedUnits: number | null;
  totalUnits: number | null;
  message: string | null;
  updatedAt: string;
}

export type ExecutionResumeCapability = "none" | "checkpoint_restart";

/**
 * Receiver-local durable execution identity. providerExecutionId and
 * checkpointRef never enter Task, Passport, Chatmail, or peer messages.
 */
export interface ExecutionHandle {
  schemaVersion: 1;
  taskId: string;
  workspaceId: string;
  childAgentId: string;
  connectorId: string;
  executionEpoch: number;
  providerExecutionId: string | null;
  leaseExpiresAt: string;
  progress: ExecutionProgress;
  checkpointRef: string | null;
  resumeCapability: ExecutionResumeCapability;
}

export interface PrepareExecutionHandleInput {
  taskId: string;
  workspaceId: string;
  childAgentId: string;
  connectorId: string;
  resume: boolean;
}

export interface ExecutionHandleRegistry {
  prepare(
    input: PrepareExecutionHandleInput,
    capabilities: ConnectorExecutionCapabilities,
    semantics: ExecutionSemantics
  ): Promise<ExecutionHandle>;
  get(taskId: string): Promise<ExecutionHandle | null>;
  list(): Promise<ExecutionHandle[]>;
  markRunning(taskId: string, executionEpoch: number, providerExecutionId: string | null): Promise<boolean>;
  renew(taskId: string, executionEpoch: number): Promise<boolean>;
  captureCheckpoint(input: {
    taskId: string;
    executionEpoch: number;
    sourcePath: string;
    workspacePath: string;
    resumeEligible: boolean;
  }): Promise<boolean>;
  finish(
    taskId: string,
    executionEpoch: number,
    state: "completed" | "failed" | "canceled",
    message?: string
  ): Promise<boolean>;
  cancel(taskId: string, executionEpoch?: number): Promise<boolean>;
  isCurrent(taskId: string, executionEpoch: number): Promise<boolean>;
  reconcile(activeTaskIds: readonly string[]): Promise<ExecutionHandle[]>;
}

export function validateConnectorExecutionCapabilities(
  value: ConnectorExecutionCapabilities
): void {
  exactKeys(value as unknown as Record<string, unknown>, [
    "supportsProgress",
    "supportsPause",
    "supportsResume",
    "supportsCheckpoint",
    "supportsCancel"
  ], "Connector execution capabilities");
  if (Object.values(value).some((item) => typeof item !== "boolean")) {
    throw new Error("Connector execution capabilities are invalid.");
  }
  if (value.supportsResume && !value.supportsCheckpoint) {
    throw new Error("A resumable Connector must support explicit checkpoints.");
  }
  if (value.supportsPause && !value.supportsResume) {
    throw new Error("A pausable Connector must support resume.");
  }
}

export function validateExecutionHandle(value: unknown): asserts value is ExecutionHandle {
  if (!isRecord(value)) throw new Error("Execution Handle is invalid.");
  exactKeys(value, [
    "schemaVersion",
    "taskId",
    "workspaceId",
    "childAgentId",
    "connectorId",
    "executionEpoch",
    "providerExecutionId",
    "leaseExpiresAt",
    "progress",
    "checkpointRef",
    "resumeCapability"
  ], "Execution Handle");
  if (value.schemaVersion !== TETI_EXECUTION_HANDLE_SCHEMA_VERSION
    || !safeId(value.taskId)
    || !safeId(value.workspaceId)
    || !safeSlug(value.childAgentId)
    || !safeSlug(value.connectorId)
    || !Number.isSafeInteger(value.executionEpoch)
    || Number(value.executionEpoch) < 1
    || (value.providerExecutionId !== null && !safeProviderId(value.providerExecutionId))
    || !validTimestamp(value.leaseExpiresAt)
    || (value.checkpointRef !== null
      && (typeof value.checkpointRef !== "string" || value.checkpointRef.length > 2_048))
    || (value.resumeCapability !== "none" && value.resumeCapability !== "checkpoint_restart")) {
    throw new Error("Execution Handle is invalid.");
  }
  validateExecutionProgress(value.progress);
  if (value.resumeCapability === "checkpoint_restart" && value.checkpointRef === null) {
    throw new Error("A resumable Execution Handle requires a checkpoint.");
  }
}

export function validateExecutionProgress(value: unknown): asserts value is ExecutionProgress {
  if (!isRecord(value)) throw new Error("Execution progress is invalid.");
  exactKeys(value, [
    "state",
    "completedUnits",
    "totalUnits",
    "message",
    "updatedAt"
  ], "Execution progress");
  if (!["queued", "running", "paused", "interrupted", "canceling", "canceled", "completed", "failed"]
    .includes(String(value.state))
    || !nullableUnit(value.completedUnits)
    || !nullableUnit(value.totalUnits)
    || (value.completedUnits !== null
      && value.totalUnits !== null
      && Number(value.completedUnits) > Number(value.totalUnits))
    || (value.message !== null
      && (typeof value.message !== "string" || value.message.length > 240))
    || !validTimestamp(value.updatedAt)) {
    throw new Error("Execution progress is invalid.");
  }
}

export function isTerminalExecutionProgress(state: ExecutionProgressState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function nullableUnit(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
}

function safeSlug(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function safeProviderId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\r\n\0]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}
