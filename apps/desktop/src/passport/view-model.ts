import type {
  PassportIdentity,
  PassportConnectionSnapshot,
  RemotePassportSnapshot,
  RuntimePassportSnapshot
} from "../../../../core/passport/snapshot.ts";
import {
  isCanonicalTetiChatmailAddress,
  isCanonicalTetiPublicId,
  TETI_PUBLIC_ID_CODE_LENGTH,
  TETI_PUBLIC_ID_PREFIX
} from "../../../../core/identity/public-id.ts";
import type {
  AiAgent,
  AiResource,
  CallablePassportAgent,
  TetiCapability,
  TetiAvailability
} from "../../../../core/passport/types.ts";
import type { PassportControllerSnapshot } from "./controller.ts";
import type { AgentObservation } from "../../../../core/observation/types.ts";
import { emptyAgentManagementSnapshot } from "../../../../core/observation/management.ts";

export type ResourceTone = "free" | "plus" | "pro" | "unknown" | "unavailable";
export type ResourceIcon = "codex" | "generic";
export type PeerReachability = "reachable" | "unreachable";

export interface ResourceViewModel {
  providerName: string;
  productName: string;
  planLabel: string;
  availabilityLabel: string;
  remainingPercent: number | null;
  resetLabel: string;
  inferred: boolean;
  stale: boolean;
  tone: ResourceTone;
  icon: ResourceIcon;
}

export type AgentTone = "running" | "installed" | "absent" | "unknown";

export interface AgentViewModel {
  id: string;
  name: string;
  providerName: string;
  statusLabel: string;
  detailLabel: string;
  tone: AgentTone;
}

export interface CapabilityViewModel {
  id: string;
  name: string;
  categoryLabel: string;
  availabilityLabel: string;
  stale: boolean;
}

export interface ManagedAgentViewModel extends AgentViewModel {
  pathOverride: string;
  pathPlaceholder: string;
  canOverride: boolean;
  busy: boolean;
}

export interface AgentManagementViewModel {
  readyToDisplay: boolean;
  scanning: boolean;
  statusLabel: string;
  agents: ManagedAgentViewModel[];
  error?: string;
}

export interface AiPassportPanelViewModel {
  title: string;
  open: boolean;
  resources: ResourceViewModel[];
  agents: AgentViewModel[];
  capabilities: CapabilityViewModel[];
}

export interface PassportSettingsViewModel {
  title: string;
  identityLabel: string;
  registryLabel: string;
  registryTone: "ok" | "pending" | "error";
  toggleLabel: string;
  open: boolean;
  enabled: boolean;
  busy: boolean;
  error?: string;
  agentManagement: AgentManagementViewModel;
}

export interface RemotePassportViewModel {
  state: RemotePassportSnapshot["state"];
  note?: string;
  stale: boolean;
  resources: ResourceViewModel[];
  agents: AgentViewModel[];
  capabilities: CapabilityViewModel[];
}

export interface ConnectionCardViewModel {
  requestId: string;
  state: PassportConnectionSnapshot["connectionState"];
  displayName: string;
  address: string;
  reachability: PeerReachability;
  reachabilityLabel: "在线" | "离线";
  passport: RemotePassportViewModel;
}

export interface PassportViewModel {
  aiPanel: AiPassportPanelViewModel;
  settings: PassportSettingsViewModel;
  connections: ConnectionCardViewModel[];
}

const REMOTE_TETI_HEARTBEAT_FRESH_MS = 15_000;

export function toPassportViewModel(
  snapshot: PassportControllerSnapshot,
  now = new Date()
): PassportViewModel {
  return {
    aiPanel: {
      title: "AI Passport",
      open: snapshot.openPanel === "passport",
      resources: snapshot.passport.localPassport.resources.map(toResourceViewModel),
      agents: snapshot.passport.localPassport.agents.map(toAgentViewModel),
      capabilities: snapshot.passport.localPassport.capabilities.map(toCapabilityViewModel)
    },
    settings: {
      title: "设置",
      identityLabel: formatLocalTetiIdentity(snapshot.passport.identity),
      ...formatRegistryStatus(snapshot.passport.registry),
      toggleLabel: "Passport 分享",
      open: snapshot.openPanel === "sharing",
      enabled: snapshot.passport.sharing.resourceSummary
        && snapshot.passport.sharing.resourceQuota
        && snapshot.passport.sharing.agents
        && snapshot.passport.sharing.capabilities,
      busy: snapshot.sharingBusy,
      ...(snapshot.sharingError ? { error: snapshot.sharingError } : {}),
      agentManagement: toAgentManagementViewModel(snapshot)
    },
    connections: snapshot.passport.connections.map((connection) => toConnectionCardViewModel(connection, now))
  };
}

const BUILTIN_MANAGED_AGENT_IDS = new Set([
  "codex",
  "claude-code",
  "gemini-cli",
  "cursor",
  "codebuddy"
]);

function toAgentManagementViewModel(snapshot: PassportControllerSnapshot): AgentManagementViewModel {
  const management = snapshot.agentManagement ?? emptyAgentManagementSnapshot();
  const readyToDisplay = management.revision > 0;
  const scanning = snapshot.agentBusy || management.state === "discovering";
  const installedCount = management.agents.filter(
    (agent) => agent.installation?.state === "installed"
  ).length;
  const statusLabel = !readyToDisplay
    ? "正在发现本机 Agent…"
    : management.state === "discovering"
      ? "正在重新扫描…"
      : management.state === "disabled"
        ? "Agent 发现已关闭"
        : management.state === "degraded"
          ? `已发现 ${installedCount}/${management.agents.length} · 部分检测未完成`
          : `已发现 ${installedCount}/${management.agents.length}`;
  const safeError = snapshot.agentError
    ?? (readyToDisplay && management.errors.length > 0
      ? "部分检测器未完成，不影响其他 Agent。"
      : undefined);
  return {
    readyToDisplay,
    scanning,
    statusLabel,
    agents: readyToDisplay
      ? management.agents
          .map((agent) => toManagedAgentViewModel(
            agent,
            management.pathOverrides[agent.agentId] ?? "",
            snapshot.agentBusyId === agent.agentId
          ))
          .sort(compareManagedAgents)
      : [],
    ...(safeError ? { error: safeError } : {})
  };
}

const MANAGED_AGENT_TONE_PRIORITY: Record<AgentTone, number> = {
  running: 0,
  installed: 1,
  unknown: 2,
  absent: 3
};

function compareManagedAgents(left: ManagedAgentViewModel, right: ManagedAgentViewModel): number {
  return MANAGED_AGENT_TONE_PRIORITY[left.tone] - MANAGED_AGENT_TONE_PRIORITY[right.tone];
}

function toManagedAgentViewModel(
  observation: AgentObservation,
  pathOverride: string,
  busy: boolean
): ManagedAgentViewModel {
  const agent = toAgentViewModel({
    id: observation.agentId,
    name: observation.displayName,
    provider: observation.provider,
    type: observation.surfaces[0] ?? "local_service",
    surfaces: observation.surfaces,
    installationStatus: observation.installation?.state ?? "unknown",
    ...(observation.installation?.version ? { version: observation.installation.version } : {}),
    ...(observation.runtime ? { runtimeStatus: observation.runtime.state } : {}),
    ...(observation.runtime?.processCount === undefined
      ? {}
      : { processCount: observation.runtime.processCount }),
    observedAt: observation.observedAt
  });
  const desktop = observation.surfaces.includes("desktop");
  return {
    ...agent,
    pathOverride,
    pathPlaceholder: desktop
      ? `/Applications/${observation.displayName}.app`
      : `/path/to/${observation.agentId === "claude-code" ? "claude" : observation.agentId.replace(/-cli$/, "")}`,
    canOverride: BUILTIN_MANAGED_AGENT_IDS.has(observation.agentId),
    busy
  };
}

function formatRegistryStatus(
  status: RuntimePassportSnapshot["registry"]
): Pick<PassportSettingsViewModel, "registryLabel" | "registryTone"> {
  if (status.state === "registered") {
    return { registryLabel: "已公开", registryTone: "ok" };
  }
  if (status.state === "unknown") {
    return { registryLabel: "检查中", registryTone: "pending" };
  }
  if (status.state === "not_registered") {
    return { registryLabel: "待同步 [REG-NF]", registryTone: "pending" };
  }
  if (status.state === "unreachable") {
    return {
      registryLabel: `待同步 [${shortRegistryCode(status.errorCode, "REG-NET")}]`,
      registryTone: "pending"
    };
  }
  if (status.state === "rejected") {
    return { registryLabel: "同步被拒绝 [REG-REJ]", registryTone: "error" };
  }
  return { registryLabel: "身份冲突 [REG-CON]", registryTone: "error" };
}

function shortRegistryCode(code: string | undefined, fallback: string): string {
  const known: Record<string, string> = {
    REG_DNS: "REG-DNS",
    REG_TIMEOUT: "REG-TO",
    REG_TLS: "REG-TLS",
    REG_NETWORK: "REG-NET",
    REG_HTTP_5XX: "REG-5XX",
    REG_INVALID_RESPONSE: "REG-JSON",
    REG_UNKNOWN: "REG-NET"
  };
  return code ? known[code] ?? fallback : fallback;
}

export function formatLocalTetiIdentity(identity: PassportIdentity | null): string {
  if (!identity) return "暂不可用";
  const displayName = identity.displayName?.trim() || "未命名";
  const publicIdCode = isCanonicalTetiPublicId(identity.tetiId)
    ? identity.tetiId.slice(TETI_PUBLIC_ID_PREFIX.length)
    : isCanonicalTetiChatmailAddress(identity.address)
      ? identity.address.slice(0, TETI_PUBLIC_ID_CODE_LENGTH)
      : null;
  return publicIdCode
    ? `${displayName}（${publicIdCode}）`
    : `${displayName}（ID 暂不可用）`;
}

export function toConnectionCardViewModel(
  connection: PassportConnectionSnapshot,
  now = new Date()
): ConnectionCardViewModel {
  const reachable = connection.connectionState === "Confirmed"
    && Boolean(connection.lastSeen)
    && now.getTime() - Date.parse(connection.lastSeen!) < REMOTE_TETI_HEARTBEAT_FRESH_MS;
  return {
    requestId: connection.requestId,
    state: connection.connectionState,
    displayName: connection.identity.displayName || connection.identity.tetiId,
    address: connection.identity.address,
    reachability: reachable ? "reachable" : "unreachable",
    reachabilityLabel: reachable ? "在线" : "离线",
    passport: toRemotePassportViewModel(connection.passport)
  };
}

export function toResourceViewModel(resource: AiResource): ResourceViewModel {
  const weekly = resource.quotas.find((quota) => quota.period === "week") ?? null;
  const planKey = resource.plan?.key?.toLowerCase() ?? null;
  const unavailable = resource.availability === "unknown" || resource.availability === "unavailable";
  const tone: ResourceTone = unavailable
    ? "unavailable"
    : planKey === "free" || planKey === "plus" || planKey === "pro"
      ? planKey
      : "unknown";
  return {
    providerName: resource.provider,
    productName: resource.product,
    planLabel: unavailable
      ? "暂时无法确认"
      : resource.plan?.displayName || "计划未知",
    availabilityLabel: availabilityLabel(resource.availability),
    remainingPercent: weekly?.remainingPercent ?? null,
    resetLabel: formatResetAt(weekly?.resetAt ?? null),
    inferred: weekly?.identification === "inferred",
    stale: resource.availability === "stale",
    tone,
    icon: resource.id === "openai.codex" ? "codex" : "generic"
  };
}

export function toAgentViewModel(agent: AiAgent | CallablePassportAgent): AgentViewModel {
  if (isCallablePassportAgent(agent)) {
    const stale = agent.availability === "stale";
    return {
      id: agent.id,
      name: agent.name,
      providerName: formatAgentProvider(agent.provider),
      statusLabel: stale ? "信息已过期" : "可调用",
      detailLabel: [
        formatAgentProvider(agent.provider),
        agent.capabilityIds.map(formatCapabilityId).join("、")
      ].filter(Boolean).join(" · "),
      tone: stale ? "unknown" : "running"
    };
  }
  const running = agent.runtimeStatus === "running";
  const installed = agent.installationStatus === "installed";
  const absent = agent.installationStatus === "not_installed";
  const tone: AgentTone = running
    ? "running"
    : installed
      ? "installed"
      : absent
        ? "absent"
        : "unknown";
  const statusLabel = running
    ? "运行中"
    : installed
      ? agent.runtimeStatus === "unknown" ? "已安装 · 状态未知" : "已安装"
      : absent
        ? "未发现"
        : "未确认";
  const providerName = formatAgentProvider(agent.provider);
  const details = [
    providerName,
    agent.version?.trim() || "",
    running && (agent.processCount ?? 0) > 1 ? `${agent.processCount} 个进程` : ""
  ].filter(Boolean);
  return {
    id: agent.id,
    name: agent.name,
    providerName,
    statusLabel,
    detailLabel: details.join(" · "),
    tone
  };
}

export function toCapabilityViewModel(capability: TetiCapability): CapabilityViewModel {
  return {
    id: capability.id,
    name: capability.name,
    categoryLabel: formatCapabilityId(capability.category),
    availabilityLabel: capability.availability === "stale" ? "信息已过期" : "可调用",
    stale: capability.availability === "stale"
  };
}

function isCallablePassportAgent(
  agent: AiAgent | CallablePassportAgent
): agent is CallablePassportAgent {
  return "capabilityIds" in agent && "availability" in agent;
}

function formatCapabilityId(value: string): string {
  const known: Record<string, string> = {
    coding: "编程",
    "code-analysis": "代码分析"
  };
  return known[value] ?? value.replace(/[._-]+/g, " ");
}

function formatAgentProvider(provider: string | undefined): string {
  const value = provider?.trim() || "";
  const known: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    cursor: "Cursor",
    tencent: "Tencent",
    google: "Google"
  };
  return known[value.toLowerCase()] ?? value;
}

function toRemotePassportViewModel(passport: RemotePassportSnapshot): RemotePassportViewModel {
  const note = passport.state === "stale"
    ? "AI Passport 已过期"
    : passport.state === "disabled"
      ? "对方未分享 AI Passport"
      : passport.state === "unknown"
      ? "暂无 AI Passport"
        : passport.resources.length === 0
          && passport.agents.length === 0
          && (passport.capabilities?.length ?? 0) === 0
          ? "暂无 AI Passport"
          : undefined;
  return {
    state: passport.state,
    ...(note ? { note } : {}),
    stale: passport.state === "stale",
    resources: passport.resources.slice(0, 2).map(toResourceViewModel),
    agents: passport.agents.map(toAgentViewModel),
    capabilities: (passport.capabilities ?? []).map(toCapabilityViewModel)
  };
}

function availabilityLabel(availability: TetiAvailability): string {
  if (availability === "available") return "可用";
  if (availability === "stale") return "数据已过期";
  if (availability === "unavailable") return "暂不可用";
  return "暂时无法确认";
}

export function formatResetAt(resetAt: string | null): string {
  if (!resetAt) return "重置时间暂不可用";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "重置时间暂不可用";
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes} 重置`;
}
