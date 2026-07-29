import {
  TETI_AI_STATUS_AGENT_SCHEMA_VERSION,
  TETI_AI_STATUS_CALLABLE_SCHEMA_VERSION,
  TETI_AI_STATUS_LEGACY_SCHEMA_VERSION,
  TETI_AI_STATUS_SCHEMA_VERSION,
  type AiAgentStatusSnapshot,
  type AiStatusSyncPayload,
  type AiToolQuotaStatus,
  type AiToolStatusSnapshot
} from "./types.ts";
import type {
  CallablePassportAgent,
  CapabilityBinding,
  ComputeOffer,
  TetiCapability
} from "../passport/types.ts";

const MAX_TOOLS = 8;
const MAX_AGENTS = 64;
const MAX_CAPABILITIES = 64;
const MAX_BINDINGS = 64;
const MAX_COMPUTE_OFFERS = 32;
const MAX_QUOTAS_PER_TOOL = 8;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOOL_ID_LENGTH = 64;
const MAX_AGENT_ID_LENGTH = 64;
const MAX_AGENT_NAME_LENGTH = 80;
const MAX_AGENT_PROVIDER_LENGTH = 64;
const MAX_VERSION_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_SHORT_VALUE_LENGTH = 32;
const MAX_TTL_MS = 60 * 60 * 1_000;
const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHORT_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const AGENT_TYPES = new Set(["cli", "desktop", "ide_extension", "local_service"]);
const INSTALLATION_STATES = new Set(["installed", "not_installed", "unknown"]);
const RUNTIME_STATES = new Set(["running", "not_running", "unknown"]);
const DETECTION_SOURCES = new Set(["command", "application", "process"]);
const CONFIDENCE_VALUES = new Set(["low", "medium", "high"]);

export class AiStatusProtocolError extends Error {}

export function validateAiStatusSyncPayload(value: unknown): asserts value is AiStatusSyncPayload {
  if (encodedSize(value) > MAX_PAYLOAD_BYTES) {
    throw new AiStatusProtocolError("AI status payload exceeds the allowed size.");
  }
  const payload = record(value, "AI status payload");
  const current = payload.schemaVersion === TETI_AI_STATUS_SCHEMA_VERSION;
  const callable = payload.schemaVersion === TETI_AI_STATUS_CALLABLE_SCHEMA_VERSION;
  const observedAgent = payload.schemaVersion === TETI_AI_STATUS_AGENT_SCHEMA_VERSION;
  const legacy = payload.schemaVersion === TETI_AI_STATUS_LEGACY_SCHEMA_VERSION;
  if (!current && !callable && !observedAgent && !legacy) {
    throw new AiStatusProtocolError("Unsupported AI status schema version.");
  }
  exactKeys(
    payload,
    current
      ? [
          "schemaVersion",
          "sharing",
          "generatedAt",
          "expiresAt",
          "tools",
          "agents",
          "capabilities",
          "bindings",
          "computeOffers"
        ]
      : callable
        ? ["schemaVersion", "sharing", "generatedAt", "expiresAt", "tools", "agents", "capabilities", "bindings"]
      : observedAgent
        ? ["schemaVersion", "sharing", "generatedAt", "expiresAt", "tools", "agents"]
      : ["schemaVersion", "sharing", "generatedAt", "expiresAt", "tools"],
    "AI status payload"
  );
  if (payload.sharing !== "enabled" && payload.sharing !== "disabled") {
    throw new AiStatusProtocolError("AI status sharing state is invalid.");
  }
  const generatedAt = isoTimestamp(payload.generatedAt, "generatedAt");
  const expiresAt = isoTimestamp(payload.expiresAt, "expiresAt");
  if (expiresAt <= generatedAt) {
    throw new AiStatusProtocolError("AI status expiresAt must be after generatedAt.");
  }
  if (expiresAt - generatedAt > MAX_TTL_MS) {
    throw new AiStatusProtocolError("AI status expiry exceeds the allowed TTL.");
  }
  if (!Array.isArray(payload.tools) || payload.tools.length > MAX_TOOLS) {
    throw new AiStatusProtocolError("AI status tools must be a bounded array.");
  }
  if (payload.sharing === "disabled" && payload.tools.length !== 0) {
    throw new AiStatusProtocolError("A disabled AI status payload cannot contain tools.");
  }
  for (const tool of payload.tools) validateTool(tool);
  if (current || callable || observedAgent) {
    if (!Array.isArray(payload.agents) || payload.agents.length > MAX_AGENTS) {
      throw new AiStatusProtocolError("AI status agents must be a bounded array.");
    }
    if (payload.sharing === "disabled" && payload.agents.length !== 0) {
      throw new AiStatusProtocolError("A disabled AI status payload cannot contain agents.");
    }
    for (const agent of payload.agents) {
      if (current || callable) validateCallableAgent(agent);
      else validateAgent(agent);
    }
  }
  if (current || callable) {
    if (!Array.isArray(payload.capabilities) || payload.capabilities.length > MAX_CAPABILITIES) {
      throw new AiStatusProtocolError("AI status capabilities must be a bounded array.");
    }
    if (!Array.isArray(payload.bindings) || payload.bindings.length > MAX_BINDINGS) {
      throw new AiStatusProtocolError("AI status bindings must be a bounded array.");
    }
    if (payload.sharing === "disabled"
      && (payload.capabilities.length !== 0 || payload.bindings.length !== 0)) {
      throw new AiStatusProtocolError("A disabled AI status payload cannot contain capabilities.");
    }
    for (const capability of payload.capabilities) validateCapability(capability);
    for (const binding of payload.bindings) validateBinding(binding);
    if (current) {
      if (!Array.isArray(payload.computeOffers) || payload.computeOffers.length > MAX_COMPUTE_OFFERS) {
        throw new AiStatusProtocolError("Compute Offers must be a bounded array.");
      }
      if (payload.sharing === "disabled" && payload.computeOffers.length !== 0) {
        throw new AiStatusProtocolError("A disabled AI status payload cannot contain Compute Offers.");
      }
      for (const offer of payload.computeOffers) validateComputeOffer(offer);
    }
    validateCallableReferences(payload, current);
  }
}

function validateComputeOffer(value: unknown): asserts value is ComputeOffer {
  const offer = record(value, "Compute Offer");
  exactKeys(offer, [
    "offerId",
    "capability",
    "resourceClass",
    "executionLocation",
    "inputModes",
    "outputModes",
    "concurrency",
    "approval",
    "observedAt"
  ], "Compute Offer");
  slug(offer.offerId, "Compute Offer ID", 128);
  if (offer.capability !== "general-text-assistance"
    || (offer.resourceClass !== "local_model" && offer.resourceClass !== "native_agent")
    || offer.executionLocation !== "receiver_local"
    || !singleTextMode(offer.inputModes)
    || !singleTextMode(offer.outputModes)
    || offer.concurrency !== 1
    || offer.approval !== "allow_once") {
    throw new AiStatusProtocolError("Compute Offer contract is invalid.");
  }
  isoTimestamp(offer.observedAt, "Compute Offer observedAt");
}

function singleTextMode(value: unknown): value is ["text"] {
  return Array.isArray(value) && value.length === 1 && value[0] === "text";
}

function validateCallableAgent(value: unknown): asserts value is CallablePassportAgent {
  const agent = record(value, "Callable Passport Agent");
  exactKeys(agent, [
    "id",
    "name",
    "provider",
    "capabilityIds",
    "inputModes",
    "outputModes",
    "availability",
    "observedAt"
  ], "Callable Passport Agent");
  slug(agent.id, "Callable Agent ID", MAX_AGENT_ID_LENGTH);
  safeLabel(agent.name, "Callable Agent name", MAX_AGENT_NAME_LENGTH);
  safeLabel(agent.provider, "Callable Agent provider", MAX_AGENT_PROVIDER_LENGTH);
  safeIdArray(agent.capabilityIds, "Callable Agent capability IDs", 32);
  if (agent.capabilityIds.length === 0) {
    throw new AiStatusProtocolError("Callable Agent capability IDs are invalid.");
  }
  contentModeArray(agent.inputModes, "Callable Agent input modes");
  contentModeArray(agent.outputModes, "Callable Agent output modes");
  if (agent.availability !== "available") {
    throw new AiStatusProtocolError("Callable Agent availability is invalid.");
  }
  isoTimestamp(agent.observedAt, "Callable Agent observedAt");
}

function validateCapability(value: unknown): asserts value is TetiCapability {
  const capability = record(value, "Callable Passport capability");
  exactKeys(capability, [
    "id",
    "name",
    "category",
    "description",
    "availability",
    "observedAt"
  ], "Callable Passport capability");
  slug(capability.id, "Capability ID", MAX_AGENT_ID_LENGTH);
  safeLabel(capability.name, "Capability name", MAX_AGENT_NAME_LENGTH);
  slug(capability.category, "Capability category", MAX_AGENT_PROVIDER_LENGTH);
  safeLabel(capability.description, "Capability description", MAX_DESCRIPTION_LENGTH);
  if (capability.availability !== "available") {
    throw new AiStatusProtocolError("Capability availability is invalid.");
  }
  isoTimestamp(capability.observedAt, "Capability observedAt");
}

function validateBinding(value: unknown): asserts value is CapabilityBinding {
  const binding = record(value, "Callable Passport binding");
  exactKeys(binding, ["capabilityId", "agentIds", "resourceIds"], "Callable Passport binding");
  slug(binding.capabilityId, "Binding capability ID", MAX_AGENT_ID_LENGTH);
  safeIdArray(binding.agentIds, "Binding Agent IDs", MAX_AGENTS);
  safeIdArray(binding.resourceIds, "Binding Resource IDs", MAX_TOOLS);
}

function validateCallableReferences(payload: Record<string, unknown>, withComputeOffers: boolean): void {
  const tools = payload.tools as AiToolStatusSnapshot[];
  const agents = payload.agents as CallablePassportAgent[];
  const capabilities = payload.capabilities as TetiCapability[];
  const bindings = payload.bindings as CapabilityBinding[];
  const computeOffers = withComputeOffers ? payload.computeOffers as ComputeOffer[] : [];
  const toolIds = new Set(tools.map((tool) => tool.toolId));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  if (toolIds.size !== tools.length
    || agentIds.size !== agents.length
    || capabilityIds.size !== capabilities.length) {
    throw new AiStatusProtocolError("Callable Passport entity IDs must be unique.");
  }
  const boundCapabilities = new Set<string>();
  const bindingByCapability = new Map<string, CapabilityBinding>();
  for (const binding of bindings) {
    if (!capabilityIds.has(binding.capabilityId)
      || binding.agentIds.length === 0
      || binding.agentIds.some((id) => !agentIds.has(id))
      || binding.resourceIds.some((id) => !toolIds.has(id))
      || boundCapabilities.has(binding.capabilityId)) {
      throw new AiStatusProtocolError("Callable Passport binding references are invalid.");
    }
    boundCapabilities.add(binding.capabilityId);
    bindingByCapability.set(binding.capabilityId, binding);
    for (const agentId of binding.agentIds) {
      const agent = agents.find((candidate) => candidate.id === agentId)!;
      if (!agent.capabilityIds.includes(binding.capabilityId)) {
        throw new AiStatusProtocolError("Callable Passport binding references are invalid.");
      }
    }
  }
  for (const agent of agents) {
    if (agent.capabilityIds.some((id) =>
      !capabilityIds.has(id) || !bindingByCapability.get(id)?.agentIds.includes(agent.id)
    )) {
      throw new AiStatusProtocolError("Callable Agent capability reference is invalid.");
    }
  }
  if (boundCapabilities.size !== capabilityIds.size) {
    throw new AiStatusProtocolError("Every Callable Passport capability must have one binding.");
  }
  const offerIds = new Set<string>();
  for (const offer of computeOffers) {
    const binding = bindingByCapability.get(offer.capability);
    const boundAgents = agents.filter((agent) => binding?.agentIds.includes(agent.id));
    if (offerIds.has(offer.offerId)
      || !capabilityIds.has(offer.capability)
      || !binding
      || !boundAgents.some((agent) =>
        offer.inputModes.every((mode) => agent.inputModes.includes(mode))
        && offer.outputModes.every((mode) => agent.outputModes.includes(mode)))) {
      throw new AiStatusProtocolError("Compute Offer references are invalid.");
    }
    offerIds.add(offer.offerId);
  }
}

function validateAgent(value: unknown): asserts value is AiAgentStatusSnapshot {
  const agent = record(value, "AI Agent status");
  exactKeys(agent, [
    "agentId",
    "name",
    "provider",
    "type",
    "surfaces",
    "installationStatus",
    "detectionSource",
    "version",
    "runtimeStatus",
    "processCount",
    "confidence",
    "lastSeenAt",
    "observedAt"
  ], "AI Agent status");
  slug(agent.agentId, "Agent ID", MAX_AGENT_ID_LENGTH);
  safeLabel(agent.name, "Agent name", MAX_AGENT_NAME_LENGTH);
  if (agent.provider !== null) slug(agent.provider, "Agent provider", MAX_AGENT_PROVIDER_LENGTH);
  if (typeof agent.type !== "string" || !AGENT_TYPES.has(agent.type)) {
    throw new AiStatusProtocolError("AI Agent type is invalid.");
  }
  if (!Array.isArray(agent.surfaces)
    || agent.surfaces.length === 0
    || agent.surfaces.length > AGENT_TYPES.size
    || agent.surfaces.some((surface) => typeof surface !== "string" || !AGENT_TYPES.has(surface))
    || new Set(agent.surfaces).size !== agent.surfaces.length) {
    throw new AiStatusProtocolError("AI Agent surfaces are invalid.");
  }
  if (typeof agent.installationStatus !== "string"
    || !INSTALLATION_STATES.has(agent.installationStatus)) {
    throw new AiStatusProtocolError("AI Agent installation status is invalid.");
  }
  if (agent.detectionSource !== null
    && (typeof agent.detectionSource !== "string"
      || !DETECTION_SOURCES.has(agent.detectionSource))) {
    throw new AiStatusProtocolError("AI Agent detection source is invalid.");
  }
  if (agent.version !== null) safeVersion(agent.version);
  if (typeof agent.runtimeStatus !== "string" || !RUNTIME_STATES.has(agent.runtimeStatus)) {
    throw new AiStatusProtocolError("AI Agent runtime status is invalid.");
  }
  if (agent.processCount !== null
    && (!Number.isInteger(agent.processCount)
      || (agent.processCount as number) < 0
      || (agent.processCount as number) > 1_024)) {
    throw new AiStatusProtocolError("AI Agent process count is invalid.");
  }
  if (agent.confidence !== null
    && (typeof agent.confidence !== "string" || !CONFIDENCE_VALUES.has(agent.confidence))) {
    throw new AiStatusProtocolError("AI Agent confidence is invalid.");
  }
  if (agent.lastSeenAt !== null) isoTimestamp(agent.lastSeenAt, "Agent lastSeenAt");
  isoTimestamp(agent.observedAt, "Agent observedAt");
}

function validateTool(value: unknown): asserts value is AiToolStatusSnapshot {
  const tool = record(value, "AI tool status");
  exactKeys(tool, ["toolId", "status", "plan", "quotas", "observedAt"], "AI tool status");
  shortString(tool.toolId, "toolId", MAX_TOOL_ID_LENGTH);
  if (!TOOL_ID_PATTERN.test(tool.toolId as string)) {
    throw new AiStatusProtocolError("AI tool status toolId is invalid.");
  }
  if (!["ready", "stale", "unavailable"].includes(tool.status as string)) {
    throw new AiStatusProtocolError("AI tool status state is invalid.");
  }
  isoTimestamp(tool.observedAt, "observedAt");

  const plan = record(tool.plan, "AI tool plan");
  exactKeys(plan, ["key", "membershipVerified"], "AI tool plan");
  if (plan.key !== null) shortKey(plan.key, "plan key");
  if (typeof plan.membershipVerified !== "boolean") {
    throw new AiStatusProtocolError("AI tool plan membershipVerified must be boolean.");
  }

  if (!Array.isArray(tool.quotas) || tool.quotas.length > MAX_QUOTAS_PER_TOOL) {
    throw new AiStatusProtocolError("AI tool quotas must be a bounded array.");
  }
  for (const quota of tool.quotas) validateQuota(quota);
}

function validateQuota(value: unknown): asserts value is AiToolQuotaStatus {
  const quota = record(value, "AI tool quota");
  exactKeys(
    quota,
    ["period", "remainingPercent", "resetAt", "windowSeconds", "identification"],
    "AI tool quota"
  );
  shortKey(quota.period, "quota period");
  if (typeof quota.remainingPercent !== "number"
    || !Number.isFinite(quota.remainingPercent)
    || quota.remainingPercent < 0
    || quota.remainingPercent > 100) {
    throw new AiStatusProtocolError("AI tool quota remainingPercent is invalid.");
  }
  if (quota.resetAt !== null) isoTimestamp(quota.resetAt, "resetAt");
  if (quota.windowSeconds !== null
    && (typeof quota.windowSeconds !== "number"
      || !Number.isFinite(quota.windowSeconds)
      || quota.windowSeconds <= 0)) {
    throw new AiStatusProtocolError("AI tool quota windowSeconds is invalid.");
  }
  if (quota.identification !== "exact" && quota.identification !== "inferred") {
    throw new AiStatusProtocolError("AI tool quota identification is invalid.");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiStatusProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new AiStatusProtocolError(`${label} contains an unsupported field.`);
  const missing = allowed.find((key) => !(key in value));
  if (missing) throw new AiStatusProtocolError(`${label} is missing a required field.`);
}

function shortString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new AiStatusProtocolError(`${label} is invalid.`);
  }
}

function shortKey(value: unknown, label: string): asserts value is string {
  slug(value, label, MAX_SHORT_VALUE_LENGTH);
}

function slug(
  value: unknown,
  label: string,
  maxLength: number
): asserts value is string {
  shortString(value, label, maxLength);
  if (!SHORT_KEY_PATTERN.test(value)) {
    throw new AiStatusProtocolError(`${label} is invalid.`);
  }
}

function safeLabel(value: unknown, label: string, maxLength: number): asserts value is string {
  shortString(value, label, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new AiStatusProtocolError(`${label} is invalid.`);
  }
}

function safeVersion(value: unknown): asserts value is string {
  safeLabel(value, "Agent version", MAX_VERSION_LENGTH);
  if (/[\\/@]/.test(value)
    || /\b(?:token|cookie|credential|password|api[_ -]?key)\b/i.test(value)) {
    throw new AiStatusProtocolError("AI Agent version is invalid.");
  }
}

function safeIdArray(value: unknown, label: string, maximum: number): asserts value is string[] {
  if (!Array.isArray(value)
    || value.length > maximum
    || new Set(value).size !== value.length) {
    throw new AiStatusProtocolError(`${label} are invalid.`);
  }
  for (const id of value) slug(id, label, MAX_AGENT_ID_LENGTH);
}

function contentModeArray(value: unknown, label: string): asserts value is Array<"text" | "image"> {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > 2
    || value[0] !== "text"
    || new Set(value).size !== value.length
    || value.some((mode) => mode !== "text" && mode !== "image")) {
    throw new AiStatusProtocolError(`${label} are invalid.`);
  }
}

function isoTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiStatusProtocolError(`AI status ${label} is required.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AiStatusProtocolError(`AI status ${label} is invalid.`);
  return parsed;
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new AiStatusProtocolError("AI status payload is not serializable.");
  }
}
