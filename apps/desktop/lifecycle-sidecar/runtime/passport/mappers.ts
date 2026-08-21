import type { TetiAccount } from "../../../../../core/account/model.ts";
import type {
  AiAgentStatusSnapshot,
  AiToolStatusSnapshot,
  RemoteAiStatusSnapshot
} from "../../../../../core/ai-status/types.ts";
import type {
  PassportConnectionSnapshot,
  PassportIdentity,
  RemotePassportSnapshot
} from "../../../../../core/passport/snapshot.ts";
import type {
  AiAgent,
  AiResource,
  AiResourcePlan,
  CallablePassportAgent,
  CapabilityBinding,
  TetiCapability,
  TetiAvailability
} from "../../../../../core/passport/types.ts";
import type { CodexUsageState } from "../../../src/codex-usage/types.ts";
import type { PeerConnectionDto } from "../../../src/lifecycle-bridge/protocol.ts";
import { TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS } from "../../../../../core/task/transport.ts";
import { TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS } from "../../../../../core/ai-status/negotiation.ts";

export const CODEX_RESOURCE_ID = "openai.codex";
export const PROTOCOL_COMPATIBILITY_CHECK_TIMEOUT_MS = 15_000;

export function mapAccountIdentity(account: TetiAccount | null): PassportIdentity | null {
  if (!account) return null;
  return compactIdentity({
    tetiId: account.id,
    address: account.address,
    displayName: account.displayName
  });
}

export function mapCodexUsageResource(state: CodexUsageState, fallbackObservedAt: string): AiResource {
  const snapshot = state.status === "ready" || state.status === "stale" ? state.snapshot : null;
  const plan = mapPlan(snapshot?.planTypeRaw ?? null, snapshot?.planDisplayName ?? null);
  const availability: TetiAvailability = state.status === "ready"
    ? (snapshot?.stale ? "stale" : "available")
    : state.status === "stale"
      ? "stale"
      : "unknown";
  return compactResource({
    id: CODEX_RESOURCE_ID,
    provider: "OpenAI",
    product: "Codex",
    kind: "subscription",
    plan,
    availability,
    quotas: snapshot?.weekly ? [{
      period: "week",
      remainingPercent: clampPercent(snapshot.weekly.remainingPercent),
      resetAt: snapshot.weekly.resetAt,
      windowSeconds: snapshot.weekly.windowSeconds,
      identification: snapshot.weekly.identification
    }] : [],
    assurance: snapshot?.source === "local_auth" ? "local_observed" : "provider_observed",
    observedAt: snapshot?.observedAt ?? fallbackObservedAt
  });
}

export function mapPeerConnection(
  connection: PeerConnectionDto,
  now: Date
): PassportConnectionSnapshot {
  return {
    requestId: connection.requestId,
    connectionState: connection.state,
    direction: connection.direction,
    identity: compactIdentity({
      tetiId: connection.remoteTetiId,
      address: connection.remoteAddress,
      displayName: connection.remoteDisplayName
    }),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    ...(connection.confirmedAt ? { confirmedAt: connection.confirmedAt } : {}),
    lastSeen: connection.lastHeartbeatReceivedAt ?? null,
    compatibility: peerCompatibility(connection, now),
    passport: mapRemoteAiStatus(connection.remoteAiStatus, now)
  };
}

function peerCompatibility(
  connection: PeerConnectionDto,
  now: Date
): PassportConnectionSnapshot["compatibility"] {
  const capability = connection.remoteProtocolCapabilities;
  if (!capability) return unresolvedPeerCompatibility(connection, now);
  if (capability.collaborationProtocolEpoch !== 2) return "upgrade_required";
  if (!capability.taskProtocolVersions || !capability.passportSchemaVersions) {
    return unresolvedPeerCompatibility(connection, now);
  }
  return capability.taskProtocolVersions.length === 1
    && capability.taskProtocolVersions[0] === TETI_SUPPORTED_TASK_PROTOCOL_VERSIONS[0]
    && capability.passportSchemaVersions.length === 1
    && capability.passportSchemaVersions[0] === TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS[0]
    ? "compatible"
    : "upgrade_required";
}

function unresolvedPeerCompatibility(
  connection: PeerConnectionDto,
  now: Date
): PassportConnectionSnapshot["compatibility"] {
  if (connection.state !== "Confirmed") return "unknown";
  const baseline = Date.parse(connection.confirmedAt ?? connection.updatedAt);
  return Number.isFinite(baseline)
    && now.getTime() - baseline >= PROTOCOL_COMPATIBILITY_CHECK_TIMEOUT_MS
    ? "unavailable"
    : "unknown";
}

export function mapRemoteAiStatus(
  snapshot: RemoteAiStatusSnapshot | undefined,
  now: Date
): RemotePassportSnapshot {
  if (!snapshot) return { state: "unknown", resources: [], agents: [], capabilities: [], bindings: [], computeOffers: [] };
  if (snapshot.sharing === "disabled") {
    return {
      state: "disabled",
      resources: [],
      agents: [],
      capabilities: [],
      bindings: [],
      computeOffers: [],
      generatedAt: snapshot.generatedAt,
      expiresAt: snapshot.expiresAt,
      receivedAt: snapshot.receivedAt
    };
  }
  const expired = now.getTime() >= Date.parse(snapshot.expiresAt);
  return {
    state: expired ? "stale" : "fresh",
    resources: snapshot.tools.map((tool) => mapRemoteToolResource(tool, snapshot.expiresAt, expired)),
    agents: snapshot.schemaVersion === 4 || snapshot.schemaVersion === 3
      ? snapshot.agents.map((agent) => mapRemoteCallableAgent(agent, expired))
      : snapshot.schemaVersion === 2
        ? snapshot.agents.map((agent) => mapRemoteAgent(agent, expired))
        : [],
    capabilities: snapshot.schemaVersion === 4 || snapshot.schemaVersion === 3
      ? snapshot.capabilities.map((capability) => mapRemoteCapability(capability, expired))
      : [],
    bindings: snapshot.schemaVersion === 4 || snapshot.schemaVersion === 3
      ? snapshot.bindings.map((binding) => cloneBinding(binding))
      : [],
    computeOffers: snapshot.schemaVersion === 4
      ? snapshot.computeOffers.map((offer) => structuredClone(offer))
      : [],
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    receivedAt: snapshot.receivedAt
  };
}

function mapRemoteCallableAgent(
  agent: CallablePassportAgent,
  passportExpired: boolean
): CallablePassportAgent {
  return {
    ...structuredClone(agent),
    availability: passportExpired ? "stale" : agent.availability
  };
}

function mapRemoteCapability(
  capability: TetiCapability,
  passportExpired: boolean
): TetiCapability {
  return {
    ...structuredClone(capability),
    availability: passportExpired ? "stale" : capability.availability
  };
}

function cloneBinding(binding: CapabilityBinding): CapabilityBinding {
  return {
    capabilityId: binding.capabilityId,
    agentIds: [...binding.agentIds],
    resourceIds: [...binding.resourceIds]
  };
}

function mapRemoteAgent(agent: AiAgentStatusSnapshot, passportExpired: boolean): AiAgent {
  return {
    id: agent.agentId,
    name: agent.name,
    ...(agent.provider ? { provider: agent.provider } : {}),
    type: agent.type,
    surfaces: [...agent.surfaces],
    installationStatus: agent.installationStatus,
    ...(agent.detectionSource ? { detectionSource: agent.detectionSource } : {}),
    ...(agent.version ? { version: agent.version } : {}),
    runtimeStatus: passportExpired ? "unknown" : agent.runtimeStatus,
    ...(passportExpired || agent.processCount === null ? {} : { processCount: agent.processCount }),
    ...(agent.confidence ? { confidence: agent.confidence } : {}),
    ...(agent.lastSeenAt ? { lastSeenAt: agent.lastSeenAt } : {}),
    observedAt: agent.observedAt
  };
}

function mapRemoteToolResource(
  tool: AiToolStatusSnapshot,
  expiresAt: string,
  passportExpired: boolean
): AiResource {
  const availability: TetiAvailability = passportExpired || tool.status === "stale"
    ? "stale"
    : tool.status === "ready"
      ? "available"
      : "unavailable";
  const [providerId, productId] = tool.toolId.split(".", 2);
  const knownCodex = tool.toolId === CODEX_RESOURCE_ID;
  return compactResource({
    id: tool.toolId,
    provider: knownCodex ? "OpenAI" : titleCase(providerId || "AI"),
    product: knownCodex ? "Codex" : titleCase(productId || tool.toolId),
    kind: "subscription",
    plan: mapPlan(tool.plan.key, null),
    availability,
    quotas: tool.quotas.map((quota) => ({
      period: quota.period,
      remainingPercent: clampPercent(quota.remainingPercent),
      resetAt: quota.resetAt,
      windowSeconds: quota.windowSeconds,
      identification: quota.identification
    })),
    assurance: "provider_observed",
    observedAt: tool.observedAt,
    expiresAt
  });
}

function mapPlan(key: string | null, displayName: string | null): AiResourcePlan | undefined {
  const normalizedKey = key?.trim().toLowerCase() || null;
  const normalizedDisplayName = displayName?.trim() || knownPlanLabel(normalizedKey);
  if (!normalizedKey && !normalizedDisplayName) return undefined;
  return {
    key: normalizedKey,
    displayName: normalizedDisplayName
  };
}

function knownPlanLabel(key: string | null): string | null {
  if (key === "free") return "Free";
  if (key === "plus") return "Plus";
  if (key === "pro") return "Pro";
  return key ? titleCase(key) : null;
}

function compactIdentity(identity: PassportIdentity): PassportIdentity {
  return identity.displayName
    ? identity
    : { tetiId: identity.tetiId, address: identity.address };
}

function compactResource(resource: AiResource): AiResource {
  if (resource.plan) return resource;
  const { plan: _plan, ...withoutPlan } = resource;
  return withoutPlan;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
