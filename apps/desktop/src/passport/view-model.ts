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
import type {
  AgentManagementErrorCode,
  LocalLogoutErrorCode,
  NetworkEnvironmentErrorCode,
  OsaurusNativeErrorCode,
  PassportControllerSnapshot,
  PassportSharingErrorCode
} from "./controller.ts";
import type { AgentObservation } from "../../../../core/observation/types.ts";
import { emptyAgentManagementSnapshot } from "../../../../core/observation/management.ts";
import { TETI_BUILD_INFO } from "../build-info.ts";
import { createDesktopI18n, formatMessage, type DesktopI18n } from "../i18n/index.ts";
import { DEFAULT_TETI_NETWORK_BASE_URL } from "../../../../services/network/config.ts";

export type ResourceTone = "free" | "plus" | "pro" | "unknown" | "unavailable";
export type ResourceIcon = "codex" | "generic";
export type PeerReachability = "reachable" | "checking" | "unreachable" | "unavailable";

export interface ResourceQuotaViewModel {
  periodLabel: string;
  remainingPercent: number;
  resetLabel: string;
  windowLabel: string;
  inferred: boolean;
}

export interface ResourceViewModel {
  id: string;
  kind: AiResource["kind"];
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
  statusLabel: string;
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
    resourceLabel: string;
    executionLabel: string;
    concurrencyLabel: string;
    approvalLabel: string;
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
  osaurusNativeState: "unconfigured" | "checking" | "blocked" | "ready";
  osaurusNativeStatus: string;
  osaurusNativeReason?: string;
  osaurusNativeError?: string;
  useLocalDevelopmentNetwork: boolean;
  networkEnvironmentBusy: boolean;
  networkEnvironmentEndpoint: string;
  networkEnvironmentNextEndpoint: string;
  networkEnvironmentActiveLabel: string;
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
  compatibilityLabel: string;
  reachability: PeerReachability;
  reachabilityLabel: string;
  passport: RemotePassportViewModel;
}

export interface PassportViewModel {
  aiPanel: AiPassportPanelViewModel;
  settings: PassportSettingsViewModel;
  connections: ConnectionCardViewModel[];
}

const REMOTE_TETI_HEARTBEAT_FRESH_MS = 20_000;
const REMOTE_TETI_HEARTBEAT_OFFLINE_MS = 60_000;
const DEFAULT_PASSPORT_I18N = createDesktopI18n("zh-Hans");

export function toPassportViewModel(
  snapshot: PassportControllerSnapshot,
  now = new Date(),
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): PassportViewModel {
  const settingsMessages = i18n.messages.passport.settings;
  const osaurusNativeState: PassportSettingsViewModel["osaurusNativeState"] =
    snapshot.osaurusNative?.readiness === "ready"
      || snapshot.passport.localPassport.agents.some((agent) => agent.id === "osaurus-native-teti")
      ? "ready"
      : snapshot.osaurusNative?.readiness === "blocked"
        ? "blocked"
        : snapshot.osaurusNative?.agentId
          ? "checking"
          : "unconfigured";
  return {
    aiPanel: {
      title: i18n.messages.passport.title,
      open: snapshot.openPanel === "passport",
      resources: snapshot.passport.localPassport.resources.map((resource) =>
        toResourceViewModel(resource, i18n)
      ),
      agents: snapshot.passport.localPassport.agents.map((agent) =>
        toAgentViewModel(agent, i18n)
      ),
      capabilities: snapshot.passport.localPassport.capabilities.map((capability) =>
        toCapabilityViewModel(capability, [], [], [], false, i18n)
      )
    },
    settings: {
      title: settingsMessages.title,
      identityLabel: formatLocalTetiIdentity(snapshot.passport.identity, i18n),
      ...formatNetworkIdentityStatus(snapshot.passport.networkIdentity, i18n),
      toggleLabel: settingsMessages.sharing,
      open: snapshot.openPanel === "sharing",
      enabled: snapshot.passport.sharing.resourceSummary
        && snapshot.passport.sharing.resourceQuota
        && snapshot.passport.sharing.agents
        && snapshot.passport.sharing.capabilities,
      busy: snapshot.sharingBusy,
      ...(snapshot.sharingErrorCode
        ? { error: passportErrorMessage(snapshot.sharingErrorCode, i18n) }
        : {}),
      agentManagement: toAgentManagementViewModel(snapshot, i18n),
      showOsaurusNativeConfiguration: isOsaurusLocallyAvailable(snapshot),
      osaurusNativeAgentId: snapshot.osaurusNative?.agentId ?? "",
      osaurusNativeBusy: snapshot.osaurusNativeBusy ?? false,
      osaurusNativeState,
      osaurusNativeStatus: osaurusStatusLabel(osaurusNativeState, i18n),
      ...(snapshot.osaurusNative?.reasonCode
        ? { osaurusNativeReason: formatOsaurusNativeReason(
            snapshot.osaurusNative.reasonCode,
            i18n
          ) }
        : {}),
      ...(snapshot.osaurusNativeErrorCode
        ? { osaurusNativeError: passportErrorMessage(snapshot.osaurusNativeErrorCode, i18n) }
        : {}),
      useLocalDevelopmentNetwork: snapshot.networkEnvironment?.useLocalDevelopmentNetwork ?? false,
      networkEnvironmentBusy: snapshot.networkEnvironmentBusy ?? false,
      networkEnvironmentEndpoint: snapshot.networkEnvironment?.activeBaseUrl
        ?? DEFAULT_TETI_NETWORK_BASE_URL,
      networkEnvironmentNextEndpoint: snapshot.networkEnvironment?.configuredBaseUrl
        ?? DEFAULT_TETI_NETWORK_BASE_URL,
      networkEnvironmentActiveLabel:
        snapshot.networkEnvironment?.activeEnvironment === "local_development"
          ? settingsMessages.networkEnvironment.localActive
          : settingsMessages.networkEnvironment.productionActive,
      networkEnvironmentRestartRequired: snapshot.networkEnvironment?.restartRequired ?? false,
      ...(snapshot.networkEnvironmentErrorCode
        ? { networkEnvironmentError: passportErrorMessage(
            snapshot.networkEnvironmentErrorCode,
            i18n
          ) }
        : {}),
      showLocalDevelopmentNetworkSwitch: TETI_BUILD_INFO.localDevelopmentNetworkSwitchEnabled,
      networkVersionLabel: formatNetworkVersion(snapshot.networkContract, i18n),
      ...formatPresenceStatus(snapshot.presence, i18n),
      localLogoutConfirmationRequired: snapshot.localLogoutConfirmationRequired ?? false,
      localLogoutBusy: snapshot.localLogoutBusy ?? false,
      ...(snapshot.localLogoutErrorCode
        ? { localLogoutError: passportErrorMessage(snapshot.localLogoutErrorCode, i18n) }
        : {}),
      appVersion: TETI_BUILD_INFO.appVersion,
      buildTimestamp: TETI_BUILD_INFO.buildTimestamp
    },
    connections: snapshot.passport.connections.map((connection) =>
      toConnectionCardViewModel(connection, now, i18n)
    )
  };
}

function formatNetworkVersion(
  status: PassportControllerSnapshot["networkContract"],
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.passport.settings.networkVersion;
  if (!status || status.state === "checking" || status.state === "disabled") {
    return messages.checking;
  }
  if (status.state !== "compatible") return messages.unavailable;
  return formatMessage(messages.compatible, {
    protocol: status.protocolVersion,
    service: status.serviceVersion
  });
}

function formatPresenceStatus(
  presence: PassportControllerSnapshot["presence"],
  i18n: DesktopI18n
): Pick<PassportSettingsViewModel, "presenceLabel" | "presenceTone"> {
  const messages = i18n.messages.passport.settings.presence;
  if (!presence || presence.state === "stopped") {
    return { presenceLabel: messages.stopped, presenceTone: "pending" };
  }
  if (presence.state === "sleeping") {
    return {
      presenceLabel: messages.sleeping,
      presenceTone: "pending"
    };
  }
  if (presence.state === "checking") {
    return { presenceLabel: messages.checking, presenceTone: "pending" };
  }
  if (presence.state === "unavailable") {
    if (presence.errorCode === "NETWORK_UNAUTHORIZED") {
      return {
        presenceLabel: messages.unauthorized,
        presenceTone: "error"
      };
    }
    return {
      presenceLabel: messages.unavailable,
      presenceTone: "error"
    };
  }
  const mode = presence.mode === "collaborating"
    ? messages.modes.collaborating
    : presence.mode === "viewing_connect"
      ? messages.modes.viewingConnect
      : presence.mode === "background"
        ? messages.modes.background
        : messages.modes.online;
  return {
    presenceLabel: formatMessage(messages.connected, { mode }),
    presenceTone: "ok"
  };
}

export function formatOsaurusNativeReason(
  reasonCode: string,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): string {
  if (reasonCode === "OSAURUS_INSIGHTS_BODY_RETENTION_ACCEPTED") {
    return i18n.messages.passport.settings.osaurus.insightsRetentionAccepted;
  }
  return reasonCode;
}

function osaurusStatusLabel(
  state: PassportSettingsViewModel["osaurusNativeState"],
  i18n: DesktopI18n
): string {
  const statuses = i18n.messages.passport.settings.osaurus.statuses;
  if (state === "ready") return statuses.ready;
  if (state === "blocked") return statuses.blocked;
  if (state === "checking") return statuses.checking;
  return statuses.unconfigured;
}

const BUILTIN_MANAGED_AGENT_IDS = new Set([
  "codex",
  "claude-code",
  "gemini-cli",
  "cursor",
  "codebuddy"
]);

function toAgentManagementViewModel(
  snapshot: PassportControllerSnapshot,
  i18n: DesktopI18n
): AgentManagementViewModel {
  const management = snapshot.agentManagement ?? emptyAgentManagementSnapshot();
  const readyToDisplay = management.revision > 0;
  const scanning = snapshot.agentBusy || management.state === "discovering";
  const availableAgents = readyToDisplay
    ? management.agents.filter(isLocallyAvailableAgent)
    : [];
  const messages = i18n.messages.passport.settings.agentManagement;
  const discoveryLabel = availableAgents.length > 0
    ? i18n.formatPlural(availableAgents.length, messages.found)
    : messages.noneFound;
  const statusLabel = !readyToDisplay
    ? messages.discovering
    : management.state === "discovering"
      ? messages.rescanning
      : management.state === "disabled"
        ? messages.disabled
        : management.state === "degraded"
          ? formatMessage(messages.partiallyComplete, { status: discoveryLabel })
          : discoveryLabel;
  const safeError = snapshot.agentErrorCode
    ? passportErrorMessage(snapshot.agentErrorCode, i18n)
    : (readyToDisplay && management.errors.length > 0
      ? messages.detectorWarning
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
            snapshot.agentBusyId === agent.agentId,
            i18n
          ))
          .sort(compareManagedAgents)
      : [],
    ...(safeError ? { error: safeError } : {})
  };
}

function passportErrorMessage(
  code:
    | PassportSharingErrorCode
    | AgentManagementErrorCode
    | OsaurusNativeErrorCode
    | NetworkEnvironmentErrorCode
    | LocalLogoutErrorCode,
  i18n: DesktopI18n
): string {
  const messages = i18n.messages.passport.settings.errors;
  switch (code) {
    case "sharing_save_failed":
      return messages.sharingSave;
    case "agent_rescan_failed":
      return messages.agentRescan;
    case "agent_path_save_failed":
      return messages.agentPathSave;
    case "osaurus_native_save_failed":
      return messages.osaurusSave;
    case "network_environment_save_failed":
      return messages.networkEnvironmentSave;
    case "local_profile_logout_failed":
      return messages.localReset;
  }
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
  busy: boolean,
  i18n: DesktopI18n
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
  }, i18n);
  return {
    ...agent,
    pathOverride,
    pathPlaceholder: i18n.messages.passport.settings.agentManagement.pathPlaceholder,
    canOverride: BUILTIN_MANAGED_AGENT_IDS.has(observation.agentId),
    busy
  };
}

function formatNetworkIdentityStatus(
  status: RuntimePassportSnapshot["networkIdentity"],
  i18n: DesktopI18n
): Pick<PassportSettingsViewModel, "networkIdentityLabel" | "networkIdentityTone"> {
  const messages = i18n.messages.passport.settings.networkIdentityStatus;
  if (status.state === "active") {
    return {
      networkIdentityLabel: messages.active,
      networkIdentityTone: "ok"
    };
  }
  if (status.state === "unknown") {
    return { networkIdentityLabel: messages.checking, networkIdentityTone: "pending" };
  }
  if (status.state === "pending") {
    return {
      networkIdentityLabel: messages.synchronizing,
      networkIdentityTone: "pending"
    };
  }
  if (status.state === "unavailable") {
    return {
      networkIdentityLabel: formatMessage(messages.unavailable, {
        code: shortNetworkCode(status.errorCode)
      }),
      networkIdentityTone: "pending"
    };
  }
  if (status.state === "unauthorized") {
    return {
      networkIdentityLabel: messages.unauthorized,
      networkIdentityTone: "error"
    };
  }
  if (status.state === "revoked") {
    return {
      networkIdentityLabel: messages.revoked,
      networkIdentityTone: "error"
    };
  }
  return {
    networkIdentityLabel: messages.conflict,
    networkIdentityTone: "error"
  };
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

export function formatLocalTetiIdentity(
  identity: PassportIdentity | null,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): string {
  if (!identity) return i18n.messages.common.unavailable;
  const displayName = identity.displayName?.trim()
    || i18n.messages.connections.list.unnamed;
  const publicIdCode = isCanonicalTetiPublicId(identity.tetiId)
    ? identity.tetiId.slice(TETI_PUBLIC_ID_PREFIX.length)
    : isCanonicalTetiRelayChatmailAddress(identity.address)
      ? identity.address.slice(0, TETI_PUBLIC_ID_CODE_LENGTH)
      : null;
  return formatMessage(
    publicIdCode
      ? i18n.messages.connections.list.identity
      : i18n.messages.connections.list.identityWithoutId,
    { name: displayName, id: publicIdCode ?? "" }
  );
}

export function toConnectionCardViewModel(
  connection: PassportConnectionSnapshot,
  now = new Date(),
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
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
        : connection.networkPresence?.state === "checking"
          ? "checking"
          : connection.networkPresence?.state === "unavailable"
            ? "unavailable"
          : Number.isFinite(heartbeatAge) && heartbeatAge < REMOTE_TETI_HEARTBEAT_FRESH_MS
            ? "reachable"
            : (Number.isFinite(heartbeatAge) && heartbeatAge < REMOTE_TETI_HEARTBEAT_OFFLINE_MS)
        || (!connection.lastSeen
          && Number.isFinite(confirmationAge)
          && confirmationAge < REMOTE_TETI_HEARTBEAT_OFFLINE_MS)
              ? "checking"
              : "unreachable";
  const messages = i18n.messages.connections;
  const displayName = connection.identity.displayName?.trim()
    || messages.list.unnamed;
  const publicIdCode = publicTetiIdCode(connection.identity);
  return {
    requestId: connection.requestId,
    state: connection.connectionState,
    displayName,
    publicIdCode: publicIdCode ?? messages.list.idUnavailable,
    identityLabel: formatMessage(
      publicIdCode ? messages.list.identity : messages.list.identityWithoutId,
      { name: displayName, id: publicIdCode ?? "" }
    ),
    compatibility: connection.compatibility,
    compatibilityLabel: connection.compatibility === "compatible"
      ? messages.list.compatibility.compatible
      : connection.compatibility === "upgrade_required"
        ? messages.list.compatibility.upgradeRequired
        : messages.list.compatibility.checking,
    reachability,
    reachabilityLabel: reachability === "reachable"
      ? messages.list.reachability.reachable
      : reachability === "checking"
        ? messages.list.reachability.checking
        : reachability === "unavailable"
          ? messages.list.reachability.unavailable
          : messages.list.reachability.unreachable,
    passport: toRemotePassportViewModel(connection.passport, i18n)
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

export function toResourceViewModel(
  resource: AiResource,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): ResourceViewModel {
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
    kind: resource.kind,
    providerName: formatAgentProvider(resource.provider)
      || i18n.messages.connections.details.providerUnspecified,
    productName: resource.product,
    kindLabel: formatResourceKind(resource.kind, i18n),
    assuranceLabel: formatResourceAssurance(resource.assurance, i18n),
    planLabel: unavailable
      ? i18n.messages.connections.details.planUnavailable
      : resource.plan?.displayName
        || i18n.messages.connections.details.planUnknown,
    availabilityLabel: availabilityLabel(resource.availability, i18n),
    remainingPercent: weekly?.remainingPercent ?? null,
    resetLabel: formatResetAt(weekly?.resetAt ?? null, i18n),
    inferred: weekly?.identification === "inferred",
    stale: resource.availability === "stale",
    tone,
    icon: resource.id === "openai.codex" ? "codex" : "generic",
    quotas: resource.quotas.map((quota) => ({
      periodLabel: formatQuotaPeriod(quota.period, i18n),
      remainingPercent: quota.remainingPercent,
      resetLabel: formatResetAt(quota.resetAt, i18n),
      windowLabel: formatQuotaWindow(quota.windowSeconds, i18n),
      inferred: quota.identification === "inferred"
    }))
  };
}

export function toAgentViewModel(
  agent: AiAgent | CallablePassportAgent,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): AgentViewModel {
  if (isCallablePassportAgent(agent)) {
    const stale = agent.availability === "stale";
    return {
      id: agent.id,
      name: agent.name,
      providerName: formatAgentProvider(agent.provider),
      versionLabel: i18n.messages.connections.details.agent.versionNotShared,
      statusLabel: stale
        ? i18n.messages.connections.details.agent.informationStale
        : i18n.messages.connections.details.agent.callable,
      detailLabel: [
        formatAgentProvider(agent.provider),
        agent.capabilityIds.map((id) => formatCapabilityId(id, i18n))
          .join(i18n.messages.connections.details.listSeparator)
      ].filter(Boolean).join(" · "),
      inputModeLabels: agent.inputModes.map((mode) => formatAgentMode(mode, i18n)),
      outputModeLabels: agent.outputModes.map((mode) => formatAgentMode(mode, i18n)),
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
    ? i18n.messages.connections.details.agent.running
    : installed
      ? agent.runtimeStatus === "unknown"
        ? i18n.messages.connections.details.agent.installedUnknown
        : i18n.messages.connections.details.agent.installed
      : absent
        ? i18n.messages.connections.details.agent.notFound
        : i18n.messages.connections.details.agent.unconfirmed;
  const providerName = formatAgentProvider(agent.provider);
  const details = [
    providerName,
    agent.version?.trim() || "",
    running && (agent.processCount ?? 0) > 1
      ? i18n.formatPlural(agent.processCount!, i18n.messages.connections.details.agent.processes)
      : ""
  ].filter(Boolean);
  return {
    id: agent.id,
    name: agent.name,
    providerName,
    versionLabel: agent.version?.trim()
      || i18n.messages.connections.details.agent.versionUnknown,
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
  hasComputeOffer = false,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): CapabilityViewModel {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const resourceNames = new Map(resources.map((resource) => [resource.id, resource.productName]));
  return {
    id: capability.id,
    name: capability.name,
    categoryLabel: formatCapabilityId(capability.category, i18n),
    description: capability.description.trim(),
    availabilityLabel: availabilityLabel(capability.availability, i18n),
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
          statusLabel: complete
            ? i18n.messages.connections.details.binding.complete
            : i18n.messages.connections.details.binding.incomplete
        };
      }),
    stale: capability.availability === "stale",
    ...(hasComputeOffer ? {
      computeOffer: {
        resourceLabel: i18n.messages.connections.details.computeOffer.resource,
        executionLabel: i18n.messages.connections.details.computeOffer.execution,
        concurrencyLabel: i18n.messages.connections.details.computeOffer.concurrency,
        approvalLabel: i18n.messages.connections.details.computeOffer.approval
      }
    } : {})
  };
}

function isCallablePassportAgent(
  agent: AiAgent | CallablePassportAgent
): agent is CallablePassportAgent {
  return "capabilityIds" in agent && "availability" in agent;
}

function formatCapabilityId(value: string, i18n: DesktopI18n): string {
  const known: Record<string, string> = {
    coding: i18n.messages.connections.details.capabilityCategories.coding,
    "code-analysis": i18n.messages.connections.details.capabilityCategories.codeAnalysis
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

function formatResourceKind(kind: AiResource["kind"], i18n: DesktopI18n): string {
  const known: Record<AiResource["kind"], string> = {
    subscription: i18n.messages.connections.details.resourceKinds.subscription,
    account: i18n.messages.connections.details.resourceKinds.account,
    local_model: i18n.messages.connections.details.resourceKinds.localModel,
    compute: i18n.messages.connections.details.resourceKinds.compute
  };
  return known[kind];
}

function formatResourceAssurance(assurance: AiResource["assurance"], i18n: DesktopI18n): string {
  const known: Record<AiResource["assurance"], string> = {
    provider_observed: i18n.messages.connections.details.assurances.providerObserved,
    local_observed: i18n.messages.connections.details.assurances.localObserved,
    self_declared: i18n.messages.connections.details.assurances.selfDeclared
  };
  return known[assurance];
}

function formatQuotaPeriod(period: string, i18n: DesktopI18n): string {
  const known: Record<string, string> = {
    week: i18n.messages.connections.details.quotaPeriods.week,
    day: i18n.messages.connections.details.quotaPeriods.day,
    hour: i18n.messages.connections.details.quotaPeriods.hour
  };
  return known[period.toLowerCase()] ?? formatCapabilityId(period, i18n);
}

function formatQuotaWindow(windowSeconds: number | null, i18n: DesktopI18n): string {
  if (windowSeconds === null) {
    return i18n.messages.connections.details.windowUnknown;
  }
  if (windowSeconds % 86_400 === 0) {
    return i18n.formatPlural(windowSeconds / 86_400, i18n.messages.connections.details.daysWindow);
  }
  if (windowSeconds % 3_600 === 0) {
    return i18n.formatPlural(windowSeconds / 3_600, i18n.messages.connections.details.hoursWindow);
  }
  return i18n.formatPlural(windowSeconds, i18n.messages.connections.details.secondsWindow);
}

function formatAgentMode(mode: "text" | "image", i18n: DesktopI18n): string {
  return mode === "image"
    ? i18n.messages.connections.details.modes.image
    : i18n.messages.connections.details.modes.text;
}

function toProviderViewModels(
  resources: ResourceViewModel[],
  agents: AgentViewModel[],
  i18n: DesktopI18n
): ProviderViewModel[] {
  const providers = new Map<string, ProviderViewModel>();
  const ensure = (name: string) => {
    const normalizedName = name.trim()
      || i18n.messages.connections.details.providerUnspecified;
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

function toRemotePassportViewModel(
  passport: RemotePassportSnapshot,
  i18n: DesktopI18n
): RemotePassportViewModel {
  const notes = i18n.messages.connections.details.notes;
  const note = passport.state === "stale"
    ? notes.stale
    : passport.state === "disabled"
      ? notes.disabled
      : passport.state === "unknown"
      ? notes.empty
        : passport.resources.length === 0
          && passport.agents.length === 0
          && (passport.capabilities?.length ?? 0) === 0
          ? notes.empty
          : undefined;
  const resources = passport.resources.map((resource) => toResourceViewModel(resource, i18n));
  const agents = passport.agents.map((agent) => toAgentViewModel(agent, i18n));
  const capabilities = (passport.capabilities ?? []).map((capability) =>
    toCapabilityViewModel(
      capability,
      passport.bindings ?? [],
      agents,
      resources,
      (passport.computeOffers ?? []).some((offer) => offer.capability === capability.id),
      i18n
    )
  );
  return {
    state: passport.state,
    ...(note ? { note } : {}),
    stale: passport.state === "stale",
    resources,
    agents,
    providers: toProviderViewModels(resources, agents, i18n),
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
      + (resource.kind === "local_model" || resource.kind === "compute" ? 5 : 0);
    return score(right) - score(left) || left.id.localeCompare(right.id);
  })[0] ?? null;
}

function availabilityLabel(availability: TetiAvailability, i18n: DesktopI18n): string {
  const messages = i18n.messages.connections.details.availability;
  if (availability === "available") return messages.available;
  if (availability === "stale") return messages.stale;
  if (availability === "unavailable") return messages.unavailable;
  return messages.unknown;
}

export function formatResetAt(
  resetAt: string | null,
  i18n: DesktopI18n = DEFAULT_PASSPORT_I18N
): string {
  const unavailable = i18n.messages.connections.details.resetUnavailable;
  if (!resetAt) return unavailable;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return unavailable;
  const display = i18n.formatDateTime(date, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  return formatMessage(i18n.messages.connections.details.resetAt, { date: display });
}
