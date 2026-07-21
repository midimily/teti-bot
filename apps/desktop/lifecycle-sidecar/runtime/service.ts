import type { TetiAccount } from "../../../../core/account/model.ts";
import type { AiStatusSharingSettings } from "../../../../core/ai-status/types.ts";
import type { CodexUsageState } from "../../src/codex-usage/types.ts";
import type {
  PeerConnectionResult,
  PublicTetiIdentity
} from "../../src/lifecycle-bridge/protocol.ts";
import type { PeerConnectionService } from "../connections.ts";
import {
  TetiRuntimeHost,
  type TetiRuntimeHostOptions,
  type TetiRuntimeHostSnapshot
} from "./host.ts";

export const TETI_RUNTIME_JOB_IDS = {
  registryHeartbeat: "registry-heartbeat",
  chatmailPoll: "chatmail-poll",
  codexRefresh: "codex-refresh"
} as const;

export const TETI_RUNTIME_INTERVALS = {
  registryHeartbeatMs: 5 * 60 * 1_000,
  chatmailPollMs: 3_000,
  codexRefreshMs: 10 * 60 * 1_000
} as const;

export const TETI_RUNTIME_SHUTDOWN_TIMEOUT_MS = 2_500;

export interface RuntimeCodexUsageService {
  getCurrentState(): CodexUsageState;
  refreshNow(): Promise<CodexUsageState>;
}

export interface TetiRuntimeDependencies {
  loadTetiAccount(): Promise<TetiAccount | null>;
  heartbeatDiscovery(): Promise<TetiAccount>;
  getPeerConnectionService(): Promise<PeerConnectionService>;
  codexUsageService: RuntimeCodexUsageService;
  dispose?(): Promise<void>;
}

export interface TetiRuntimeOptions {
  dependencies: TetiRuntimeDependencies;
  intervals?: Partial<typeof TETI_RUNTIME_INTERVALS>;
  schedule?: TetiRuntimeHostOptions["schedule"];
  cancel?: TetiRuntimeHostOptions["cancel"];
  now?: TetiRuntimeHostOptions["now"];
  onJobError?: TetiRuntimeHostOptions["onJobError"];
  shutdownTimeoutMs?: number;
}

export interface TetiRuntimeStopResult {
  timedOut: boolean;
}

/**
 * Owns process-local background work for the existing lifecycle sidecar.
 * Compatibility IPC reads the snapshots maintained here; it does not invoke
 * Registry or Chatmail network polling a second time.
 */
export class TetiRuntime {
  private readonly dependencies: TetiRuntimeDependencies;
  private readonly host: TetiRuntimeHost;
  private readonly peerFacade: PeerConnectionService;
  private discoveryAccount: TetiAccount | null = null;
  private peerConnections: PeerConnectionResult["connections"] | null = null;
  private pendingReceivedCount = 0;
  private pendingHeartbeatCount = 0;
  private pendingAiStatusCount = 0;
  private codexRefreshInFlight: Promise<CodexUsageState> | null = null;
  private accountLoadInFlight: Promise<TetiAccount | null> | null = null;
  private readonly shutdownTimeoutMs: number;
  private stopPromise: Promise<TetiRuntimeStopResult> | null = null;

  constructor(options: TetiRuntimeOptions) {
    this.dependencies = options.dependencies;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? TETI_RUNTIME_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isFinite(this.shutdownTimeoutMs) || this.shutdownTimeoutMs <= 0) {
      throw new Error("Teti Runtime shutdown timeout must be positive.");
    }
    const intervals = { ...TETI_RUNTIME_INTERVALS, ...options.intervals };
    this.peerFacade = new RuntimePeerConnectionFacade(this);
    this.host = new TetiRuntimeHost({
      jobs: [
        {
          id: TETI_RUNTIME_JOB_IDS.registryHeartbeat,
          intervalMs: intervals.registryHeartbeatMs,
          runOnStart: true,
          shouldRun: () => this.hasLocalAccount(),
          run: async () => {
            this.discoveryAccount = clone(await this.dependencies.heartbeatDiscovery());
          }
        },
        {
          id: TETI_RUNTIME_JOB_IDS.chatmailPoll,
          intervalMs: intervals.chatmailPollMs,
          runOnStart: true,
          shouldRun: () => this.hasLocalAccount(),
          run: async () => {
            const service = await this.dependencies.getPeerConnectionService();
            this.capturePeerResult(await service.poll(), true);
          }
        },
        {
          id: TETI_RUNTIME_JOB_IDS.codexRefresh,
          intervalMs: intervals.codexRefreshMs,
          runOnStart: true,
          run: async () => {
            const refresh = this.dependencies.codexUsageService.refreshNow();
            this.codexRefreshInFlight = refresh;
            try {
              await refresh;
            } finally {
              if (this.codexRefreshInFlight === refresh) this.codexRefreshInFlight = null;
            }
          }
        }
      ],
      schedule: options.schedule,
      cancel: options.cancel,
      now: options.now,
      onJobError: options.onJobError
    });
  }

  get snapshot(): TetiRuntimeHostSnapshot {
    return this.host.snapshot;
  }

  start(): void {
    this.host.start();
  }

  stop(): Promise<TetiRuntimeStopResult> {
    if (this.stopPromise) return this.stopPromise;
    const draining = this.host.stop();
    const disposing = Promise.resolve().then(() => this.dependencies.dispose?.());
    this.stopPromise = settleWithin([draining, disposing], this.shutdownTimeoutMs);
    return this.stopPromise;
  }

  notifyAccountAvailable(account?: TetiAccount): void {
    if (account) this.discoveryAccount = clone(account);
    this.host.runNow(TETI_RUNTIME_JOB_IDS.registryHeartbeat);
    this.host.runNow(TETI_RUNTIME_JOB_IDS.chatmailPoll);
  }

  async readDiscoveryAccount(): Promise<TetiAccount> {
    const account = this.discoveryAccount ?? await this.loadAccount();
    if (!account) throw new Error("A local Teti account is required before discovery heartbeat.");
    return clone(account);
  }

  getCodexUsageState(): CodexUsageState {
    return this.dependencies.codexUsageService.getCurrentState();
  }

  async waitForCodexUsageState(): Promise<CodexUsageState> {
    await this.codexRefreshInFlight;
    return this.getCodexUsageState();
  }

  getPeerConnectionFacade(): PeerConnectionService {
    return this.peerFacade;
  }

  private async hasLocalAccount(): Promise<boolean> {
    const account = await this.loadAccount();
    if (account && !this.discoveryAccount) this.discoveryAccount = clone(account);
    if (!account) this.discoveryAccount = null;
    return Boolean(account);
  }

  private async loadAccount(): Promise<TetiAccount | null> {
    if (this.accountLoadInFlight) return this.accountLoadInFlight;
    const load = this.dependencies.loadTetiAccount();
    this.accountLoadInFlight = load;
    try {
      return await load;
    } finally {
      if (this.accountLoadInFlight === load) this.accountLoadInFlight = null;
    }
  }

  private async rawPeerService(): Promise<PeerConnectionService> {
    return this.dependencies.getPeerConnectionService();
  }

  private capturePeerResult(result: PeerConnectionResult, publishEvents: boolean): void {
    this.peerConnections = clone(result.connections);
    if (!publishEvents) return;
    this.pendingReceivedCount += result.receivedCount;
    this.pendingHeartbeatCount += result.heartbeatCount;
    this.pendingAiStatusCount += result.aiStatusCount ?? 0;
  }

  private async readPeerResult(consumeEvents: boolean): Promise<PeerConnectionResult> {
    if (!this.peerConnections) {
      const result = await (await this.rawPeerService()).list();
      this.capturePeerResult(result, false);
    }

    const result: PeerConnectionResult = {
      connections: clone(this.peerConnections ?? []),
      receivedCount: this.pendingReceivedCount,
      heartbeatCount: this.pendingHeartbeatCount,
      aiStatusCount: this.pendingAiStatusCount
    };
    if (consumeEvents) {
      this.pendingReceivedCount = 0;
      this.pendingHeartbeatCount = 0;
      this.pendingAiStatusCount = 0;
    }
    return result;
  }

  private async captureUserPeerOperation(
    operation: (service: PeerConnectionService) => Promise<PeerConnectionResult>
  ): Promise<PeerConnectionResult> {
    const result = await operation(await this.rawPeerService());
    this.capturePeerResult(result, false);
    return clone(result);
  }

  async resolvePeer(query: string): Promise<PublicTetiIdentity> {
    return clone(await (await this.rawPeerService()).resolve(query));
  }

  async requestPeer(query: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.request(query));
  }

  async listPeers(): Promise<PeerConnectionResult> {
    return this.readPeerResult(false);
  }

  async pollPeers(): Promise<PeerConnectionResult> {
    return this.readPeerResult(true);
  }

  async acceptPeer(requestId: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.accept(requestId));
  }

  async rejectPeer(requestId: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.reject(requestId));
  }

  async getStatusSharing(): Promise<AiStatusSharingSettings> {
    return clone(await (await this.rawPeerService()).getStatusSharing());
  }

  async setStatusSharing(enabled: boolean): Promise<AiStatusSharingSettings> {
    return clone(await (await this.rawPeerService()).setStatusSharing(enabled));
  }
}

class RuntimePeerConnectionFacade implements PeerConnectionService {
  private readonly runtime: TetiRuntime;

  constructor(runtime: TetiRuntime) {
    this.runtime = runtime;
  }

  resolve(query: string): Promise<PublicTetiIdentity> {
    return this.runtime.resolvePeer(query);
  }

  request(query: string): Promise<PeerConnectionResult> {
    return this.runtime.requestPeer(query);
  }

  list(): Promise<PeerConnectionResult> {
    return this.runtime.listPeers();
  }

  poll(): Promise<PeerConnectionResult> {
    return this.runtime.pollPeers();
  }

  accept(requestId: string): Promise<PeerConnectionResult> {
    return this.runtime.acceptPeer(requestId);
  }

  reject(requestId: string): Promise<PeerConnectionResult> {
    return this.runtime.rejectPeer(requestId);
  }

  getStatusSharing(): Promise<AiStatusSharingSettings> {
    return this.runtime.getStatusSharing();
  }

  setStatusSharing(enabled: boolean): Promise<AiStatusSharingSettings> {
    return this.runtime.setStatusSharing(enabled);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<TetiRuntimeStopResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    void Promise.allSettled(promises).then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ timedOut: false });
    });
  });
}
