import { createHash, randomUUID } from "node:crypto";
import type {
  CallableAdapterDecodedArtifact,
  CallableAdapterDescriptor,
  CallableAdapterImageInput,
  CallableAdapterSafeErrorCode,
  CallableAdapterTaskRequest,
  CallableAdapterTaskSnapshot
} from "./adapter.ts";
import {
  validateCallableAdapterDescriptor,
  validateCallableAdapterLaunchSpec
} from "./adapter.ts";
import type { AgentTaskContentMode, CallableAgent } from "./types.ts";
import type { WorkspaceAccess } from "../workspace/types.ts";
import { validateWorkspaceAccess } from "../workspace/validation.ts";
import {
  validateConnectorExecutionCapabilities,
  type ConnectorExecutionCapabilities,
  type ExecutionHandle,
  type ExecutionSemantics,
  type PrepareExecutionHandleInput
} from "./execution.ts";

export const TETI_HOST_CHILD_AGENT_CORE_VERSION = 2;
export const TETI_EXECUTION_AUTHORITY_SCHEMA_VERSION = 3;
export const TETI_LOCAL_TEXT_COMPUTE_OFFER_ID = "local.compute.general-text-assistance.v1";
export const TETI_OSAURUS_NATIVE_TEXT_OFFER_ID = "local.agent.osaurus-native-text.v1";

export type ExecutionTransportKind = "process" | "fake" | "loopback_http" | "osaurus_agent";
export type LocalChildAgentOrigin = "native_agent" | "runtime_facade";
export type AgentWorkspacePolicy = "snapshot" | "bounded_context" | "none";

export interface AgentConnectorDescriptor {
  contractVersion: 2;
  connectorId: string;
  connectorRevision: number;
  childAgentId: string;
  capabilityIds: string[];
  inputModes: readonly AgentTaskContentMode[];
  outputModes: readonly AgentTaskContentMode[];
  transportKind: ExecutionTransportKind;
  /** Defaults to native_agent for the 0.2.1 CLI Connectors. */
  origin?: LocalChildAgentOrigin;
  /** Defaults to snapshot. LocalService facades may explicitly refuse it. */
  workspacePolicy?: AgentWorkspacePolicy;
  /** Defaults to the Host limit. A LocalService can impose a stricter gate. */
  maxConcurrentExecutions?: number;
  /** Bounded receiver-local queue; omitted means fail immediately when busy. */
  maxQueuedExecutions?: number;
  executionCapabilities: ConnectorExecutionCapabilities;
  executionSemantics: ExecutionSemantics;
  timeoutMs: number;
  cancelGraceMs: number;
  maxOutputBytes: number;
}

/** Safe abstract offer owned by a local Connector; contains no local binding. */
export interface AgentComputeOffer {
  offerId: string;
  capability: "general-text-assistance";
  resourceClass: "local_model" | "native_agent";
  executionLocation: "receiver_local";
  inputModes: readonly ["text"];
  outputModes: readonly ["text"];
  concurrency: 1;
  approval: "allow_once";
}

/** Local-only binding. It is never serialized into Task or Passport. */
export interface AgentResourceBinding {
  schemaVersion: 1;
  bindingId: string;
  childAgentId: string;
  connectorId: string;
  transportKind: ExecutionTransportKind;
  capabilityIds: string[];
}

/** Host-owned view of a locally registered child Agent. */
export interface LocalChildAgent {
  schemaVersion: 1;
  childAgentId: string;
  origin: LocalChildAgentOrigin;
  workspacePolicy: AgentWorkspacePolicy;
  maxConcurrentExecutions: number | null;
  connectorIds: string[];
  resourceBindingIds: string[];
  capabilityIds: string[];
  inputModes: AgentTaskContentMode[];
  outputModes: AgentTaskContentMode[];
}

/**
 * Connector input deliberately excludes task text, authority, Passport,
 * Chatmail, and peer identity. The Host writes text to the transport only
 * after the Connector has returned a bounded execution specification.
 */
export interface AgentConnectorContext {
  taskId: string;
  capabilityId: string;
  workspacePath: string | null;
  /** Host-selected, bounded text snapshot. It contains no local path. */
  workspaceContext?: string | null;
  images: CallableAdapterImageInput[];
  executionEpoch: number;
  checkpointRef: string | null;
}

export interface ProcessExecutionSpec {
  kind: "process";
  executable: string;
  args: string[];
  environment?: Record<string, string>;
}

export interface FakeExecutionSpec {
  kind: "fake";
  scenarioId: string;
}

export interface LoopbackHttpExecutionSpec {
  kind: "loopback_http";
  endpoint: string;
  requestId: string;
  runtimeInstanceId: string;
  model: string;
  listenerPid: number;
  codeIdentityHash: string;
}

export interface OsaurusAgentExecutionSpec {
  kind: "osaurus_agent";
  endpoint: string;
  requestId: string;
  runtimeInstanceId: string;
  agentId: string;
  effectiveModel: string;
  listenerPid: number;
  codeIdentityHash: string;
  agentConfigurationDigest: string;
  providerAuthority: {
    tools: "deny";
    memory: "deny";
    hostWorkspace: "deny";
    autonomousExec: "deny";
  };
}

export type ExecutionSpec =
  | ProcessExecutionSpec
  | FakeExecutionSpec
  | LoopbackHttpExecutionSpec
  | OsaurusAgentExecutionSpec;

export interface AgentConnector {
  readonly descriptor: AgentConnectorDescriptor;
  readonly resourceBinding: AgentResourceBinding;
  readonly computeOffer?: AgentComputeOffer;
  /** Required only by ProcessTransport; local-only and never advertised. */
  readonly fixedProcessEntrypoint?: string;
  createExecutionSpec(
    context: Readonly<AgentConnectorContext>
  ): ExecutionSpec | Promise<ExecutionSpec>;
  decodeArtifact?(
    stdout: string,
    context: Readonly<AgentConnectorContext>
  ): string | CallableAdapterDecodedArtifact;
  classifyFailure?(stdout: string): CallableAdapterSafeErrorCode;
  resolveCheckpoint?(
    context: Readonly<AgentConnectorContext>
  ): string | null | Promise<string | null>;
}

export interface ExecutionAuthority {
  schemaVersion: 3;
  authorityId: string;
  taskId: string;
  connectorId: string;
  childAgentId: string;
  capabilityId: string;
  inputDigest: string;
  issuedAt: string;
  expiresAt: string;
  singleUse: true;
  workspaceId: string;
  workspaceRevision: number;
  workspaceAccess: WorkspaceAccess[];
  userFileAccess: "none";
  commandPolicy: "fixed_connector_entrypoint";
  networkPolicy: "child_agent_managed";
  executionEpoch: number;
}

export interface ExecutionExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExecutionTransportHandle {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly completion: Promise<ExecutionExit>;
  writeInput(text: string): Promise<void>;
  terminate(graceMs: number): Promise<void>;
  forceKill(): void;
}

export interface ExecutionTransport {
  readonly kind: ExecutionTransportKind;
  start(input: {
    spec: ExecutionSpec;
    workspacePath: string | null;
  }): ExecutionTransportHandle;
}

export interface TetiHostAgentTarget {
  connectorId: string;
  childAgentId: string;
  capabilityId: string;
}

export interface TetiHostAgent {
  registerConnector(connector: AgentConnector, readyAt?: string): AgentConnectorDescriptor;
  unregisterConnector(connectorId: string): boolean;
  getCallableAgents(): CallableAgent[];
  getComputeOffers(): AgentComputeOffer[];
  getLocalChildAgents(): LocalChildAgent[];
  resolveTarget(
    offerId: string,
    capabilityId: string,
    requiredInputModes?: readonly AgentTaskContentMode[]
  ): TetiHostAgentTarget | null;
  prepareExecution(input: PrepareExecutionHandleInput): Promise<ExecutionHandle>;
  getExecutionHandle(taskId: string): Promise<ExecutionHandle | null>;
  reconcileExecutionHandles(): Promise<ExecutionHandle[]>;
  execute(
    request: CallableAdapterTaskRequest,
    authority: ExecutionAuthority
  ): Promise<CallableAdapterTaskSnapshot>;
  getTask(taskId: string): CallableAdapterTaskSnapshot | null;
  cancel(taskId: string): boolean;
  shutdown(): Promise<void>;
}

export class HostChildAgentContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostChildAgentContractError";
    this.code = code;
  }
}

const SAFE_SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validateAgentConnector(connector: AgentConnector): void {
  const descriptor = connector.descriptor;
  validateAgentConnectorDescriptor(descriptor);
  validateAgentResourceBinding(connector.resourceBinding, descriptor);
  if (connector.computeOffer) validateAgentComputeOffer(connector.computeOffer, descriptor);
  if (descriptor.executionCapabilities.supportsCheckpoint !== Boolean(connector.resolveCheckpoint)) {
    throw agentCoreError(
      "CONNECTOR_CHECKPOINT_HANDLER",
      "Connector checkpoint capability must match its checkpoint handler."
    );
  }
  if (descriptor.transportKind === "process") {
    if (!connector.fixedProcessEntrypoint) {
      throw agentCoreError("CONNECTOR_ENTRYPOINT", "Process Connector requires a fixed local entrypoint.");
    }
    validateCallableAdapterLaunchSpec({
      executable: connector.fixedProcessEntrypoint,
      args: []
    });
  } else if (connector.fixedProcessEntrypoint !== undefined) {
    throw agentCoreError("CONNECTOR_ENTRYPOINT", "Only Process Connectors may declare an entrypoint.");
  }
}

export function validateAgentComputeOffer(
  value: AgentComputeOffer,
  descriptor: AgentConnectorDescriptor
): void {
  exactKeys(value, [
    "offerId",
    "capability",
    "resourceClass",
    "executionLocation",
    "inputModes",
    "outputModes",
    "concurrency",
    "approval"
  ], "Agent Compute Offer");
  safeSlug(value.offerId, "offerId");
  if (value.capability !== "general-text-assistance"
    || (value.resourceClass !== "local_model" && value.resourceClass !== "native_agent")
    || value.executionLocation !== "receiver_local"
    || value.inputModes.length !== 1
    || value.inputModes[0] !== "text"
    || value.outputModes.length !== 1
    || value.outputModes[0] !== "text"
    || value.concurrency !== 1
    || value.approval !== "allow_once"
    || descriptor.maxConcurrentExecutions !== value.concurrency
    || !descriptor.capabilityIds.includes(value.capability)
    || !value.inputModes.every((mode) => descriptor.inputModes.includes(mode))
    || !value.outputModes.every((mode) => descriptor.outputModes.includes(mode))) {
    throw agentCoreError("CONNECTOR_COMPUTE_OFFER", "Agent Compute Offer does not match its local Connector.");
  }
  if ((value.resourceClass === "local_model"
      && (descriptor.origin !== "runtime_facade" || descriptor.workspacePolicy !== "none"))
    || (value.resourceClass === "native_agent"
      && (descriptor.origin !== "native_agent" || descriptor.workspacePolicy !== "bounded_context"))) {
    throw agentCoreError("CONNECTOR_COMPUTE_OFFER", "Agent Compute Offer authority does not match its Connector.");
  }
}

export function validateAgentConnectorDescriptor(value: AgentConnectorDescriptor): void {
  exactKeysWithOptional(value, [
    "contractVersion",
    "connectorId",
    "connectorRevision",
    "childAgentId",
    "capabilityIds",
    "inputModes",
    "outputModes",
    "transportKind",
    "timeoutMs",
    "cancelGraceMs",
    "maxOutputBytes",
    "executionCapabilities",
    "executionSemantics"
  ], [
    "origin",
    "workspacePolicy",
    "maxConcurrentExecutions",
    "maxQueuedExecutions"
  ], "Agent Connector descriptor");
  if (value.contractVersion !== TETI_HOST_CHILD_AGENT_CORE_VERSION) {
    throw agentCoreError("CONNECTOR_VERSION", "Unsupported Agent Connector contract version.");
  }
  validateConnectorExecutionCapabilities(value.executionCapabilities);
  if (value.executionSemantics !== "workspace_pure_compute"
    && value.executionSemantics !== "external_side_effects_possible") {
    throw agentCoreError("CONNECTOR_EXECUTION_SEMANTICS", "Connector execution semantics are invalid.");
  }
  if ((value.executionCapabilities.supportsResume
      || value.executionCapabilities.supportsCheckpoint)
    && value.executionSemantics !== "workspace_pure_compute") {
    throw agentCoreError(
      "CONNECTOR_RESUME_SIDE_EFFECTS",
      "Only Workspace-pure Connectors may declare checkpoint resume."
    );
  }
  validateCallableAdapterDescriptor(connectorDescriptorAsAdapterDescriptor(value));
  if (value.transportKind !== "process"
    && value.transportKind !== "fake"
    && value.transportKind !== "loopback_http"
    && value.transportKind !== "osaurus_agent") {
    throw agentCoreError("CONNECTOR_TRANSPORT", "Agent Connector transport kind is invalid.");
  }
  const origin = value.origin ?? "native_agent";
  const workspacePolicy = value.workspacePolicy ?? "snapshot";
  if (origin !== "native_agent" && origin !== "runtime_facade") {
    throw agentCoreError("CONNECTOR_ORIGIN", "Agent Connector origin is invalid.");
  }
  if (workspacePolicy !== "snapshot" && workspacePolicy !== "bounded_context" && workspacePolicy !== "none") {
    throw agentCoreError("CONNECTOR_WORKSPACE", "Agent Connector Workspace policy is invalid.");
  }
  if (value.transportKind === "process" && workspacePolicy !== "snapshot") {
    throw agentCoreError("CONNECTOR_WORKSPACE", "Process Connectors require a Host Workspace Snapshot.");
  }
  if (value.transportKind === "loopback_http"
    && (origin !== "runtime_facade" || workspacePolicy !== "none")) {
    throw agentCoreError(
      "CONNECTOR_RUNTIME_FACADE",
      "Loopback HTTP Connectors must be Workspace-free Runtime facades."
    );
  }
  if (value.transportKind === "osaurus_agent"
    && (origin !== "native_agent" || workspacePolicy !== "bounded_context")) {
    throw agentCoreError(
      "CONNECTOR_NATIVE_AGENT",
      "Osaurus Agent Connectors require a bounded Host-selected context and native Agent origin."
    );
  }
  if (value.maxConcurrentExecutions !== undefined
    && (!Number.isInteger(value.maxConcurrentExecutions)
      || value.maxConcurrentExecutions < 1
      || value.maxConcurrentExecutions > 32)) {
    throw agentCoreError("CONNECTOR_CONCURRENCY", "Agent Connector concurrency limit is invalid.");
  }
  if (value.maxQueuedExecutions !== undefined
    && (!Number.isInteger(value.maxQueuedExecutions)
      || value.maxQueuedExecutions < 1
      || value.maxQueuedExecutions > 32)) {
    throw agentCoreError("CONNECTOR_QUEUE", "Agent Connector queue limit is invalid.");
  }
  if (value.executionCapabilities.supportsCheckpoint && value.workspacePolicy !== "snapshot") {
    throw agentCoreError(
      "CONNECTOR_CHECKPOINT_WORKSPACE",
      "Checkpoint-capable Connectors require a Host Workspace Snapshot."
    );
  }
}

export function validateAgentResourceBinding(
  value: AgentResourceBinding,
  descriptor?: AgentConnectorDescriptor
): void {
  exactKeys(value, [
    "schemaVersion",
    "bindingId",
    "childAgentId",
    "connectorId",
    "transportKind",
    "capabilityIds"
  ], "Agent Resource Binding");
  if (value.schemaVersion !== 1) {
    throw agentCoreError("RESOURCE_BINDING_VERSION", "Unsupported Agent Resource Binding version.");
  }
  safeId(value.bindingId, "bindingId");
  safeSlug(value.childAgentId, "childAgentId");
  safeSlug(value.connectorId, "connectorId");
  if (value.transportKind !== "process"
    && value.transportKind !== "fake"
    && value.transportKind !== "loopback_http"
    && value.transportKind !== "osaurus_agent") {
    throw agentCoreError("RESOURCE_BINDING_TRANSPORT", "Agent Resource Binding transport is invalid.");
  }
  if (!Array.isArray(value.capabilityIds)
    || value.capabilityIds.length === 0
    || new Set(value.capabilityIds).size !== value.capabilityIds.length) {
    throw agentCoreError("RESOURCE_BINDING_CAPABILITY", "Agent Resource Binding capabilities are invalid.");
  }
  value.capabilityIds.forEach((capabilityId) => safeSlug(capabilityId, "capabilityId"));
  if (descriptor && (value.childAgentId !== descriptor.childAgentId
    || value.connectorId !== descriptor.connectorId
    || value.transportKind !== descriptor.transportKind
    || !sameStrings(value.capabilityIds, descriptor.capabilityIds))) {
    throw agentCoreError("RESOURCE_BINDING_MISMATCH", "Agent Resource Binding does not match its Connector.");
  }
}

export function validateExecutionSpec(
  value: ExecutionSpec,
  connector: AgentConnector
): void {
  if (!value || typeof value !== "object" || value.kind !== connector.descriptor.transportKind) {
    throw agentCoreError("EXECUTION_SPEC_TRANSPORT", "Execution specification does not match its Connector transport.");
  }
  switch (value.kind) {
    case "process":
      exactKeys(value, ["kind", "executable", "args", "environment"], "Process execution specification", true);
      validateCallableAdapterLaunchSpec({
        executable: value.executable,
        args: value.args,
        ...(value.environment ? { environment: value.environment } : {})
      }, connector.fixedProcessEntrypoint);
      return;
    case "fake":
      exactKeys(value, ["kind", "scenarioId"], "Fake execution specification");
      safeId(value.scenarioId, "scenarioId");
      return;
    case "loopback_http":
      exactKeys(value, [
        "kind",
        "endpoint",
        "requestId",
        "runtimeInstanceId",
        "model",
        "listenerPid",
        "codeIdentityHash"
      ], "Loopback HTTP execution specification");
      if (!SAFE_ID_PATTERN.test(value.requestId)
        || !SAFE_ID_PATTERN.test(value.runtimeInstanceId)
        || !isLoopbackHttpEndpoint(value.endpoint)
        || !SAFE_MODEL_ID_PATTERN.test(value.model)
        || value.model.includes("..")
        || value.model.endsWith("/")
        || !Number.isSafeInteger(value.listenerPid)
        || value.listenerPid <= 0
        || !SHA256_PATTERN.test(value.codeIdentityHash)) {
        throw agentCoreError("EXECUTION_SPEC_LOOPBACK", "Loopback HTTP execution specification is invalid.");
      }
      return;
    case "osaurus_agent":
      exactKeys(value, [
        "kind",
        "endpoint",
        "requestId",
        "runtimeInstanceId",
        "agentId",
        "effectiveModel",
        "listenerPid",
        "codeIdentityHash",
        "agentConfigurationDigest",
        "providerAuthority"
      ], "Osaurus Agent execution specification");
      exactKeys(value.providerAuthority, [
        "tools",
        "memory",
        "hostWorkspace",
        "autonomousExec"
      ], "Osaurus Agent provider authority");
      if (!SAFE_ID_PATTERN.test(value.requestId)
        || !SAFE_ID_PATTERN.test(value.runtimeInstanceId)
        || !isLoopbackHttpEndpoint(value.endpoint)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.agentId)
        || !SAFE_MODEL_ID_PATTERN.test(value.effectiveModel)
        || value.effectiveModel.includes("..")
        || value.effectiveModel.endsWith("/")
        || !Number.isSafeInteger(value.listenerPid)
        || value.listenerPid <= 0
        || !SHA256_PATTERN.test(value.codeIdentityHash)
        || !SHA256_PATTERN.test(value.agentConfigurationDigest)
        || Object.values(value.providerAuthority).some((decision) => decision !== "deny")) {
        throw agentCoreError("EXECUTION_SPEC_OSAURUS_AGENT", "Osaurus Agent execution specification is invalid.");
      }
      return;
  }
}

export function validateExecutionAuthority(
  value: ExecutionAuthority,
  request: CallableAdapterTaskRequest,
  connector: AgentConnector,
  now = new Date()
): void {
  exactKeys(value, [
    "schemaVersion",
    "authorityId",
    "taskId",
    "connectorId",
    "childAgentId",
    "capabilityId",
    "inputDigest",
    "issuedAt",
    "expiresAt",
    "singleUse",
    "workspaceId",
    "workspaceRevision",
    "workspaceAccess",
    "userFileAccess",
    "commandPolicy",
    "networkPolicy",
    "executionEpoch"
  ], "Execution Authority");
  if (value.schemaVersion !== TETI_EXECUTION_AUTHORITY_SCHEMA_VERSION) {
    throw agentCoreError("EXECUTION_AUTHORITY_VERSION", "Unsupported Execution Authority version.");
  }
  if (!Number.isSafeInteger(value.executionEpoch) || value.executionEpoch < 1) {
    throw agentCoreError("EXECUTION_AUTHORITY_EPOCH", "Execution Authority epoch is invalid.");
  }
  safeId(value.authorityId, "authorityId");
  safeId(value.taskId, "taskId");
  safeSlug(value.connectorId, "connectorId");
  safeSlug(value.childAgentId, "childAgentId");
  safeSlug(value.capabilityId, "capabilityId");
  safeId(value.workspaceId, "workspaceId");
  if (!Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision <= 0) {
    throw agentCoreError("EXECUTION_AUTHORITY_WORKSPACE", "Execution Authority Workspace revision is invalid.");
  }
  try {
    validateWorkspaceAccess(value.workspaceAccess);
  } catch {
    throw agentCoreError("EXECUTION_AUTHORITY_WORKSPACE", "Execution Authority Workspace access is invalid.");
  }
  if (value.taskId !== request.taskId
    || value.connectorId !== connector.descriptor.connectorId
    || value.childAgentId !== connector.descriptor.childAgentId
    || value.capabilityId !== request.capabilityId) {
    throw agentCoreError("EXECUTION_AUTHORITY_TARGET", "Execution Authority target does not match the local task.");
  }
  if (!SHA256_PATTERN.test(value.inputDigest)
    || value.inputDigest !== digestHostAgentTaskInput(request)) {
    throw agentCoreError("EXECUTION_AUTHORITY_INPUT", "Execution Authority input digest does not match the local task.");
  }
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 5 * 60 * 1_000
    || now.getTime() > expiresAt
    || issuedAt > now.getTime() + 30_000) {
    throw agentCoreError("EXECUTION_AUTHORITY_EXPIRY", "Execution Authority is expired or invalid.");
  }
  if (value.singleUse !== true
    || value.userFileAccess !== "none"
    || value.commandPolicy !== "fixed_connector_entrypoint"
    || value.networkPolicy !== "child_agent_managed") {
    throw agentCoreError("EXECUTION_AUTHORITY_SCOPE", "Execution Authority scope is invalid.");
  }
}

export function digestHostAgentTaskInput(request: CallableAdapterTaskRequest): string {
  const images = (request.input.images ?? []).map((image) => ({
    attachmentId: image.attachmentId,
    mimeType: image.mimeType,
    path: image.path
  }));
  const canonical = JSON.stringify({
    schemaVersion: request.schemaVersion,
    taskId: request.taskId,
    connectorId: request.adapterId,
    childAgentId: request.agentId,
    capabilityId: request.capabilityId,
    input: { kind: request.input.kind, text: request.input.text, images }
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function issueExecutionAuthority(
  request: CallableAdapterTaskRequest,
  options: {
    authorityId?: string;
    issuedAt?: string;
    expiresAt?: string;
    now?: Date;
    ttlMs?: number;
    workspaceId?: string;
    workspaceRevision?: number;
    workspaceAccess?: WorkspaceAccess[];
    executionEpoch?: number;
  } = {}
): ExecutionAuthority {
  const now = options.now ?? new Date();
  const issuedAt = options.issuedAt ?? now.toISOString();
  const expiresAt = options.expiresAt
    ?? new Date(now.getTime() + (options.ttlMs ?? 2 * 60 * 1_000)).toISOString();
  return {
    schemaVersion: 3,
    authorityId: options.authorityId ?? randomUUID(),
    taskId: request.taskId,
    connectorId: request.adapterId,
    childAgentId: request.agentId,
    capabilityId: request.capabilityId,
    inputDigest: digestHostAgentTaskInput(request),
    issuedAt,
    expiresAt,
    singleUse: true,
    workspaceId: options.workspaceId ?? `workspace:${request.taskId}`,
    workspaceRevision: options.workspaceRevision ?? 1,
    workspaceAccess: options.workspaceAccess ?? ["read", "write", "create_artifact"],
    userFileAccess: "none",
    commandPolicy: "fixed_connector_entrypoint",
    networkPolicy: "child_agent_managed",
    executionEpoch: options.executionEpoch ?? 1
  };
}

export function connectorDescriptorAsAdapterDescriptor(
  value: AgentConnectorDescriptor
): CallableAdapterDescriptor {
  return {
    contractVersion: 2,
    adapterId: value.connectorId,
    adapterRevision: value.connectorRevision,
    agentId: value.childAgentId,
    capabilityIds: [...value.capabilityIds],
    inputModes: [...value.inputModes],
    outputModes: [...value.outputModes],
    timeoutMs: value.timeoutMs,
    cancelGraceMs: value.cancelGraceMs,
    maxOutputBytes: value.maxOutputBytes
  };
}

export function localChildAgentFromConnectors(
  childAgentId: string,
  connectors: readonly AgentConnector[]
): LocalChildAgent {
  const origins = uniqueSorted(connectors.map((connector) => connector.descriptor.origin ?? "native_agent"));
  const workspacePolicies = uniqueSorted(
    connectors.map((connector) => connector.descriptor.workspacePolicy ?? "snapshot")
  );
  const concurrencyLimits = uniqueSorted(connectors
    .map((connector) => connector.descriptor.maxConcurrentExecutions)
    .filter((value): value is number => value !== undefined)
    .map(String));
  if (origins.length !== 1 || workspacePolicies.length !== 1 || concurrencyLimits.length > 1) {
    throw agentCoreError(
      "CHILD_AGENT_CONTRACT_MISMATCH",
      "Connectors for one Child Agent must share origin, Workspace policy, and concurrency."
    );
  }
  const capabilityIds = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.capabilityIds));
  const inputModes = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.inputModes));
  const outputModes = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.outputModes));
  return {
    schemaVersion: 1,
    childAgentId,
    origin: origins[0],
    workspacePolicy: workspacePolicies[0],
    maxConcurrentExecutions: concurrencyLimits.length === 0 ? null : Number(concurrencyLimits[0]),
    connectorIds: connectors.map((connector) => connector.descriptor.connectorId).sort(),
    resourceBindingIds: connectors.map((connector) => connector.resourceBinding.bindingId).sort(),
    capabilityIds,
    inputModes,
    outputModes
  };
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  optionalLast = false
): void {
  const keys = Object.keys(value);
  const extra = keys.find((key) => !allowed.includes(key));
  const required = optionalLast ? allowed.slice(0, -1) : allowed;
  const missing = required.find((key) => !keys.includes(key));
  if (extra || missing) {
    throw agentCoreError("AGENT_CORE_FIELDS", `${label} fields are invalid.`);
  }
}

function exactKeysWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const keys = Object.keys(value);
  const allowed = [...required, ...optional];
  const extra = keys.find((key) => !allowed.includes(key));
  const missing = required.find((key) => !keys.includes(key));
  if (extra || missing) {
    throw agentCoreError("AGENT_CORE_FIELDS", `${label} fields are invalid.`);
  }
}

function isLoopbackHttpEndpoint(value: string): boolean {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:"
      && endpoint.hostname === "127.0.0.1"
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.search === ""
      && endpoint.hash === ""
      && endpoint.pathname === "/v1/chat/completions"
      && endpoint.port !== "";
  } catch {
    return false;
  }
}

function safeSlug(value: string, label: string): void {
  if (typeof value !== "string" || value.length > 128 || !SAFE_SLUG_PATTERN.test(value)) {
    throw agentCoreError("AGENT_CORE_IDENTIFIER", `Host/Child Agent ${label} is invalid.`);
  }
}

function safeId(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw agentCoreError("AGENT_CORE_IDENTIFIER", `Host/Child Agent ${label} is invalid.`);
  }
}

function agentCoreError(code: string, message: string): HostChildAgentContractError {
  return new HostChildAgentContractError(code, message);
}
