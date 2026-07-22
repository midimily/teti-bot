import type { TetiAccount } from "../../../../../core/account/model.ts";
import type { AiToolStatusSnapshot, RemoteAiStatusSnapshot } from "../../../../../core/ai-status/types.ts";
import type {
  PassportConnectionSnapshot,
  PassportIdentity,
  RemotePassportSnapshot
} from "../../../../../core/passport/snapshot.ts";
import type { AiResource, AiResourcePlan, TetiAvailability } from "../../../../../core/passport/types.ts";
import type { CodexUsageState } from "../../../src/codex-usage/types.ts";
import type { PeerConnectionDto } from "../../../src/lifecycle-bridge/protocol.ts";

export const CODEX_RESOURCE_ID = "openai.codex";

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
    assurance: "provider_observed",
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
    passport: mapRemoteAiStatus(connection.remoteAiStatus, now)
  };
}

export function mapRemoteAiStatus(
  snapshot: RemoteAiStatusSnapshot | undefined,
  now: Date
): RemotePassportSnapshot {
  if (!snapshot) return { state: "unknown", resources: [] };
  if (snapshot.sharing === "disabled") {
    return {
      state: "disabled",
      resources: [],
      generatedAt: snapshot.generatedAt,
      expiresAt: snapshot.expiresAt,
      receivedAt: snapshot.receivedAt
    };
  }
  const expired = now.getTime() >= Date.parse(snapshot.expiresAt);
  return {
    state: expired ? "stale" : "fresh",
    resources: snapshot.tools.map((tool) => mapRemoteToolResource(tool, snapshot.expiresAt, expired)),
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    receivedAt: snapshot.receivedAt
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
