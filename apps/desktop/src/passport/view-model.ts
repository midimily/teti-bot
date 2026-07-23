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
import type { AiResource, TetiAvailability } from "../../../../core/passport/types.ts";
import type { PassportControllerSnapshot } from "./controller.ts";

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

export interface AiPassportPanelViewModel {
  title: string;
  open: boolean;
  resources: ResourceViewModel[];
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
}

export interface RemotePassportViewModel {
  state: RemotePassportSnapshot["state"];
  note?: string;
  stale: boolean;
  resources: ResourceViewModel[];
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
      resources: snapshot.passport.localPassport.resources.map(toResourceViewModel)
    },
    settings: {
      title: "设置",
      identityLabel: formatLocalTetiIdentity(snapshot.passport.identity),
      ...formatRegistryStatus(snapshot.passport.registry),
      toggleLabel: "Passport 分享",
      open: snapshot.openPanel === "sharing",
      enabled: snapshot.passport.sharing.resourceSummary && snapshot.passport.sharing.resourceQuota,
      busy: snapshot.sharingBusy,
      ...(snapshot.sharingError ? { error: snapshot.sharingError } : {})
    },
    connections: snapshot.passport.connections.map((connection) => toConnectionCardViewModel(connection, now))
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

function toRemotePassportViewModel(passport: RemotePassportSnapshot): RemotePassportViewModel {
  const note = passport.state === "stale"
    ? "AI Passport 已过期"
    : passport.state === "disabled"
      ? "对方未分享 AI Passport"
      : passport.state === "unknown"
        ? "暂无 AI Passport"
        : passport.resources.length === 0
          ? "暂无 AI Passport"
          : undefined;
  return {
    state: passport.state,
    ...(note ? { note } : {}),
    stale: passport.state === "stale",
    resources: passport.resources.slice(0, 2).map(toResourceViewModel)
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
