import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../../core/passport/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type {
  OsaurusNativeChildSettingsDto,
  RuntimePresenceStatusDto,
  TetiNetworkEnvironmentSettingsDto
} from "../lifecycle-bridge/protocol.ts";
import {
  emptyAgentManagementSnapshot,
  type AgentManagementSnapshot
} from "../../../../core/observation/management.ts";
import { toPassportViewModel } from "./view-model.ts";
import {
  DEFAULT_TETI_NETWORK_BASE_URL,
  DEVELOPMENT_TETI_NETWORK_BASE_URL
} from "../../../../services/network/config.ts";

const PASSPORT_READ_INTERVAL_MS = 3_000;

export interface PassportClient {
  getSnapshot(): Promise<RuntimePassportSnapshot>;
  setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot>;
  getAgentManagement(): Promise<AgentManagementSnapshot>;
  rescanAgents(): Promise<AgentManagementSnapshot>;
  setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot>;
  getOsaurusNativeChildSettings?(): Promise<OsaurusNativeChildSettingsDto>;
  setOsaurusNativeChildAgentId?(agentId: string | null): Promise<OsaurusNativeChildSettingsDto>;
  getNetworkEnvironmentSettings?(): Promise<TetiNetworkEnvironmentSettingsDto>;
  setLocalDevelopmentNetwork?(enabled: boolean): Promise<TetiNetworkEnvironmentSettingsDto>;
  getPresenceStatus?(): Promise<RuntimePresenceStatusDto | null>;
  logoutLocalProfile?(): Promise<never>;
}

export interface PassportControllerSnapshot {
  passport: RuntimePassportSnapshot;
  agentManagement: AgentManagementSnapshot;
  sharingBusy: boolean;
  agentBusy: boolean;
  osaurusNative?: OsaurusNativeChildSettingsDto;
  osaurusNativeBusy?: boolean;
  agentBusyId?: string;
  openPanel: "passport" | "sharing" | null;
  sharingError?: string;
  agentError?: string;
  osaurusNativeError?: string;
  networkEnvironment?: TetiNetworkEnvironmentSettingsDto;
  presence?: RuntimePresenceStatusDto;
  networkEnvironmentBusy?: boolean;
  networkEnvironmentError?: string;
  localLogoutConfirmationRequired?: boolean;
  localLogoutBusy?: boolean;
  localLogoutError?: string;
}

export class PassportController {
  private readonly client: PassportClient;
  private readonly onChange: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private active = false;
  private timer: unknown;
  private readInFlight?: Promise<void>;
  private localSettingsReadInFlight?: Promise<void>;
  private sharingRevision = 0;
  private persistedSharing: PassportSharingPolicy;
  private sharingWrite?: Promise<void>;
  private networkEnvironmentWrite?: Promise<void>;
  private snapshotValue: PassportControllerSnapshot;
  private lastPresentationKey = "";

  constructor(options: {
    client: PassportClient;
    onChange: () => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    initialSnapshot?: RuntimePassportSnapshot;
  }) {
    this.client = options.client;
    this.onChange = options.onChange;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const passport = options.initialSnapshot ?? emptyPassportSnapshot();
    this.persistedSharing = { ...passport.sharing };
    this.snapshotValue = {
      passport,
      agentManagement: emptyAgentManagementSnapshot(),
      sharingBusy: false,
      agentBusy: false,
      osaurusNative: { schemaVersion: 1, agentId: null, readiness: "unconfigured" },
      osaurusNativeBusy: false,
      networkEnvironmentBusy: false,
      localLogoutConfirmationRequired: false,
      localLogoutBusy: false,
      openPanel: null
    };
    this.lastPresentationKey = this.presentationKey();
  }

  get snapshot(): PassportControllerSnapshot {
    return structuredClone(this.snapshotValue);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.refreshNow();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  refreshNow(): Promise<void> {
    if (this.readInFlight) return this.readInFlight;
    this.readInFlight = this.readSnapshot().finally(() => {
      this.readInFlight = undefined;
      this.scheduleNextRead();
    });
    return this.readInFlight;
  }

  async refreshAfterMutation(): Promise<void> {
    await this.readInFlight;
    await this.readSnapshot();
  }

  togglePanel(panel: "passport" | "sharing"): void {
    const nextPanel = this.snapshotValue.openPanel === panel ? null : panel;
    this.snapshotValue.openPanel = nextPanel;
    if (nextPanel !== "sharing") this.snapshotValue.localLogoutConfirmationRequired = false;
    this.notifyChange();
  }

  closePanel(notify = true): void {
    if (this.snapshotValue.openPanel === null) return;
    this.snapshotValue.openPanel = null;
    this.snapshotValue.localLogoutConfirmationRequired = false;
    if (notify) this.notifyChange();
  }

  setResourceSharing(enabled: boolean): Promise<void> {
    const current = this.snapshotValue.passport.sharing;
    if (
      current.resourceSummary === enabled
      && current.resourceQuota === enabled
      && current.agents === enabled
      && current.capabilities === enabled
    ) {
      return this.sharingWrite ?? Promise.resolve();
    }
    this.snapshotValue.passport.sharing = {
      ...current,
      resourceSummary: enabled,
      resourceQuota: enabled,
      agents: enabled,
      capabilities: enabled
    };
    this.sharingRevision += 1;
    this.snapshotValue.sharingBusy = true;
    this.snapshotValue.sharingError = undefined;
    this.notifyChange();
    this.sharingWrite ??= this.flushSharingWrites();
    return this.sharingWrite;
  }

  async rescanAgents(): Promise<void> {
    if (this.snapshotValue.agentBusy) return;
    this.snapshotValue.agentBusy = true;
    this.snapshotValue.agentBusyId = undefined;
    this.snapshotValue.agentError = undefined;
    this.notifyChange();
    try {
      this.snapshotValue.agentManagement = await this.client.rescanAgents();
    } catch {
      this.snapshotValue.agentError = "Agent 重新扫描暂时失败。";
    } finally {
      this.snapshotValue.agentBusy = false;
      this.notifyChange();
    }
  }

  async setAgentPathOverride(agentId: string, path: string): Promise<void> {
    if (this.snapshotValue.agentBusy) return;
    this.snapshotValue.agentBusy = true;
    this.snapshotValue.agentBusyId = agentId;
    this.snapshotValue.agentError = undefined;
    this.notifyChange();
    try {
      this.snapshotValue.agentManagement = await this.client.setAgentPathOverride(
        agentId,
        path.trim() || null
      );
    } catch {
      this.snapshotValue.agentError = "路径无效或本机 Agent 配置暂时无法保存。";
    } finally {
      this.snapshotValue.agentBusy = false;
      this.snapshotValue.agentBusyId = undefined;
      this.notifyChange();
    }
  }

  async setOsaurusNativeChildAgentId(agentId: string | null): Promise<void> {
    if (this.snapshotValue.osaurusNativeBusy) return;
    this.snapshotValue.osaurusNativeBusy = true;
    this.snapshotValue.osaurusNativeError = undefined;
    this.notifyChange();
    try {
      if (!this.client.setOsaurusNativeChildAgentId) throw new Error("unavailable");
      this.snapshotValue.osaurusNative = await this.client.setOsaurusNativeChildAgentId(
        agentId?.trim() || null
      );
      await this.refreshAfterMutation();
    } catch {
      this.snapshotValue.osaurusNativeError = "固定 Agent ID 无效，或本机配置暂时无法保存。";
    } finally {
      this.snapshotValue.osaurusNativeBusy = false;
      this.notifyChange();
    }
  }

  setLocalDevelopmentNetwork(enabled: boolean): Promise<void> {
    if (this.snapshotValue.networkEnvironmentBusy) {
      return this.networkEnvironmentWrite ?? Promise.resolve();
    }
    this.snapshotValue.networkEnvironmentBusy = true;
    this.snapshotValue.networkEnvironmentError = undefined;
    this.notifyChange();
    const write = (async () => {
      try {
        if (!this.client.setLocalDevelopmentNetwork) throw new Error("unavailable");
        this.snapshotValue.networkEnvironment = await this.client.setLocalDevelopmentNetwork(enabled);
      } catch {
        this.snapshotValue.networkEnvironmentError = "Network 开发环境设置暂时无法保存。";
      } finally {
        this.snapshotValue.networkEnvironmentBusy = false;
        this.networkEnvironmentWrite = undefined;
        this.notifyChange();
      }
    })();
    this.networkEnvironmentWrite = write;
    return write;
  }

  requestLocalProfileLogout(): void {
    if (this.snapshotValue.localLogoutBusy
      || this.snapshotValue.localLogoutConfirmationRequired) return;
    this.snapshotValue.localLogoutConfirmationRequired = true;
    this.snapshotValue.localLogoutError = undefined;
    this.notifyChange();
  }

  cancelLocalProfileLogout(): void {
    if (this.snapshotValue.localLogoutBusy
      || !this.snapshotValue.localLogoutConfirmationRequired) return;
    this.snapshotValue.localLogoutConfirmationRequired = false;
    this.notifyChange();
  }

  async confirmLocalProfileLogout(): Promise<void> {
    if (this.snapshotValue.localLogoutBusy
      || !this.snapshotValue.localLogoutConfirmationRequired) return;
    this.snapshotValue.localLogoutConfirmationRequired = false;
    this.snapshotValue.localLogoutBusy = true;
    this.snapshotValue.localLogoutError = undefined;
    this.stop();
    this.notifyChange();
    try {
      if (!this.client.logoutLocalProfile) throw new Error("unavailable");
      await this.client.logoutLocalProfile();
    } catch {
      this.snapshotValue.localLogoutBusy = false;
      this.snapshotValue.localLogoutError = "本机 Teti Profile 暂时无法清理，请退出 App 后重试。";
      this.start();
      this.notifyChange();
    }
  }

  private async readSnapshot(): Promise<void> {
    // Agent discovery and provider-specific settings are local enhancements. They must
    // never delay or suppress a valid peer Passport snapshot.
    void this.refreshLocalSettings();
    try {
      const passport = await this.client.getSnapshot();
      if (!this.active) return;
      const desiredSharing = this.snapshotValue.passport.sharing;
      this.snapshotValue.passport = passport;
      if (this.snapshotValue.sharingBusy) {
        this.snapshotValue.passport.sharing = desiredSharing;
      } else {
        this.persistedSharing = { ...passport.sharing };
        this.snapshotValue.sharingError = undefined;
      }
      const presentationKey = this.presentationKey();
      if (presentationKey !== this.lastPresentationKey) {
        this.lastPresentationKey = presentationKey;
        this.onChange();
      }
    } catch {
      // A later Passport read retries; transport details are never shown.
    }
  }

  private refreshLocalSettings(): Promise<void> {
    if (this.localSettingsReadInFlight) return this.localSettingsReadInFlight;
    const nativeFallback = this.snapshotValue.osaurusNative ?? {
      schemaVersion: 1 as const,
      agentId: null,
      readiness: "unconfigured" as const
    };
    const read = Promise.allSettled([
      this.client.getAgentManagement(),
      this.client.getOsaurusNativeChildSettings?.() ?? Promise.resolve(nativeFallback),
      this.client.getNetworkEnvironmentSettings?.() ?? Promise.resolve(undefined),
      this.client.getPresenceStatus?.() ?? Promise.resolve(null)
    ]).then(([agentManagement, osaurusNative, networkEnvironment, presence]) => {
      if (!this.active) return;
      if (agentManagement.status === "fulfilled" && !this.snapshotValue.agentBusy) {
        this.snapshotValue.agentManagement = agentManagement.value;
      }
      if (osaurusNative.status === "fulfilled" && !this.snapshotValue.osaurusNativeBusy) {
        this.snapshotValue.osaurusNative = osaurusNative.value;
        this.snapshotValue.osaurusNativeError = undefined;
      }
      if (networkEnvironment.status === "fulfilled"
        && networkEnvironment.value
        && !this.snapshotValue.networkEnvironmentBusy) {
        this.snapshotValue.networkEnvironment = networkEnvironment.value;
        this.snapshotValue.networkEnvironmentError = undefined;
      }
      if (presence.status === "fulfilled" && presence.value) {
        this.snapshotValue.presence = presence.value;
      }
      const presentationKey = this.presentationKey();
      if (presentationKey !== this.lastPresentationKey) {
        this.lastPresentationKey = presentationKey;
        this.onChange();
      }
    }).finally(() => {
      if (this.localSettingsReadInFlight === read) this.localSettingsReadInFlight = undefined;
    });
    this.localSettingsReadInFlight = read;
    return read;
  }

  private async flushSharingWrites(): Promise<void> {
    try {
      while (true) {
        const revision = this.sharingRevision;
        const desired = { ...this.snapshotValue.passport.sharing };
        try {
          const passport = await this.client.setSharing(desired);
          this.persistedSharing = { ...passport.sharing };
          if (revision === this.sharingRevision) {
            this.snapshotValue.passport = passport;
            this.snapshotValue.sharingError = undefined;
            return;
          }
        } catch {
          if (revision === this.sharingRevision) {
            this.snapshotValue.passport.sharing = { ...this.persistedSharing };
            this.snapshotValue.sharingError = "Passport 分享设置暂时无法保存。";
            return;
          }
        }
      }
    } finally {
      this.snapshotValue.sharingBusy = false;
      this.sharingWrite = undefined;
      this.notifyChange();
    }
  }

  private scheduleNextRead(): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, PASSPORT_READ_INTERVAL_MS);
  }

  private notifyChange(): void {
    this.lastPresentationKey = this.presentationKey();
    this.onChange();
  }

  private presentationKey(): string {
    return JSON.stringify(toPassportViewModel(this.snapshotValue, new Date()));
  }
}

export class BridgePassportClient implements PassportClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  getSnapshot(): Promise<RuntimePassportSnapshot> {
    return this.bridge.request("passport.get") as Promise<RuntimePassportSnapshot>;
  }

  setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    return this.bridge.request("passport.sharing.set", { policy }) as Promise<RuntimePassportSnapshot>;
  }

  getAgentManagement(): Promise<AgentManagementSnapshot> {
    return this.bridge.request("agent.observation.get") as Promise<AgentManagementSnapshot>;
  }

  rescanAgents(): Promise<AgentManagementSnapshot> {
    return this.bridge.request("agent.observation.scan") as Promise<AgentManagementSnapshot>;
  }

  setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot> {
    return this.bridge.request("agent.observation.override.set", { agentId, path }) as Promise<AgentManagementSnapshot>;
  }

  getOsaurusNativeChildSettings(): Promise<OsaurusNativeChildSettingsDto> {
    return this.bridge.request("osaurus.native.get") as Promise<OsaurusNativeChildSettingsDto>;
  }

  setOsaurusNativeChildAgentId(agentId: string | null): Promise<OsaurusNativeChildSettingsDto> {
    return this.bridge.request("osaurus.native.set", { agentId }) as Promise<OsaurusNativeChildSettingsDto>;
  }

  getNetworkEnvironmentSettings(): Promise<TetiNetworkEnvironmentSettingsDto> {
    return this.bridge.request("network.environment.get") as Promise<TetiNetworkEnvironmentSettingsDto>;
  }

  setLocalDevelopmentNetwork(enabled: boolean): Promise<TetiNetworkEnvironmentSettingsDto> {
    return this.bridge.request("network.environment.set", { enabled }) as Promise<TetiNetworkEnvironmentSettingsDto>;
  }

  getPresenceStatus(): Promise<RuntimePresenceStatusDto | null> {
    return this.bridge.request("presence.get") as Promise<RuntimePresenceStatusDto | null>;
  }

  logoutLocalProfile(): Promise<never> {
    return this.bridge.logoutLocalProfile();
  }
}

export class MockPassportClient implements PassportClient {
  private passport = emptyPassportSnapshot();
  private agentManagement: AgentManagementSnapshot = {
    ...emptyAgentManagementSnapshot(),
    revision: 1,
    state: "ready",
    generatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  private osaurusNative: OsaurusNativeChildSettingsDto = {
    schemaVersion: 1,
    agentId: null,
    readiness: "unconfigured"
  };
  private networkEnvironment: TetiNetworkEnvironmentSettingsDto = {
    schemaVersion: 1,
    useLocalDevelopmentNetwork: false,
    activeEnvironment: "production",
    activeBaseUrl: DEFAULT_TETI_NETWORK_BASE_URL,
    configuredEnvironment: "production",
    configuredBaseUrl: DEFAULT_TETI_NETWORK_BASE_URL,
    restartRequired: false
  };

  async getSnapshot(): Promise<RuntimePassportSnapshot> {
    return structuredClone(this.passport);
  }

  async setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    this.passport.sharing = { ...policy };
    this.passport.revision += 1;
    this.passport.generatedAt = new Date().toISOString();
    return structuredClone(this.passport);
  }

  async getAgentManagement(): Promise<AgentManagementSnapshot> {
    return structuredClone(this.agentManagement);
  }

  async rescanAgents(): Promise<AgentManagementSnapshot> {
    this.agentManagement.revision += 1;
    this.agentManagement.generatedAt = new Date().toISOString();
    this.agentManagement.completedAt = this.agentManagement.generatedAt;
    return structuredClone(this.agentManagement);
  }

  async setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot> {
    if (path) this.agentManagement.pathOverrides[agentId] = path;
    else delete this.agentManagement.pathOverrides[agentId];
    return this.rescanAgents();
  }

  async getOsaurusNativeChildSettings(): Promise<OsaurusNativeChildSettingsDto> {
    return structuredClone(this.osaurusNative);
  }

  async setOsaurusNativeChildAgentId(agentId: string | null): Promise<OsaurusNativeChildSettingsDto> {
    this.osaurusNative = {
      schemaVersion: 1,
      agentId,
      readiness: agentId ? "checking" : "unconfigured"
    };
    return structuredClone(this.osaurusNative);
  }

  async getNetworkEnvironmentSettings(): Promise<TetiNetworkEnvironmentSettingsDto> {
    return structuredClone(this.networkEnvironment);
  }

  async setLocalDevelopmentNetwork(enabled: boolean): Promise<TetiNetworkEnvironmentSettingsDto> {
    this.networkEnvironment = {
      ...this.networkEnvironment,
      useLocalDevelopmentNetwork: enabled,
      configuredEnvironment: enabled ? "local_development" : "production",
      configuredBaseUrl: enabled
        ? DEVELOPMENT_TETI_NETWORK_BASE_URL
        : DEFAULT_TETI_NETWORK_BASE_URL,
      restartRequired: enabled !== (this.networkEnvironment.activeEnvironment === "local_development")
    };
    return structuredClone(this.networkEnvironment);
  }

  async getPresenceStatus(): Promise<RuntimePresenceStatusDto | null> {
    return null;
  }

  async logoutLocalProfile(): Promise<never> {
    return new Promise<never>(() => undefined);
  }

  setConnections(connections: RuntimePassportSnapshot["connections"]): void {
    this.passport.connections = structuredClone(connections);
    this.passport.revision += 1;
    this.passport.generatedAt = new Date().toISOString();
  }
}

export function emptyPassportSnapshot(now = new Date(0)): RuntimePassportSnapshot {
  const generatedAt = now.toISOString();
  return {
    schemaVersion: 2,
    revision: 0,
    generatedAt,
    identity: null,
    networkIdentity: { state: "unknown" },
    localPassport: {
      schemaVersion: 3,
      generatedAt,
      resources: [{
        id: "openai.codex",
        provider: "OpenAI",
        product: "Codex",
        kind: "subscription",
        availability: "unknown",
        quotas: [],
        assurance: "provider_observed",
        observedAt: generatedAt
      }],
      agents: [],
      capabilities: [],
      bindings: [],
      computeOffers: []
    },
    connections: [],
    sharing: {
      version: 1,
      audience: "confirmed_peers",
      resourceSummary: false,
      resourceQuota: false,
      agents: false,
      capabilities: false
    }
  };
}
