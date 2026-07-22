import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../../core/passport/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";

const PASSPORT_READ_INTERVAL_MS = 3_000;

export interface PassportClient {
  getSnapshot(): Promise<RuntimePassportSnapshot>;
  setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot>;
}

export interface PassportControllerSnapshot {
  passport: RuntimePassportSnapshot;
  sharingBusy: boolean;
  openPanel: "passport" | "sharing" | null;
  sharingError?: string;
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
      sharingBusy: false,
      openPanel: null
    };
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
    this.onChange();
  }

  closePanel(notify = true): void {
    if (this.snapshotValue.openPanel === null) return;
    this.snapshotValue.openPanel = null;
    if (notify) this.onChange();
  }

  setResourceSharing(enabled: boolean): Promise<void> {
    const current = this.snapshotValue.passport.sharing;
    if (current.resourceSummary === enabled && current.resourceQuota === enabled) {
      return this.sharingWrite ?? Promise.resolve();
    }
    this.snapshotValue.passport.sharing = {
      ...current,
      resourceSummary: enabled,
      resourceQuota: enabled,
      agents: false,
      capabilities: false
    };
    this.sharingRevision += 1;
    this.snapshotValue.sharingBusy = true;
    this.snapshotValue.sharingError = undefined;
    this.onChange();
    this.sharingWrite ??= this.flushSharingWrites();
    return this.sharingWrite;
  }

  private async readSnapshot(): Promise<void> {
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
      this.onChange();
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
      this.onChange();
    }
  }

  private scheduleNextRead(): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.refreshNow();
    }, PASSPORT_READ_INTERVAL_MS);
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
}

export class MockPassportClient implements PassportClient {
  private passport = emptyPassportSnapshot();

  async getSnapshot(): Promise<RuntimePassportSnapshot> {
    return structuredClone(this.passport);
  }

  async setSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    this.passport.sharing = { ...policy };
    this.passport.revision += 1;
    this.passport.generatedAt = new Date().toISOString();
    return structuredClone(this.passport);
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
    schemaVersion: 1,
    revision: 0,
    generatedAt,
    identity: null,
    localPassport: {
      schemaVersion: 1,
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
      bindings: []
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
