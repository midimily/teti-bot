import type { LocalReleaseStatus } from "../../../../core/release/policy.ts";
import type { LifecycleBridgeClient } from "../provisioning/bridge-lifecycle.ts";
import { TETI_BUILD_INFO } from "../build-info.ts";

const RELEASE_STATUS_POLL_MS = 5_000;

export interface ReleaseStatusClient {
  getStatus(): Promise<LocalReleaseStatus>;
}

export interface ReleaseControllerOptions {
  client: ReleaseStatusClient;
  onChange?: () => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class ReleaseController {
  private readonly client: ReleaseStatusClient;
  private readonly onChange: () => void;
  private readonly schedule: NonNullable<ReleaseControllerOptions["schedule"]>;
  private readonly cancel: NonNullable<ReleaseControllerOptions["cancel"]>;
  private timer: unknown;
  private running = false;
  private presentationKeyValue: string;
  private statusValue: LocalReleaseStatus = {
    schemaVersion: 1,
    state: "checking",
    currentVersion: TETI_BUILD_INFO.appVersion,
    buildTimestamp: TETI_BUILD_INFO.buildTimestamp,
    source: "none"
  };

  constructor(options: ReleaseControllerOptions) {
    this.client = options.client;
    this.onChange = options.onChange ?? (() => undefined);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.presentationKeyValue = releasePresentationKey(this.statusValue);
  }

  get status(): LocalReleaseStatus {
    return structuredClone(this.statusValue);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refresh();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private async refresh(): Promise<void> {
    try {
      this.statusValue = await this.client.getStatus();
      const presentationKey = releasePresentationKey(this.statusValue);
      if (presentationKey !== this.presentationKeyValue) {
        this.presentationKeyValue = presentationKey;
        this.onChange();
      }
    } catch {
      // Runtime owns reachability semantics; a bridge failure must never create a false update lock.
    } finally {
      if (this.running) {
        this.timer = this.schedule(() => { void this.refresh(); }, RELEASE_STATUS_POLL_MS);
      }
    }
  }
}

function releasePresentationKey(status: LocalReleaseStatus): string {
  const { checkedAt: _checkedAt, ...presentation } = status;
  return JSON.stringify(presentation);
}

export class BridgeReleaseStatusClient implements ReleaseStatusClient {
  private readonly bridge: LifecycleBridgeClient;

  constructor(bridge: LifecycleBridgeClient) {
    this.bridge = bridge;
  }

  getStatus(): Promise<LocalReleaseStatus> {
    return this.bridge.request("release.status") as Promise<LocalReleaseStatus>;
  }
}

export class SupportedMockReleaseStatusClient implements ReleaseStatusClient {
  async getStatus(): Promise<LocalReleaseStatus> {
    return {
      schemaVersion: 1,
      state: "supported",
      currentVersion: TETI_BUILD_INFO.appVersion,
      buildTimestamp: TETI_BUILD_INFO.buildTimestamp,
      source: "none"
    };
  }
}
