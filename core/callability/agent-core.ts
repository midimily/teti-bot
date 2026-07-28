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

export const TETI_HOST_CHILD_AGENT_CORE_VERSION = 1;
export const TETI_EXECUTION_AUTHORITY_SCHEMA_VERSION = 1;

export type ExecutionTransportKind = "process" | "fake" | "loopback_http";

export interface AgentConnectorDescriptor {
  contractVersion: 1;
  connectorId: string;
  connectorRevision: number;
  childAgentId: string;
  capabilityIds: string[];
  inputModes: readonly AgentTaskContentMode[];
  outputModes: readonly AgentTaskContentMode[];
  transportKind: ExecutionTransportKind;
  timeoutMs: number;
  cancelGraceMs: number;
  maxOutputBytes: number;
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
  workspacePath: string;
  images: CallableAdapterImageInput[];
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

/** Reserved contract only. No 0.2.1 Connector is allowed to select it. */
export interface LoopbackHttpExecutionSpec {
  kind: "loopback_http";
  endpoint: string;
  requestId: string;
}

export type ExecutionSpec =
  | ProcessExecutionSpec
  | FakeExecutionSpec
  | LoopbackHttpExecutionSpec;

export interface AgentConnector {
  readonly descriptor: AgentConnectorDescriptor;
  readonly resourceBinding: AgentResourceBinding;
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
}

export interface ExecutionAuthority {
  schemaVersion: 1;
  authorityId: string;
  taskId: string;
  connectorId: string;
  childAgentId: string;
  capabilityId: string;
  inputDigest: string;
  issuedAt: string;
  expiresAt: string;
  singleUse: true;
  workspaceAccess: "isolated_task_directory";
  userFileAccess: "none";
  commandPolicy: "fixed_connector_entrypoint";
  networkPolicy: "child_agent_managed";
}

export interface ExecutionExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExecutionHandle {
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
    workspacePath: string;
  }): ExecutionHandle;
}

export interface TetiHostAgentTarget {
  connectorId: string;
  childAgentId: string;
  capabilityId: string;
}

export interface TetiHostAgent {
  registerConnector(connector: AgentConnector, readyAt?: string): AgentConnectorDescriptor;
  getCallableAgents(): CallableAgent[];
  getLocalChildAgents(): LocalChildAgent[];
  resolveTarget(
    capabilityId: string,
    requiredInputModes?: readonly AgentTaskContentMode[]
  ): TetiHostAgentTarget | null;
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
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validateAgentConnector(connector: AgentConnector): void {
  const descriptor = connector.descriptor;
  validateAgentConnectorDescriptor(descriptor);
  validateAgentResourceBinding(connector.resourceBinding, descriptor);
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

export function validateAgentConnectorDescriptor(value: AgentConnectorDescriptor): void {
  exactKeys(value, [
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
    "maxOutputBytes"
  ], "Agent Connector descriptor");
  if (value.contractVersion !== TETI_HOST_CHILD_AGENT_CORE_VERSION) {
    throw agentCoreError("CONNECTOR_VERSION", "Unsupported Agent Connector contract version.");
  }
  validateCallableAdapterDescriptor(connectorDescriptorAsAdapterDescriptor(value));
  if (value.transportKind !== "process"
    && value.transportKind !== "fake"
    && value.transportKind !== "loopback_http") {
    throw agentCoreError("CONNECTOR_TRANSPORT", "Agent Connector transport kind is invalid.");
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
    && value.transportKind !== "loopback_http") {
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
      exactKeys(value, ["kind", "endpoint", "requestId"], "Loopback HTTP execution specification");
      if (!SAFE_ID_PATTERN.test(value.requestId) || !isLoopbackHttpEndpoint(value.endpoint)) {
        throw agentCoreError("EXECUTION_SPEC_LOOPBACK", "Loopback HTTP execution specification is invalid.");
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
    "workspaceAccess",
    "userFileAccess",
    "commandPolicy",
    "networkPolicy"
  ], "Execution Authority");
  if (value.schemaVersion !== TETI_EXECUTION_AUTHORITY_SCHEMA_VERSION) {
    throw agentCoreError("EXECUTION_AUTHORITY_VERSION", "Unsupported Execution Authority version.");
  }
  safeId(value.authorityId, "authorityId");
  safeId(value.taskId, "taskId");
  safeSlug(value.connectorId, "connectorId");
  safeSlug(value.childAgentId, "childAgentId");
  safeSlug(value.capabilityId, "capabilityId");
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
    || value.workspaceAccess !== "isolated_task_directory"
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
  } = {}
): ExecutionAuthority {
  const now = options.now ?? new Date();
  const issuedAt = options.issuedAt ?? now.toISOString();
  const expiresAt = options.expiresAt
    ?? new Date(now.getTime() + (options.ttlMs ?? 2 * 60 * 1_000)).toISOString();
  return {
    schemaVersion: 1,
    authorityId: options.authorityId ?? randomUUID(),
    taskId: request.taskId,
    connectorId: request.adapterId,
    childAgentId: request.agentId,
    capabilityId: request.capabilityId,
    inputDigest: digestHostAgentTaskInput(request),
    issuedAt,
    expiresAt,
    singleUse: true,
    workspaceAccess: "isolated_task_directory",
    userFileAccess: "none",
    commandPolicy: "fixed_connector_entrypoint",
    networkPolicy: "child_agent_managed"
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
  const capabilityIds = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.capabilityIds));
  const inputModes = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.inputModes));
  const outputModes = uniqueSorted(connectors.flatMap((connector) => connector.descriptor.outputModes));
  return {
    schemaVersion: 1,
    childAgentId,
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

function isLoopbackHttpEndpoint(value: string): boolean {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:"
      && (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]")
      && endpoint.username === ""
      && endpoint.password === "";
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
