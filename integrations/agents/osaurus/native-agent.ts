import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentAdapterReadiness } from "../../../core/callability/types.ts";
import { CallableAdapterOutputError } from "../../../core/callability/adapter.ts";
import {
  TETI_OSAURUS_NATIVE_TEXT_OFFER_ID,
  type AgentConnector,
  type AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import {
  decodeLoopbackFailure,
  LoopbackRuntimeIdentityError,
  type OsaurusAgentAuthorityVerifier
} from "../../../apps/desktop/lifecycle-sidecar/runtime/callable/transports/loopback-http.ts";
import {
  inspectCurrentOsaurusInsightsRetention,
  trustedLoopbackJson,
  type OsaurusInsightsRetention,
  type OsaurusRuntimeTrustVerifier
} from "./connector.ts";
import {
  OsaurusRuntimeIdentityVerifier,
  type OsaurusRuntimeDiscovery,
  type OsaurusRuntimeIdentity
} from "./runtime-identity.ts";

export const OSAURUS_NATIVE_CHILD = {
  connectorId: "osaurus.native.teti-agent",
  childAgentId: "osaurus-native-teti",
  connectorRevision: 1,
  capabilityIds: ["general-text-assistance"],
  minimumRuntimeVersion: "0.22.2",
  timeoutMs: 15 * 60 * 1_000,
  cancelGraceMs: 2_000,
  maxOutputBytes: 512 * 1024
} as const;

export const OSAURUS_NATIVE_CONFIG_SCHEMA_VERSION = 1;
export const OSAURUS_NATIVE_CONFIG_MAX_BYTES = 4 * 1024;
export const OSAURUS_AGENT_RECORD_MAX_BYTES = 512 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

export interface OsaurusNativeChildConfiguration {
  schemaVersion: 1;
  agentId: string | null;
}

export interface OsaurusNativeAgentAudit {
  agentId: string;
  name: string;
  effectiveModel: string;
  updatedAt: string;
  configurationDigest: string;
  /** Observed Osaurus settings. They are not permissions granted by Teti. */
  providerAuthority: {
    tools: "enabled" | "disabled";
    memory: "enabled" | "disabled";
    hostWorkspace: "disabled";
    autonomousExec: "enabled" | "disabled";
  };
}

export interface OsaurusNativeAgentPolicyAuditor extends OsaurusAgentAuthorityVerifier {
  inspect(agentId: string): Promise<OsaurusNativeAgentAudit>;
}

export class FileOsaurusNativeAgentPolicyAuditor implements OsaurusNativeAgentPolicyAuditor {
  readonly agentsRoot: string;

  constructor(root = join(homedir(), ".osaurus", "agents")) {
    if (!isAbsolute(root) || resolve(root) === "/") throw new Error("Osaurus Agent root is invalid.");
    this.agentsRoot = resolve(root);
  }

  async inspect(agentId: string): Promise<OsaurusNativeAgentAudit> {
    const normalizedId = normalizeAgentId(agentId);
    const rootInfo = await lstat(this.agentsRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Osaurus Agent store is unsafe.");
    const path = join(this.agentsRoot, `${normalizedId}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > OSAURUS_AGENT_RECORD_MAX_BYTES) {
      throw new Error("Osaurus Agent record is unsafe.");
    }
    const data = await readFile(path);
    const record = asRecord(JSON.parse(data.toString("utf8")));
    const tools = providerToggle(record?.toolsEnabled);
    const memory = providerToggle(record?.memoryEnabled);
    const autonomousExec = autonomousExecState(record?.autonomousExec);
    if (!record
      || normalizeAgentId(record.id) !== normalizedId
      || record.isBuiltIn !== false
      || tools === null
      || memory === null
      || autonomousExec === null
      || !providerValueAbsent(record.hostWorkspaceBookmark)
      || !providerValueAbsent(record.hostWorkspacePath)
      || typeof record.name !== "string"
      || !record.name.trim()
      || record.name.length > 160
      || typeof record.defaultModel !== "string"
      || !MODEL_PATTERN.test(record.defaultModel)
      || record.defaultModel.includes("..")
      || record.defaultModel.endsWith("/")
      || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new Error("Osaurus Agent authority is not safely constrained.");
    }
    return {
      agentId: normalizedId,
      name: record.name.trim(),
      effectiveModel: record.defaultModel,
      updatedAt: record.updatedAt,
      configurationDigest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      providerAuthority: {
        tools,
        memory,
        hostWorkspace: "disabled",
        autonomousExec
      }
    };
  }

  async verifyAgentAuthority(input: {
    agentId: string;
    agentConfigurationDigest: string;
  }): Promise<void> {
    try {
      const audit = await this.inspect(input.agentId);
      if (audit.configurationDigest !== input.agentConfigurationDigest) throw new Error("changed");
    } catch {
      throw new LoopbackRuntimeIdentityError();
    }
  }
}

export async function readOsaurusNativeChildConfiguration(
  path: string,
  environmentAgentId?: string
): Promise<OsaurusNativeChildConfiguration | null> {
  if (!isAbsolute(path) || resolve(path) === "/") throw new Error("Osaurus Native config path is invalid.");
  if (environmentAgentId?.trim()) {
    return { schemaVersion: 1, agentId: normalizeAgentId(environmentAgentId) };
  }
  try {
    const parent = await lstat(dirname(path));
    const info = await lstat(path);
    if (!parent.isDirectory()
      || parent.isSymbolicLink()
      || !info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0
      || info.size > OSAURUS_NATIVE_CONFIG_MAX_BYTES) {
      throw new Error("Osaurus Native config is unsafe.");
    }
    const record = asRecord(JSON.parse(await readFile(path, "utf8")));
    if (!record
      || Object.keys(record).sort().join(",") !== "agentId,schemaVersion"
      || record.schemaVersion !== OSAURUS_NATIVE_CONFIG_SCHEMA_VERSION) {
      throw new Error("Osaurus Native config is invalid.");
    }
    return {
      schemaVersion: 1,
      agentId: record.agentId === null ? null : normalizeAgentId(record.agentId)
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeOsaurusNativeChildConfiguration(
  path: string,
  agentId: string | null
): Promise<OsaurusNativeChildConfiguration> {
  if (!isAbsolute(path) || resolve(path) === "/") throw new Error("Osaurus Native config path is invalid.");
  const configuration: OsaurusNativeChildConfiguration = {
    schemaVersion: 1,
    agentId: agentId === null || !agentId.trim() ? null : normalizeAgentId(agentId)
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return structuredClone(configuration);
}

interface QualifiedNativeState {
  identity: OsaurusRuntimeIdentity;
  audit: OsaurusNativeAgentAudit;
}

export interface QualifyOsaurusNativeConnectorOptions {
  agentId?: string | null;
  signal?: AbortSignal;
  now?: () => Date;
  trustVerifier?: OsaurusRuntimeTrustVerifier;
  policyAuditor?: OsaurusNativeAgentPolicyAuditor;
  probeAgent?: (
    identity: OsaurusRuntimeIdentity,
    verifier: OsaurusRuntimeTrustVerifier,
    agentId: string
  ) => Promise<unknown>;
  inspectInsightsRetention?: (identity: OsaurusRuntimeIdentity) => Promise<OsaurusInsightsRetention>;
}

export interface OsaurusNativeConnectorQualification {
  readiness: AgentAdapterReadiness;
  connector: OsaurusNativeAgentConnector | null;
  identity: OsaurusRuntimeIdentity | null;
  audit: OsaurusNativeAgentAudit | null;
  releaseBlockers: string[];
  acceptedRisks: string[];
}

export class OsaurusNativeAgentConnector implements AgentConnector {
  readonly descriptor = {
    contractVersion: 2 as const,
    connectorId: OSAURUS_NATIVE_CHILD.connectorId,
    connectorRevision: OSAURUS_NATIVE_CHILD.connectorRevision,
    childAgentId: OSAURUS_NATIVE_CHILD.childAgentId,
    capabilityIds: [...OSAURUS_NATIVE_CHILD.capabilityIds],
    inputModes: ["text"] as const,
    outputModes: ["text"] as const,
    transportKind: "osaurus_agent" as const,
    origin: "native_agent" as const,
    workspacePolicy: "bounded_context" as const,
    maxConcurrentExecutions: 1,
    maxQueuedExecutions: 8,
    executionCapabilities: {
      supportsProgress: false,
      supportsPause: false,
      supportsResume: false,
      supportsCheckpoint: false,
      supportsCancel: true
    },
    executionSemantics: "external_side_effects_possible" as const,
    timeoutMs: OSAURUS_NATIVE_CHILD.timeoutMs,
    cancelGraceMs: OSAURUS_NATIVE_CHILD.cancelGraceMs,
    maxOutputBytes: OSAURUS_NATIVE_CHILD.maxOutputBytes
  };
  readonly computeOffer = {
    offerId: TETI_OSAURUS_NATIVE_TEXT_OFFER_ID,
    capability: "general-text-assistance" as const,
    resourceClass: "native_agent" as const,
    executionLocation: "receiver_local" as const,
    inputModes: ["text"] as const,
    outputModes: ["text"] as const,
    concurrency: 1 as const,
    approval: "allow_once" as const
  };
  readonly resourceBinding = {
    schemaVersion: 1 as const,
    bindingId: "osaurus.loopback.native-teti-agent",
    childAgentId: OSAURUS_NATIVE_CHILD.childAgentId,
    connectorId: OSAURUS_NATIVE_CHILD.connectorId,
    transportKind: "osaurus_agent" as const,
    capabilityIds: [...OSAURUS_NATIVE_CHILD.capabilityIds]
  };
  private readonly initial: QualifiedNativeState;
  private readonly refresh: () => Promise<QualifiedNativeState>;

  constructor(initial: QualifiedNativeState, refresh: () => Promise<QualifiedNativeState>) {
    this.initial = structuredClone(initial);
    this.refresh = refresh;
  }

  async createExecutionSpec(context: Readonly<AgentConnectorContext>) {
    if (context.workspacePath !== null || context.images.length !== 0) {
      throw new CallableAdapterOutputError(
        "ADAPTER_WORKSPACE_INVALID",
        "Osaurus Native Child refuses direct Host Workspace and image access."
      );
    }
    if (context.workspaceContext !== undefined
      && context.workspaceContext !== null
      && Buffer.byteLength(context.workspaceContext, "utf8") > 96 * 1024) {
      throw new CallableAdapterOutputError("ADAPTER_WORKSPACE_INVALID", "Workspace context exceeds its bound.");
    }
    const state = await this.refresh().catch(() => null);
    if (!state
      || state.audit.agentId !== this.initial.audit.agentId
      || state.audit.configurationDigest !== this.initial.audit.configurationDigest) {
      throw new CallableAdapterOutputError("ADAPTER_RUNTIME_UNTRUSTED", "Osaurus Agent readiness changed.");
    }
    return {
      kind: "osaurus_agent" as const,
      endpoint: state.identity.endpoint,
      requestId: context.taskId,
      runtimeInstanceId: state.identity.instanceId,
      agentId: state.audit.agentId,
      effectiveModel: state.audit.effectiveModel,
      listenerPid: state.identity.listenerPid,
      codeIdentityHash: state.identity.codeIdentityHash,
      agentConfigurationDigest: state.audit.configurationDigest,
      providerAuthority: structuredClone(state.audit.providerAuthority)
    };
  }

  classifyFailure(stdout: string) {
    return decodeLoopbackFailure(stdout) ?? "ADAPTER_EXIT_NONZERO";
  }
}

export async function qualifyOsaurusNativeConnector(
  options: QualifyOsaurusNativeConnectorOptions = {}
): Promise<OsaurusNativeConnectorQualification> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  if (!options.agentId) return blocked("not_detected", checkedAt, "OSAURUS_NATIVE_AGENT_NOT_CONFIGURED");
  let agentId: string;
  try {
    agentId = normalizeAgentId(options.agentId);
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_NATIVE_AGENT_ID_INVALID");
  }
  if (options.signal?.aborted) return blocked("degraded", checkedAt, "OSAURUS_NATIVE_QUALIFICATION_ABORTED");

  const trustVerifier = options.trustVerifier ?? new OsaurusRuntimeIdentityVerifier();
  let discovery: OsaurusRuntimeDiscovery;
  try {
    discovery = trustVerifier.discoverRuntime
      ? await trustVerifier.discoverRuntime()
      : await legacyDiscovery(trustVerifier);
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_RUNTIME_IDENTITY_FAILED");
  }
  if (discovery.state !== "trusted") {
    return blocked(
      discovery.state === "not_running" ? "not_detected" : "degraded",
      checkedAt,
      discovery.state === "not_running"
        ? "OSAURUS_TRUSTED_RUNTIME_NOT_RUNNING"
        : discovery.reasonCode ?? "OSAURUS_RUNTIME_UNTRUSTED"
    );
  }
  const identity = discovery.identity;
  if (!identity.appVersion
    || compareNumericVersions(identity.appVersion, OSAURUS_NATIVE_CHILD.minimumRuntimeVersion) < 0) {
    return blocked("detected", checkedAt, "OSAURUS_RUNTIME_VERSION_UNSUPPORTED", identity);
  }

  const auditor = options.policyAuditor ?? new FileOsaurusNativeAgentPolicyAuditor();
  let audit: OsaurusNativeAgentAudit;
  try {
    audit = await auditor.inspect(agentId);
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_NATIVE_AUTHORITY_UNSAFE", identity);
  }

  try {
    const apiAgent = asRecord(await (options.probeAgent
      ? options.probeAgent(identity, trustVerifier, agentId)
      : trustedLoopbackJson(identity, trustVerifier, `/agents/${encodeURIComponent(agentId)}`)));
    if (!apiAgent
      || normalizeAgentId(apiAgent.id) !== agentId
      || apiAgent.is_built_in !== false
      || typeof apiAgent.effective_model !== "string"
      || apiAgent.effective_model !== audit.effectiveModel
      || typeof apiAgent.updated_at !== "string"
      || Date.parse(apiAgent.updated_at) !== Date.parse(audit.updatedAt)) {
      throw new Error("metadata");
    }
  } catch {
    return blocked("degraded", checkedAt, "OSAURUS_NATIVE_METADATA_MISMATCH", identity, audit);
  }

  const insights = await (options.inspectInsightsRetention
    ?? inspectCurrentOsaurusInsightsRetention)(identity).catch(() => "unknown" as const);
  if (insights === "unknown") {
    return blocked(
      "degraded",
      checkedAt,
      "OSAURUS_INSIGHTS_POLICY_UNVERIFIED",
      identity,
      audit
    );
  }
  const acceptedRisks = insights === "retained"
    ? ["OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED"]
    : [];

  const state = { identity, audit };
  const refresh = async (): Promise<QualifiedNativeState> => {
    const result = await qualifyOsaurusNativeConnector(options);
    if (!result.connector || !result.identity || !result.audit) throw new Error(result.readiness.reasonCode);
    return { identity: result.identity, audit: result.audit };
  };
  return {
    readiness: readiness("ready", checkedAt, acceptedRisks[0]),
    connector: new OsaurusNativeAgentConnector(state, refresh),
    identity,
    audit,
    releaseBlockers: [],
    acceptedRisks
  };
}

function blocked(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode: string,
  identity: OsaurusRuntimeIdentity | null = null,
  audit: OsaurusNativeAgentAudit | null = null
): OsaurusNativeConnectorQualification {
  return {
    readiness: readiness(state, checkedAt, reasonCode),
    connector: null,
    identity,
    audit,
    releaseBlockers: [reasonCode],
    acceptedRisks: []
  };
}

function readiness(
  state: AgentAdapterReadiness["state"],
  checkedAt: string,
  reasonCode?: string
): AgentAdapterReadiness {
  return {
    schemaVersion: 1,
    agentId: OSAURUS_NATIVE_CHILD.childAgentId,
    adapterId: OSAURUS_NATIVE_CHILD.connectorId,
    adapterRevision: OSAURUS_NATIVE_CHILD.connectorRevision,
    state,
    capabilityIds: [...OSAURUS_NATIVE_CHILD.capabilityIds],
    inputModes: ["text"],
    outputModes: ["text"],
    checkedAt,
    ...(reasonCode ? { reasonCode } : {})
  };
}

function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Osaurus Agent ID is invalid.");
  return value.toUpperCase();
}

function autonomousExecState(value: unknown): "enabled" | "disabled" | null {
  if (value === null || value === undefined) return "disabled";
  const record = asRecord(value);
  return providerToggle(record?.enabled);
}

function providerToggle(value: unknown): "enabled" | "disabled" | null {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return null;
}

function providerValueAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function legacyDiscovery(verifier: OsaurusRuntimeTrustVerifier): Promise<OsaurusRuntimeDiscovery> {
  const identity = await verifier.discoverLatestTrustedRuntime();
  return identity ? { state: "trusted", identity } : { state: "not_running", identity: null };
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split(/[.+_-]/).map(toVersionPart);
  const rightParts = right.split(/[.+_-]/).map(toVersionPart);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function toVersionPart(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : -1;
}
