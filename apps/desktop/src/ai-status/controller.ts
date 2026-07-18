import type { AiStatusSharingSettings } from "../../../../core/ai-status/types.ts";
import type { CodexUsageState } from "../codex-usage/types.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";

const UI_STATUS_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;

export interface AiStatusClient {
  getUsage(): Promise<CodexUsageState>;
  refreshUsage(): Promise<CodexUsageState>;
  getSharing(): Promise<AiStatusSharingSettings>;
  setSharing(enabled: boolean): Promise<AiStatusSharingSettings>;
}

export interface AiStatusControllerSnapshot {
  usage: CodexUsageState;
  statusSharing: boolean;
  sharingBusy: boolean;
  openPanel: "status" | "sharing" | null;
  sharingError?: string;
}

export class AiStatusController {
  private readonly client: AiStatusClient;
  private readonly onChange: () => void;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private active = false;
  private timer: unknown;
  private snapshotValue: AiStatusControllerSnapshot = {
    usage: unavailableUsage(),
    statusSharing: false,
    sharingBusy: false,
    openPanel: null
  };

  constructor(options: {
    client: AiStatusClient;
    onChange: () => void;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
  }) {
    this.client = options.client;
    this.onChange = options.onChange;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get snapshot(): AiStatusControllerSnapshot {
    return structuredClone(this.snapshotValue);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.load(true);
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  togglePanel(panel: "status" | "sharing"): void {
    this.snapshotValue.openPanel = this.snapshotValue.openPanel === panel ? null : panel;
    this.onChange();
  }

  closePanel(notify = true): void {
    if (this.snapshotValue.openPanel === null) return;
    this.snapshotValue.openPanel = null;
    if (notify) this.onChange();
  }

  async setStatusSharing(enabled: boolean): Promise<void> {
    if (this.snapshotValue.sharingBusy || this.snapshotValue.statusSharing === enabled) return;
    const previous = this.snapshotValue.statusSharing;
    this.snapshotValue.statusSharing = enabled;
    this.snapshotValue.sharingBusy = true;
    this.snapshotValue.sharingError = undefined;
    this.onChange();
    try {
      const settings = await this.client.setSharing(enabled);
      this.snapshotValue.statusSharing = settings.statusSharing;
    } catch {
      this.snapshotValue.statusSharing = previous;
      this.snapshotValue.sharingError = "共享设置暂时无法保存。";
    } finally {
      this.snapshotValue.sharingBusy = false;
      this.onChange();
    }
  }

  private async load(forceUsageRefresh: boolean): Promise<void> {
    const [usage, sharing] = await Promise.allSettled([
      forceUsageRefresh ? this.client.refreshUsage() : this.client.getUsage(),
      this.client.getSharing()
    ]);
    if (usage.status === "fulfilled") {
      this.snapshotValue.usage = usage.value;
    }
    if (sharing.status === "fulfilled") {
      this.snapshotValue.statusSharing = sharing.value.statusSharing;
      this.snapshotValue.sharingError = undefined;
    } else {
      this.snapshotValue.statusSharing = false;
      this.snapshotValue.sharingError = "共享设置暂时无法读取。";
    }
    if (usage.status === "fulfilled" || sharing.status === "fulfilled") {
      this.onChange();
    }
    if (this.active) {
      this.timer = this.schedule(() => {
        this.timer = undefined;
        void this.load(false);
      }, UI_STATUS_REFRESH_INTERVAL_MS);
    }
  }
}

export class BridgeAiStatusClient implements AiStatusClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  getUsage(): Promise<CodexUsageState> {
    return this.bridge.request("usage.get") as Promise<CodexUsageState>;
  }

  refreshUsage(): Promise<CodexUsageState> {
    return this.bridge.request("usage.refresh") as Promise<CodexUsageState>;
  }

  getSharing(): Promise<AiStatusSharingSettings> {
    return this.bridge.request("sharing.get") as Promise<AiStatusSharingSettings>;
  }

  setSharing(enabled: boolean): Promise<AiStatusSharingSettings> {
    return this.bridge.request("sharing.set", { enabled }) as Promise<AiStatusSharingSettings>;
  }
}

export class MockAiStatusClient implements AiStatusClient {
  private sharing = false;

  async getUsage(): Promise<CodexUsageState> { return unavailableUsage(); }
  async refreshUsage(): Promise<CodexUsageState> { return unavailableUsage(); }
  async getSharing(): Promise<AiStatusSharingSettings> { return { statusSharing: this.sharing }; }
  async setSharing(enabled: boolean): Promise<AiStatusSharingSettings> {
    this.sharing = enabled;
    return { statusSharing: enabled };
  }
}

function unavailableUsage(): CodexUsageState {
  return {
    status: "unavailable",
    error: {
      code: "NOT_STARTED",
      message: "Codex usage has not been refreshed yet.",
      recoverable: true
    }
  };
}
