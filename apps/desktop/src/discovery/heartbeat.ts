import type { FirstLaunchSnapshot } from "../first-launch/state-machine.ts";
import type { TetiProvisioningMode } from "../provisioning/modes.ts";

export const DISCOVERY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;

export function shouldRunDiscoveryHeartbeat(
  snapshot: FirstLaunchSnapshot,
  mode: TetiProvisioningMode
): boolean {
  return mode === "real" && Boolean(snapshot.account);
}

export interface DiscoveryHeartbeatClient {
  heartbeat(): Promise<unknown>;
}

export interface DiscoveryHeartbeatControllerOptions {
  client: DiscoveryHeartbeatClient;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onFailure?: () => void;
}

export class DiscoveryHeartbeatController {
  private readonly client: DiscoveryHeartbeatClient;
  private readonly intervalMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onFailure: () => void;
  private active = false;
  private generation = 0;
  private timer: unknown;

  constructor(options: DiscoveryHeartbeatControllerOptions) {
    this.client = options.client;
    this.intervalMs = options.intervalMs ?? DISCOVERY_HEARTBEAT_INTERVAL_MS;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    void this.run(generation);
  }

  stop(): void {
    if (!this.active && this.timer === undefined) return;
    this.active = false;
    this.generation += 1;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  private async run(generation: number): Promise<void> {
    try {
      await this.client.heartbeat();
    } catch {
      this.onFailure();
    } finally {
      if (!this.active || generation !== this.generation) return;
      this.timer = this.schedule(() => {
        this.timer = undefined;
        void this.run(generation);
      }, this.intervalMs);
    }
  }
}
