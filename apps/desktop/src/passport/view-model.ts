import type {
  PassportIdentity,
  PassportConnectionSnapshot,
  RemotePassportSnapshot,
  RuntimePassportSnapshot
} from "../../../../core/passport/snapshot.ts";
import {
  isCanonicalTetiRelayChatmailAddress,
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
import { TETI_BUILD_INFO } from "../build-info.ts";
import { DEFAULT_TETI_NETWORK_BASE_URL } from "../../../../services/network/config.ts";

export type ResourceTone = "free" | "plus" | "pro" | "unknown" | "unavailable";
export type ResourceIcon = "codex" | "generic";
export type PeerReachability = "reachable" | "checking" | "unreachable";

export interface ResourceQuotaViewModel {
  periodLabel: string;
  remainingPercent: number;
  resetLabel: string;
  windowLabel: string;
  inferred: boolean;
}

export interface ResourceViewModel {
  id: string;
  providerName: string;
  productName: string;
  kindLabel: string;
  assuranceLabel: string;
  planLabel: string;
  availabilityLabel: string;
  remainingPercent: number | null;
  resetLabel: string;
  inferred: boolean;
  stale: boolean;
  tone: ResourceTone;
  icon: ResourceIcon;
  quotas: ResourceQuotaViewModel[];
}

export type AgentTone = "running" | "installed" | "absent" | "unknown";

export interface AgentViewModel {
  id: string;
  name: string;
  providerName: string;
  versionLabel: string;
  statusLabel: string;
  detailLabel: string;
  inputModeLabels: string[];
  outputModeLabels: string[];
  capabilityIds: string[];
  tone: AgentTone;
}

export interface CapabilityBindingViewModel {
  agentNames: string[];
  resourceNames: string[];
  statusLabel: "绑定完整" | "绑定信息不完整";
}

export interface CapabilityViewModel {
  id: string;
  name: string;
  categoryLabel: string;
  description: string;
  availabilityLabel: string;
  bindings: CapabilityBindingViewModel[];
  stale: boolean;
  computeOffer?: {
    resourceLabel: "本地算力";
    executionLabel: "接收端本机执行";
    concurrencyLabel: "并发 1";
    approvalLabel: "每次授权";
  };
}

export type ProviderLogo = "openai" | "generic";

export interface ProviderViewModel {
  id: string;
  name: string;
  logo: ProviderLogo;
  fallbackLabel: string;
  resourceNames: string[];
  agentNames: string[];
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
  networkIdentityLabel: string;
  networkIdentityTone: "ok" | "pending" | "error";
  toggleLabel: string;
  open: boolean;
  enabled: boolean;
  busy: boolean;
  error?: string;
  agentManagement: AgentManagementViewModel;
  showOsaurusNativeConfiguration: boolean;
  osaurusNativeAgentId: string;
  osaurusNativeBusy: boolean;
  osaurusNativeStatus: "未配置" | "安全资格检查中" | "安全资格未通过" | "可调用";
  osaurusNativeReason?: string;
  osaurusNativeError?: string;
  useLocalDevelopmentNetwork: boolean;
  networkEnvironmentBusy: boolean;
  networkEnvironmentEndpoint: string;
  networkEnvironmentNextEndpoint: string;
  networkEnvironmentActiveLabel: "生产环境" | "本机开发环境";
  networkEnvironmentRestartRequired: boolean;
  networkEnvironmentError?: string;
  showLocalDevelopmentNetworkSwitch: boolean;
  networkVersionLabel: string;
  presenceLabel: string;
  presenceTone: "ok" | "pending" | "error";
  localLogoutConfirmationRequired: boolean;
  localLogoutBusy: boolean;
  localLogoutError?: string;
  appVersion: string;
  buildTimestamp: string;
}

export interface RemotePassportViewModel {
  state: RemotePassportSnapshot["state"];
  note?: string;
  stale: boolean;
  resources: ResourceViewModel[];
  agents: AgentViewModel[];
  providers: ProviderViewModel[];
  capabilities: CapabilityViewModel[];
  summary: RemotePassportSummaryViewModel;
}

export interface RemotePassportSummaryViewModel {
  resource: ResourceViewModel | null;
  resourceOverflowCount: number;
  agents: AgentViewModel[];
  agentOverflowCount: number;
  capabilities: CapabilityViewModel[];
  capabilityOverflowCount: number;
}

export interface ConnectionCardViewModel {
  requestId: string;
  state: PassportConnectionSnapshot["connectionState"];
  displayName: string;
  publicIdCode: string;
  identityLabel: string;
  compatibility: PassportConnectionSnapshot["compatibility"];
  compatibilityLabel: "兼容" | "需要升级" | "待确认版本";
  reachability: PeerReachability;
  reachabilityLabel: "在线" | "状态检测中" | "离线";
  passport: RemotePassportViewModel;
}

export interface PassportViewModel {
  aiPanel: AiPassportPanelViewModel;
  settings: PassportSettingsViewModel;
  connections: ConnectionCardViewModel[];
}

const REMOTE_TETI_HEARTBEAT_FRESH_MS = 20_000;
const REMOTE_TETI_HEARTBEAT_OFFLINE_MS = 60_000;

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
      capabilities: snapshot.passport.localPassport.capabilities.map((capability) =>
        toCapabilityViewModel(capability)
      )
    },
    settings: {
      title: "设置",
      identityLabel: formatLocalTetiIdentity(snapshot.passport.identity),
      ...formatNetworkIdentityStatus(snapshot.passport.networkIdentity),
      toggleLabel: "Passport 分享",
      open: snapshot.openPanel === "sharing",
      enabled: snapshot.passport.sharing.resourceSummary
        && snapshot.passport.sharing.resourceQuota
        && snapshot.passport.sharing.agents
        && snapshot.passport.sharing.capabilities,
      busy: snapshot.sharingBusy,
      ...(snapshot.sharingError ? { error: snapshot.sharingError } : {}),
      agentManagement: toAgentManagementViewModel(snapshot),
      showOsaurusNativeConfiguration: isOsaurusLocallyAvailable(snapshot),
      osaurusNativeAgentId: snapshot.osaurusNative?.agentId ?? "",
      osaurusNativeBusy: snapshot.osaurusNativeBusy ?? false,
      osaurusNativeStatus: snapshot.osaurusNative?.readiness === "ready"
        || snapshot.passport.localPassport.agents.some((agent) => agent.id === "osaurus-native-teti")
        ? "可调用"
        : snapshot.osaurusNative?.readiness === "blocked"
          ? "安全资格未通过"
          : snapshot.osaurusNative?.agentId
            ? "安全资格检查中"
            : "未配置",
      ...(snapshot.osaurusNative?.reasonCode
        ? { osaurusNativeReason: formatOsaurusNativeReason(snapshot.osaurusNative.reasonCode) }
        : {}),
      ...(snapshot.osaurusNativeError ? { osaurusNativeError: snapshot.osaurusNativeError } : {}),
      useLocalDevelopmentNetwork: snapshot.networkEnvironment?.useLocalDevelopmentNetwork ?? false,
      networkEnvironmentBusy: snapshot.networkEnvironmentBusy ?? false,
      networkEnvironmentEndpoint: snapshot.networkEnvironment?.activeBaseUrl
        ?? DEFAULT_TETI_NETWORK_BASE_URL,
      networkEnvironmentNextEndpoint: snapshot.networkEnvironment?.configuredBaseUrl
        ?? DEFAULT_TETI_NETWORK_BASE_URL,
      networkEnvironmentActiveLabel:
        snapshot.networkEnvironment?.activeEnvironment === "local_development"
          ? "本机开发环境"
          : "生产环境",
      networkEnvironmentRestartRequired: snapshot.networkEnvironment?.restartRequired ?? false,
      ...(snapshot.networkEnvironmentError
        ? { networkEnvironmentError: snapshot.networkEnvironmentError }
        : {}),
      showLocalDevelopmentNetworkSwitch: TETI_BUILD_INFO.localDevelopmentNetworkSwitchEnabled,
      networkVersionLabel: formatNetworkVersion(snapshot.networkContract),
      ...formatPresenceStatus(snapshot.presence),
      localLogoutConfirmationRequired: snapshot.localLogoutConfirmationRequired ?? false,
      localLogoutBusy: snapshot.localLogoutBusy ?? false,
      ...(snapshot.localLogoutError ? { localLogoutError: snapshot.localLogoutError } : {}),
      appVersion: TETI_BUILD_INFO.appVersion,
      buildTimestamp: TETI_BUILD_INFO.buildTimestamp
    },
    connections: snapshot.passport.connections.map((connection) => toConnectionCardViewModel(connection, now))
  };
}

function formatNetworkVersion(
  status: PassportControllerSnapshot["networkContract"]
): string {
  if (!status || status.state === "checking" || status.state === "disabled") return "检测中";
  if (status.state !== "compatible") return "暂不可用";
  return `Protocol ${status.protocolVersion} · Service ${status.serviceVersion}`;
}

function formatPresenceStatus(
  presence: PassportControllerSnapshot["presence"]
): Pick<PassportSettingsViewModel, "presenceLabel" | "presenceTone"> {
  if (!presence || presence.state === "stopped") {
    return { presenceLabel: "尚未启动", presenceTone: "pending" };
  }
  if (presence.state === "sleeping") {
    return { presenceLabel: "系统睡眠 · 已暂停上报", presenceTone: "pending" };
  }
  if (presence.state === "checking") {
    return { presenceLabel: "正在连接", presenceTone: "pending" };
  }
  if (presence.state === "unavailable") {
    if (presence.errorCode === "NETWORK_UNAUTHORIZED") {
      return { presenceLabel: "Network 身份认证失败", presenceTone: "error" };
    }
    return { presenceLabel: "Network 暂不可用", presenceTone: "error" };
  }
  const mode = presence.mode === "collaborating"
    ? "AI 协作中"
    : presence.mode === "viewing_connect"
      ? "正在查看建联面板"
      : presence.mode === "background"
        ? "后台在线"
        : "在线";
  return { presenceLabel: `已连接 · ${mode}`, presenceTone: "ok" };
}

export function formatOsaurusNativeReason(reasonCode: string): string {
  if (reasonCode === "OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED") {
    return "Osaurus Insights 会保留请求正文；已按本机 Agent 信任策略允许调用。";
  }
  return reasonCode;
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
  const availableAgents = readyToDisplay
    ? management.agents.filter(isLocallyAvailableAgent)
    : [];
  const discoveryLabel = availableAgents.length > 0
    ? `已发现 ${availableAgents.length}`
    : "未发现本机 Agent";
  const statusLabel = !readyToDisplay
    ? "正在发现本机 Agent…"
    : management.state === "discovering"
      ? "正在重新扫描…"
      : management.state === "disabled"
        ? "Agent 发现已关闭"
        : management.state === "degraded"
          ? `${discoveryLabel} · 部分检测未完成`
          : discoveryLabel;
  const safeError = snapshot.agentError
    ?? (readyToDisplay && management.errors.length > 0
      ? "部分检测器未完成，不影响其他 Agent。"
      : undefined);
  return {
    readyToDisplay,
    scanning,
    statusLabel,
    agents: readyToDisplay
      ? availableAgents
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

function isLocallyAvailableAgent(agent: AgentObservation): boolean {
  return agent.installation?.state === "installed" || agent.runtime?.state === "running";
}

function isOsaurusLocallyAvailable(snapshot: PassportControllerSnapshot): boolean {
  const management = snapshot.agentManagement ?? emptyAgentManagementSnapshot();
  if (management.revision <= 0) return false;
  const osaurus = management.agents.find((agent) => agent.agentId === "osaurus");
  return osaurus ? isLocallyAvailableAgent(osaurus) : false;
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

function formatNetworkIdentityStatus(
  status: RuntimePassportSnapshot["networkIdentity"]
): Pick<PassportSettingsViewModel, "networkIdentityLabel" | "networkIdentityTone"> {
  if (status.state === "active") {
    return { networkIdentityLabel: "已连接 Network", networkIdentityTone: "ok" };
  }
  if (status.state === "unknown") {
    return { networkIdentityLabel: "检查中", networkIdentityTone: "pending" };
  }
  if (status.state === "pending") {
    return { networkIdentityLabel: "身份同步中", networkIdentityTone: "pending" };
  }
  if (status.state === "unavailable") {
    return {
      networkIdentityLabel: `Network 暂不可用 [${shortNetworkCode(status.errorCode)}]`,
      networkIdentityTone: "pending"
    };
  }
  if (status.state === "unauthorized") {
    return { networkIdentityLabel: "Network 身份认证失败", networkIdentityTone: "error" };
  }
  if (status.state === "revoked") {
    return { networkIdentityLabel: "Network 客户端已撤销", networkIdentityTone: "error" };
  }
  return { networkIdentityLabel: "Network 身份冲突", networkIdentityTone: "error" };
}

function shortNetworkCode(code: string | undefined): string {
  const known: Record<string, string> = {
    NETWORK_TIMEOUT: "NET-TO",
    NETWORK_UNAVAILABLE: "NET-DOWN",
    SERVER_UNAVAILABLE: "NET-SERVER",
    DEPENDENCY_UNAVAILABLE: "NET-DEP",
    NETWORK_INVALID_RESPONSE: "NET-JSON",
    PROTOCOL_UNSUPPORTED: "NET-PROTO",
    RATE_LIMITED: "NET-RATE"
  };
  return code ? known[code] ?? "NET-DOWN" : "NET-DOWN";
}

export function formatLocalTetiIdentity(identity: PassportIdentity | null): string {
  if (!identity) return "暂不可用";
  const displayName = identity.displayName?.trim() || "未命名";
  const publicIdCode = isCanonicalTetiPublicId(identity.tetiId)
    ? identity.tetiId.slice(TETI_PUBLIC_ID_PREFIX.length)
    : isCanonicalTetiRelayChatmailAddress(identity.address)
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
  const lastSeenAt = validPastOrPresentTimestamp(connection.lastSeen, now);
  const confirmationBaseline = validPastOrPresentTimestamp(
    connection.confirmedAt ?? connection.updatedAt,
    now
  );
  const heartbeatAge = lastSeenAt === null ? NaN : now.getTime() - lastSeenAt;
  const confirmationAge = confirmationBaseline === null ? NaN : now.getTime() - confirmationBaseline;
  const reachability: PeerReachability = connection.connectionState !== "Confirmed"
    ? "unreachable"
    : connection.networkPresence?.state === "online"
      ? "reachable"
      : connection.networkPresence?.state === "offline"
        ? "unreachable"
        : connection.networkPresence
          ? "checking"
          : Number.isFinite(heartbeatAge) && heartbeatAge < REMOTE_TETI_HEARTBEAT_FRESH_MS
            ? "reachable"
            : (Number.isFinite(heartbeatAge) && heartbeatAge < REMOTE_TETI_HEARTBEAT_OFFLINE_MS)
        || (!connection.lastSeen
          && Number.isFinite(confirmationAge)
          && confirmationAge < REMOTE_TETI_HEARTBEAT_OFFLINE_MS)
              ? "checking"
              : "unreachable";
  return {
    requestId: connection.requestId,
    state: connection.connectionState,
    displayName: connection.identity.displayName?.trim() || "未命名",
    publicIdCode: publicTetiIdCode(connection.identity) ?? "ID 暂不可用",
    identityLabel: formatLocalTetiIdentity(connection.identity),
    compatibility: connection.compatibility,
    compatibilityLabel: connection.compatibility === "compatible"
      ? "兼容"
      : connection.compatibility === "upgrade_required"
        ? "需要升级"
        : "待确认版本",
    reachability,
    reachabilityLabel: reachability === "reachable" ? "在线" : reachability === "checking" ? "状态检测中" : "离线",
    passport: toRemotePassportViewModel(connection.passport)
  };
}

function publicTetiIdCode(identity: PassportIdentity): string | null {
  if (isCanonicalTetiPublicId(identity.tetiId)) {
    return identity.tetiId.slice(TETI_PUBLIC_ID_PREFIX.length);
  }
  if (isCanonicalTetiRelayChatmailAddress(identity.address)) {
    return identity.address.slice(0, TETI_PUBLIC_ID_CODE_LENGTH);
  }
  return null;
}

function validPastOrPresentTimestamp(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() ? timestamp : null;
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
    id: resource.id,
    providerName: formatAgentProvider(resource.provider) || "Provider 未标注",
    productName: resource.product,
    kindLabel: formatResourceKind(resource.kind),
    assuranceLabel: formatResourceAssurance(resource.assurance),
    planLabel: unavailable
      ? "暂时无法确认"
      : resource.plan?.displayName || "计划未知",
    availabilityLabel: availabilityLabel(resource.availability),
    remainingPercent: weekly?.remainingPercent ?? null,
    resetLabel: formatResetAt(weekly?.resetAt ?? null),
    inferred: weekly?.identification === "inferred",
    stale: resource.availability === "stale",
    tone,
    icon: resource.id === "openai.codex" ? "codex" : "generic",
    quotas: resource.quotas.map((quota) => ({
      periodLabel: formatQuotaPeriod(quota.period),
      remainingPercent: quota.remainingPercent,
      resetLabel: formatResetAt(quota.resetAt),
      windowLabel: formatQuotaWindow(quota.windowSeconds),
      inferred: quota.identification === "inferred"
    }))
  };
}

export function toAgentViewModel(agent: AiAgent | CallablePassportAgent): AgentViewModel {
  if (isCallablePassportAgent(agent)) {
    const stale = agent.availability === "stale";
    return {
      id: agent.id,
      name: agent.name,
      providerName: formatAgentProvider(agent.provider),
      versionLabel: "版本未共享",
      statusLabel: stale ? "信息已过期" : "可调用",
      detailLabel: [
        formatAgentProvider(agent.provider),
        agent.capabilityIds.map(formatCapabilityId).join("、")
      ].filter(Boolean).join(" · "),
      inputModeLabels: agent.inputModes.map(formatAgentMode),
      outputModeLabels: agent.outputModes.map(formatAgentMode),
      capabilityIds: [...agent.capabilityIds],
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
    versionLabel: agent.version?.trim() || "版本未知",
    statusLabel,
    detailLabel: details.join(" · "),
    inputModeLabels: [],
    outputModeLabels: [],
    capabilityIds: [],
    tone
  };
}

export function toCapabilityViewModel(
  capability: TetiCapability,
  bindings: RemotePassportSnapshot["bindings"] = [],
  agents: AgentViewModel[] = [],
  resources: ResourceViewModel[] = [],
  hasComputeOffer = false
): CapabilityViewModel {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const resourceNames = new Map(resources.map((resource) => [resource.id, resource.productName]));
  return {
    id: capability.id,
    name: capability.name,
    categoryLabel: formatCapabilityId(capability.category),
    description: capability.description.trim(),
    availabilityLabel: availabilityLabel(capability.availability),
    bindings: bindings
      .filter((binding) => binding.capabilityId === capability.id)
      .map((binding) => {
        const resolvedAgents = binding.agentIds.map((id) => agentNames.get(id) ?? id);
        const resolvedResources = binding.resourceIds.map((id) => resourceNames.get(id) ?? id);
        const complete = binding.agentIds.every((id) => agentNames.has(id))
          && binding.resourceIds.every((id) => resourceNames.has(id));
        return {
          agentNames: resolvedAgents,
          resourceNames: resolvedResources,
          statusLabel: complete ? "绑定完整" : "绑定信息不完整"
        };
      }),
    stale: capability.availability === "stale",
    ...(hasComputeOffer ? {
      computeOffer: {
        resourceLabel: "本地算力" as const,
        executionLabel: "接收端本机执行" as const,
        concurrencyLabel: "并发 1" as const,
        approvalLabel: "每次授权" as const
      }
    } : {})
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

function formatResourceKind(kind: AiResource["kind"]): string {
  const known: Record<AiResource["kind"], string> = {
    subscription: "订阅资源",
    account: "账号资源",
    local_model: "本地模型",
    compute: "计算资源"
  };
  return known[kind];
}

function formatResourceAssurance(assurance: AiResource["assurance"]): string {
  const known: Record<AiResource["assurance"], string> = {
    provider_observed: "Provider 已观测",
    local_observed: "本机已观测",
    self_declared: "节点声明"
  };
  return known[assurance];
}

function formatQuotaPeriod(period: string): string {
  const known: Record<string, string> = {
    week: "周额度",
    day: "日额度",
    hour: "小时额度"
  };
  return known[period.toLowerCase()] ?? formatCapabilityId(period);
}

function formatQuotaWindow(windowSeconds: number | null): string {
  if (windowSeconds === null) return "窗口时长未知";
  if (windowSeconds % 86_400 === 0) return `${windowSeconds / 86_400} 天窗口`;
  if (windowSeconds % 3_600 === 0) return `${windowSeconds / 3_600} 小时窗口`;
  return `${windowSeconds} 秒窗口`;
}

function formatAgentMode(mode: "text" | "image"): string {
  return mode === "image" ? "图片" : "文本";
}

function toProviderViewModels(
  resources: ResourceViewModel[],
  agents: AgentViewModel[]
): ProviderViewModel[] {
  const providers = new Map<string, ProviderViewModel>();
  const ensure = (name: string) => {
    const normalizedName = name.trim() || "Provider 未标注";
    const id = normalizedName.toLowerCase();
    const existing = providers.get(id);
    if (existing) return existing;
    const words = normalizedName.split(/\s+/).filter(Boolean);
    const fallbackLabel = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "AI";
    const provider: ProviderViewModel = {
      id,
      name: normalizedName,
      logo: id === "openai" ? "openai" : "generic",
      fallbackLabel,
      resourceNames: [],
      agentNames: []
    };
    providers.set(id, provider);
    return provider;
  };
  for (const resource of resources) ensure(resource.providerName).resourceNames.push(resource.productName);
  for (const agent of agents) ensure(agent.providerName).agentNames.push(agent.name);
  return [...providers.values()];
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
  const resources = passport.resources.map(toResourceViewModel);
  const agents = passport.agents.map(toAgentViewModel);
  const capabilities = (passport.capabilities ?? []).map((capability) =>
    toCapabilityViewModel(
      capability,
      passport.bindings ?? [],
      agents,
      resources,
      (passport.computeOffers ?? []).some((offer) => offer.capability === capability.id)
    )
  );
  return {
    state: passport.state,
    ...(note ? { note } : {}),
    stale: passport.state === "stale",
    resources,
    agents,
    providers: toProviderViewModels(resources, agents),
    capabilities,
    summary: {
      resource: selectSummaryResource(resources),
      resourceOverflowCount: Math.max(0, resources.length - 1),
      agents: agents.slice(0, 2),
      agentOverflowCount: Math.max(0, agents.length - 2),
      capabilities: capabilities.slice(0, 2),
      capabilityOverflowCount: Math.max(0, capabilities.length - 2)
    }
  };
}

function selectSummaryResource(resources: ResourceViewModel[]): ResourceViewModel | null {
  return [...resources].sort((left, right) => {
    const score = (resource: ResourceViewModel) =>
      (resource.remainingPercent === null ? 0 : 100)
      + (resource.tone === "unavailable" ? 0 : 20)
      + (resource.stale ? 0 : 10)
      + (resource.kindLabel === "本地模型" || resource.kindLabel === "计算资源" ? 5 : 0);
    return score(right) - score(left) || left.id.localeCompare(right.id);
  })[0] ?? null;
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
