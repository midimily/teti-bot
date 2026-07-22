import type { TetiAccount } from "../../../../core/account/model.ts";
import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../../core/passport/types.ts";
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
import { RuntimePassportService } from "./passport/service.ts";

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
 * Passport reads consume the snapshots maintained here; they do not invoke
 * Registry, Chatmail, or provider network work a second time.
 */
export class TetiRuntime {
  private readonly dependencies: TetiRuntimeDependencies;
  private readonly host: TetiRuntimeHost;
  private readonly peerFacade: PeerConnectionService;
  private readonly passportService: RuntimePassportService;
  private discoveryAccount: TetiAccount | null = null;
  private peerConnections: PeerConnectionResult["connections"] | null = null;
  private accountLoadInFlight: Promise<TetiAccount | null> | null = null;
  private peerServicePromise: Promise<PeerConnectionService> | null = null;
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
    this.passportService = new RuntimePassportService({
      sources: {
        loadAccount: () => this.loadAccount(),
        getConnections: () => this.peerConnections ?? [],
        getCodexUsage: () => this.getCodexUsageState(),
        getSharing: async () => (await this.rawPeerService()).getPassportSharing()
      },
      now: options.now
    });
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
            const service = await this.rawPeerService();
            this.capturePeerResult(await service.poll());
          }
        },
        {
          id: TETI_RUNTIME_JOB_IDS.codexRefresh,
          intervalMs: intervals.codexRefreshMs,
          runOnStart: true,
          run: async () => { await this.dependencies.codexUsageService.refreshNow(); }
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

  getPeerConnectionFacade(): PeerConnectionService {
    return this.peerFacade;
  }

  getPassportSnapshot(): Promise<RuntimePassportSnapshot> {
    return this.passportService.getSnapshot();
  }

  async setPassportSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    await (await this.rawPeerService()).setPassportSharing(policy);
    return this.passportService.getSnapshot();
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
    this.peerServicePromise ??= this.dependencies.getPeerConnectionService();
    return this.peerServicePromise;
  }

  private capturePeerResult(result: PeerConnectionResult): void {
    this.peerConnections = clone(result.connections);
  }

  private async readPeerResult(): Promise<PeerConnectionResult> {
    if (!this.peerConnections) {
      const result = await (await this.rawPeerService()).list();
      this.capturePeerResult(result);
    }

    return {
      connections: clone(this.peerConnections ?? []),
      receivedCount: 0,
      heartbeatCount: 0,
      aiStatusCount: 0
    };
  }

  private async captureUserPeerOperation(
    operation: (service: PeerConnectionService) => Promise<PeerConnectionResult>
  ): Promise<PeerConnectionResult> {
    const result = await operation(await this.rawPeerService());
    this.capturePeerResult(result);
    return clone(result);
  }

  async resolvePeer(query: string): Promise<PublicTetiIdentity> {
    return clone(await (await this.rawPeerService()).resolve(query));
  }

  async requestPeer(query: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.request(query));
  }

  async listPeers(): Promise<PeerConnectionResult> {
    return this.readPeerResult();
  }

  async pollPeers(): Promise<PeerConnectionResult> {
    return this.readPeerResult();
  }

  async acceptPeer(requestId: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.accept(requestId));
  }

  async rejectPeer(requestId: string): Promise<PeerConnectionResult> {
    return this.captureUserPeerOperation((service) => service.reject(requestId));
  }

  async getPassportSharing(): Promise<PassportSharingPolicy> {
    return clone(await (await this.rawPeerService()).getPassportSharing());
  }

  async updatePassportSharing(policy: PassportSharingPolicy): Promise<PassportSharingPolicy> {
    return clone(await (await this.rawPeerService()).setPassportSharing(policy));
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

  getPassportSharing(): Promise<PassportSharingPolicy> {
    return this.runtime.getPassportSharing();
  }

  setPassportSharing(policy: PassportSharingPolicy): Promise<PassportSharingPolicy> {
    return this.runtime.updatePassportSharing(policy);
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
