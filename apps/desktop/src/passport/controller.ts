import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../../core/passport/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import type { OsaurusNativeChildSettingsDto } from "../lifecycle-bridge/protocol.ts";
import {
  emptyAgentManagementSnapshot,
  type AgentManagementSnapshot
} from "../../../../core/observation/management.ts";
import { toPassportViewModel } from "./view-model.ts";

const PASSPORT_READ_INTERVAL_MS = 3_000;

export interface PassportClient {
  getSnapshot(): Promise<RuntimePassportSnapshot>;
  setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot>;
  getAgentManagement(): Promise<AgentManagementSnapshot>;
  rescanAgents(): Promise<AgentManagementSnapshot>;
  setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot>;
  getOsaurusNativeChildSettings?(): Promise<OsaurusNativeChildSettingsDto>;
  setOsaurusNativeChildAgentId?(agentId: string | null): Promise<OsaurusNativeChildSettingsDto>;
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
}

export class PassportController {
  private readonly client: PassportClient;
  private readonly onChange: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private active = false;
  private timer: unknown;
  private readInFlight?: Promise<void>;
  private sharingRevision = 0;
  private persistedSharing: PassportSharingPolicy;
  private sharingWrite?: Promise<void>;
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
    this.snapshotValue.openPanel = this.snapshotValue.openPanel === panel ? null : panel;
    this.notifyChange();
  }

  closePanel(notify = true): void {
    if (this.snapshotValue.openPanel === null) return;
    this.snapshotValue.openPanel = null;
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

  private async readSnapshot(): Promise<void> {
    try {
      const [passport, agentManagement, osaurusNative] = await Promise.all([
        this.client.getSnapshot(),
        this.client.getAgentManagement(),
        this.client.getOsaurusNativeChildSettings?.()
          ?? Promise.resolve(this.snapshotValue.osaurusNative ?? {
            schemaVersion: 1 as const,
            agentId: null,
            readiness: "unconfigured" as const
          })
      ]);
      if (!this.active) return;
      const desiredSharing = this.snapshotValue.passport.sharing;
      this.snapshotValue.passport = passport;
      this.snapshotValue.agentManagement = agentManagement;
      if (!this.snapshotValue.osaurusNativeBusy) {
        this.snapshotValue.osaurusNative = osaurusNative;
        this.snapshotValue.osaurusNativeError = undefined;
      }
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
      // A later local-only read retries; transport details are never shown.
    }
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
    registry: { state: "unknown" },
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
