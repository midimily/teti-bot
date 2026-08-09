import type {
  RegistryStatus,
  TetiAccount,
  TetiStatus
} from "../../../../core/account/model.ts";
import type { RuntimePassportSnapshot } from "../../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../../core/passport/types.ts";
import type { AgentManagementSnapshot } from "../../../../core/observation/management.ts";
import type { CodexUsageState } from "../../src/codex-usage/types.ts";
import type { CallableAgent } from "../../../../core/callability/types.ts";
import type { AgentComputeOffer } from "../../../../core/callability/agent-core.ts";
import type { ExecutionHandle } from "../../../../core/callability/execution.ts";
import type {
  ChildMemorySnapshot,
  DurableMemoryScope,
  MemoryExportResult,
  MemoryRecord
} from "../../../../core/memory/types.ts";
import type {
  CollaborationTaskTransportRecord,
  CollaborationTaskTransportSnapshot,
  CollaborationTaskSummarySnapshot,
  SendCollaborationTaskInput
} from "../../../../core/task/transport.ts";
import type { StagedTaskImage } from "./tasks/attachments.ts";
import type {
  PeerConnectionResult,
  PublicTetiIdentity
} from "../../src/lifecycle-bridge/protocol.ts";
import type { PeerConnectionService } from "../connections.ts";
import type { PassportSharingStore } from "./passport/sharing.ts";
import {
  TetiRuntimeHost,
  type TetiRuntimeHostOptions,
  type TetiRuntimeHostSnapshot,
  type TetiRuntimeScheduledJob
} from "./host.ts";
import type {
  RuntimeAgentConfiguration,
  RuntimeAgentObserver
} from "./agents/types.ts";
import { RuntimePassportService } from "./passport/service.ts";
import type { LocalReleaseStatus } from "../../../../core/release/policy.ts";
import { TETI_RELEASE_POLICY_REFRESH_INTERVAL_MS } from "./release/service.ts";
import { assertTetiNetworkCompatible } from "../../../../services/network/compatibility.ts";
import { TetiNetworkClientError } from "../../../../services/network/errors.ts";
import type {
  TetiNetworkClient,
  TetiNetworkPublicDirectoryPage,
  TetiNetworkPublicDirectoryQuery,
  TetiNetworkPublicStats
} from "../../../../services/network/types.ts";
import type { NetworkPeerPresenceSnapshot } from "../../../../core/passport/snapshot.ts";
import type { RuntimePresencePolicyController } from "./presence/controller.ts";
import type { TetiNetworkProfileSynchronizationResult } from "../../../../services/network/profile-service.ts";
import {
  RuntimeNetworkStateChangeDeduplicator,
  type RuntimeNetworkStateChangeEvent,
  type RuntimeNetworkStateChangeKind
} from "./network/state-change.ts";

export const TETI_RUNTIME_JOB_IDS = {
  networkContract: "network-contract",
  releasePolicy: "release-policy",
  agentDiscovery: "agent-discovery",
  registryHeartbeat: "registry-heartbeat",
  publicProfileSync: "public-profile-sync",
  peerProfileRefresh: "peer-profile-refresh",
  peerPresenceRefresh: "peer-presence-refresh",
  chatmailPoll: "chatmail-poll",
  codexRefresh: "codex-refresh"
} as const;

export const TETI_RUNTIME_INTERVALS = {
  networkContractMs: 15 * 60 * 1_000,
  releasePolicyMs: TETI_RELEASE_POLICY_REFRESH_INTERVAL_MS,
  agentDiscoveryMs: 5 * 60 * 1_000,
  registryHeartbeatMs: 5 * 60 * 1_000,
  publicProfileSyncMs: 5 * 60 * 1_000,
  peerProfileRefreshMs: 15 * 60 * 1_000,
  peerPresenceRefreshMs: 15_000,
  chatmailPollMs: 3_000,
  codexRefreshMs: 10 * 60 * 1_000
} as const;

export const TETI_RUNTIME_SHUTDOWN_TIMEOUT_MS = 2_500;
export const TETI_REGISTRY_RETRY_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000
] as const;

export const TETI_NETWORK_RETRY_DELAYS_MS = [
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000
] as const;

export type RuntimeNetworkContractStatus =
  | { state: "disabled" }
  | { state: "checking" }
  | {
      state: "compatible";
      checkedAt: string;
      protocolVersion: number;
      contractRevision: number;
      serviceVersion: string;
    }
  | {
      state: "unavailable" | "incompatible";
      checkedAt: string;
      errorCode: string;
      retryable: boolean;
      requestId?: string;
    };

export interface RuntimeCodexUsageService {
  getCurrentState(): CodexUsageState;
  refreshNow(): Promise<CodexUsageState>;
}

export interface RuntimeTetiHostAgent {
  getCallableAgents(): CallableAgent[];
  getComputeOffers(): AgentComputeOffer[];
  shutdown(): Promise<void>;
}

export interface RuntimeChildMemoryService {
  list(): Promise<ChildMemorySnapshot>;
  setAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot>;
  saveFromTask(input: {
    task: CollaborationTaskTransportRecord;
    execution: ExecutionHandle;
    scope: DurableMemoryScope;
    confirmed: true;
  }): Promise<MemoryRecord>;
  delete(memoryId: string): Promise<boolean>;
  export(): Promise<MemoryExportResult>;
}

export interface RuntimeLocalReleasePolicyService {
  getStatus(): LocalReleaseStatus;
  refresh(): Promise<LocalReleaseStatus>;
}

export interface TetiRuntimeDependencies {
  networkClient?: TetiNetworkClient;
  loadTetiAccount(): Promise<TetiAccount | null>;
  /** Network Identity/Auth production path; the legacy name remains as a test fallback. */
  synchronizeNetworkIdentity?(): Promise<TetiAccount>;
  heartbeatDiscovery(): Promise<TetiAccount>;
  getPeerConnectionService(): Promise<PeerConnectionService>;
  passportSharingStore: PassportSharingStore;
  codexUsageService: RuntimeCodexUsageService;
  agentObserver?: RuntimeAgentObserver;
  agentConfiguration?: RuntimeAgentConfiguration;
  hostAgent?: RuntimeTetiHostAgent;
  memoryService?: RuntimeChildMemoryService;
  releasePolicyService?: RuntimeLocalReleasePolicyService;
  presenceController?: RuntimePresencePolicyController;
  profileService?: {
    synchronize(): Promise<TetiNetworkProfileSynchronizationResult>;
  };
  dispose?(): Promise<void>;
}

export interface TetiRuntimeOptions {
  dependencies: TetiRuntimeDependencies;
  intervals?: Partial<typeof TETI_RUNTIME_INTERVALS>;
  schedule?: TetiRuntimeHostOptions["schedule"];
  cancel?: TetiRuntimeHostOptions["cancel"];
  now?: TetiRuntimeHostOptions["now"];
  onJobError?: TetiRuntimeHostOptions["onJobError"];
  onRegistryStatusChange?: (input: {
    status: RegistryStatus;
    attempt: number;
    nextRetryMs?: number;
  }) => void;
  onNetworkStatusChange?: (status: RuntimeNetworkContractStatus) => void;
  onStateChange?: (event: RuntimeNetworkStateChangeEvent) => void;
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
  private networkStatus: RuntimeNetworkContractStatus = { state: "disabled" };
  private readonly onNetworkStatusChange: NonNullable<TetiRuntimeOptions["onNetworkStatusChange"]>;
  private registryStatus: RegistryStatus = { state: "unknown" };
  private registryAttempt = 0;
  private readonly onRegistryStatusChange: NonNullable<TetiRuntimeOptions["onRegistryStatusChange"]>;
  private peerConnections: PeerConnectionResult["connections"] | null = null;
  private readonly peerPresence = new Map<string, NetworkPeerPresenceSnapshot>();
  private accountLoadInFlight: Promise<TetiAccount | null> | null = null;
  private networkIdentitySynchronization: Promise<TetiAccount> | null = null;
  private peerServicePromise: Promise<PeerConnectionService> | null = null;
  private readonly shutdownTimeoutMs: number;
  private stopPromise: Promise<TetiRuntimeStopResult> | null = null;
  private agentMutation: Promise<AgentManagementSnapshot> | null = null;
  private readonly stateChanges: RuntimeNetworkStateChangeDeduplicator;

  constructor(options: TetiRuntimeOptions) {
    this.dependencies = options.dependencies;
    this.onNetworkStatusChange = options.onNetworkStatusChange ?? (() => undefined);
    this.onRegistryStatusChange = options.onRegistryStatusChange ?? (() => undefined);
    this.stateChanges = new RuntimeNetworkStateChangeDeduplicator({
      now: options.now,
      onChange: options.onStateChange
    });
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
        getNetworkPresence: (tetiId) => this.peerPresence.get(tetiId),
        getCodexUsage: () => this.getCodexUsageState(),
        getCallableAgents: () => this.dependencies.hostAgent?.getCallableAgents() ?? [],
        getComputeOffers: () => this.dependencies.hostAgent?.getComputeOffers() ?? [],
        getRegistry: () => clone(this.registryStatus),
        getSharing: () => this.dependencies.passportSharingStore.load()
      },
      now: options.now
    });
    const jobs: TetiRuntimeScheduledJob[] = [];
    const networkClient = this.dependencies.networkClient;
    if (networkClient) {
      this.networkStatus = { state: "checking" };
      jobs.push({
        id: TETI_RUNTIME_JOB_IDS.networkContract,
        intervalMs: intervals.networkContractMs,
        runOnStart: true,
        run: async () => {
          try {
            const bootstrap = await networkClient.getBootstrap();
            assertTetiNetworkCompatible(bootstrap);
            this.setNetworkStatus({
              state: "compatible",
              checkedAt: new Date().toISOString(),
              protocolVersion: bootstrap.protocolVersion,
              contractRevision: bootstrap.contractRevision,
              serviceVersion: bootstrap.service.version
            });
          } catch (error) {
            this.setNetworkStatus(networkStatusFromError(error));
            throw error;
          }
        },
        nextDelayMs: (snapshot) => snapshot.consecutiveFailures > 0
          && this.networkStatus.state === "unavailable"
          && this.networkStatus.retryable
            ? TETI_NETWORK_RETRY_DELAYS_MS[
                Math.min(snapshot.consecutiveFailures - 1, TETI_NETWORK_RETRY_DELAYS_MS.length - 1)
              ]
            : intervals.networkContractMs
      });
    }
    const releasePolicyService = this.dependencies.releasePolicyService;
    if (releasePolicyService) {
      jobs.push({
        id: TETI_RUNTIME_JOB_IDS.releasePolicy,
        intervalMs: intervals.releasePolicyMs,
        runOnStart: true,
        run: async () => {
          const status = await releasePolicyService.refresh();
          if (status.state === "update_required") {
            await this.dependencies.hostAgent?.shutdown();
            await this.dependencies.presenceController?.stop();
          }
        }
      });
    }
    const agentObserver = this.dependencies.agentObserver;
    if (agentObserver) {
      jobs.push({
        id: TETI_RUNTIME_JOB_IDS.agentDiscovery,
        intervalMs: intervals.agentDiscoveryMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork(),
        run: async () => {
          await agentObserver.discover();
          this.notifyNetworkProfileStateChange("agent", agentObserver.getCurrentSnapshot());
        }
      });
    }
    jobs.push(
      {
        id: TETI_RUNTIME_JOB_IDS.registryHeartbeat,
        intervalMs: intervals.registryHeartbeatMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          await this.synchronizeNetworkIdentity();
        },
        nextDelayMs: (snapshot) => snapshot.consecutiveFailures > 0
          ? TETI_REGISTRY_RETRY_DELAYS_MS[
              Math.min(snapshot.consecutiveFailures - 1, TETI_REGISTRY_RETRY_DELAYS_MS.length - 1)
            ]
          : intervals.registryHeartbeatMs
      },
      {
        id: TETI_RUNTIME_JOB_IDS.peerProfileRefresh,
        intervalMs: intervals.peerProfileRefreshMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          const service = await this.rawPeerService();
          const refresh = await service.refreshPeerProfiles?.();
          if (!refresh) return;
          // Publish every successful partial refresh before applying retry
          // backoff, so one unavailable peer cannot hide another peer's name.
          this.capturePeerResult(refresh.snapshot);
          if (refresh.failedPeerCount > 0) {
            throw new Error("One or more peer Network profiles could not be refreshed.");
          }
        },
        nextDelayMs: (snapshot) => snapshot.consecutiveFailures > 0
          ? TETI_REGISTRY_RETRY_DELAYS_MS[
              Math.min(snapshot.consecutiveFailures - 1, TETI_REGISTRY_RETRY_DELAYS_MS.length - 1)
            ]
          : intervals.peerProfileRefreshMs
      },
      ...(this.dependencies.profileService ? [{
        id: TETI_RUNTIME_JOB_IDS.publicProfileSync,
        intervalMs: intervals.publicProfileSyncMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          await this.dependencies.profileService!.synchronize();
        },
        nextDelayMs: (snapshot: { consecutiveFailures: number }) => snapshot.consecutiveFailures > 0
          ? TETI_NETWORK_RETRY_DELAYS_MS[
              Math.min(snapshot.consecutiveFailures - 1, TETI_NETWORK_RETRY_DELAYS_MS.length - 1)
            ]
          : intervals.publicProfileSyncMs
      }] : []),
      {
        id: TETI_RUNTIME_JOB_IDS.chatmailPoll,
        intervalMs: intervals.chatmailPollMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          const service = await this.rawPeerService();
          this.capturePeerResult(await service.poll());
        }
      },
      {
        id: TETI_RUNTIME_JOB_IDS.codexRefresh,
        intervalMs: intervals.codexRefreshMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          const state = await this.dependencies.codexUsageService.refreshNow();
          this.notifyNetworkProfileStateChange("resource", state);
        }
      }
    );
    if (this.dependencies.presenceController) {
      jobs.push({
        id: TETI_RUNTIME_JOB_IDS.peerPresenceRefresh,
        intervalMs: intervals.peerPresenceRefreshMs,
        runOnStart: true,
        shouldRun: () => this.localReleaseAllowsWork() && this.hasLocalAccount(),
        run: async () => {
          await this.refreshPeerPresence();
        }
      });
    }
    this.host = new TetiRuntimeHost({
      jobs,
      schedule: options.schedule,
      cancel: options.cancel,
      now: options.now,
      onJobError: options.onJobError
    });
  }

  get snapshot(): TetiRuntimeHostSnapshot {
    return this.host.snapshot;
  }

  getNetworkContractStatus(): RuntimeNetworkContractStatus {
    return clone(this.networkStatus);
  }

  async listPublicNodes(
    query: TetiNetworkPublicDirectoryQuery = {}
  ): Promise<TetiNetworkPublicDirectoryPage> {
    return clone(await this.requireNetworkClient().listPublicNodes(query));
  }

  async getPublicStats(): Promise<TetiNetworkPublicStats> {
    return clone(await this.requireNetworkClient().getPublicStats());
  }

  start(): void {
    this.host.start();
    if (this.localReleaseAllowsWork()) this.dependencies.presenceController?.start();
  }

  stop(): Promise<TetiRuntimeStopResult> {
    if (this.stopPromise) return this.stopPromise;
    const draining = this.host.stop();
    const stoppingPresence = this.dependencies.presenceController?.stop() ?? Promise.resolve();
    const disposing = Promise.resolve().then(() => this.dependencies.dispose?.());
    const stoppingCallableAdapters = Promise.resolve().then(
      () => this.dependencies.hostAgent?.shutdown()
    );
    this.stopPromise = settleWithin(
      [draining, stoppingPresence, disposing, stoppingCallableAdapters],
      this.shutdownTimeoutMs
    );
    return this.stopPromise;
  }

  notifyAccountAvailable(
    account?: TetiAccount,
    options: { synchronizeNetworkIdentity?: boolean } = {}
  ): void {
    if (account) {
      this.discoveryAccount = clone(account);
      this.setRegistryStatus({ state: "unknown" });
      this.dependencies.presenceController?.reportStateChange();
      this.notifyNetworkProfileStateChange("profile", {
        displayName: account.displayName ?? null,
        platform: account.publicProfile.platform,
        category: account.publicProfile.category
      });
    }
    if (options.synchronizeNetworkIdentity !== false) {
      this.host.runNow(TETI_RUNTIME_JOB_IDS.registryHeartbeat);
    }
    this.host.runNow(TETI_RUNTIME_JOB_IDS.peerProfileRefresh);
    this.host.runNow(TETI_RUNTIME_JOB_IDS.chatmailPoll);
    this.host.runNow(TETI_RUNTIME_JOB_IDS.codexRefresh);
    if (this.dependencies.profileService) this.host.runNow(TETI_RUNTIME_JOB_IDS.publicProfileSync);
  }

  async readDiscoveryAccount(): Promise<TetiAccount> {
    const account = this.discoveryAccount ?? await this.loadAccount();
    if (!account) throw new Error("A local Teti account is required before discovery heartbeat.");
    return clone(account);
  }

  synchronizeNetworkIdentity(): Promise<TetiAccount> {
    if (this.networkIdentitySynchronization) return this.networkIdentitySynchronization;
    const synchronization = this.performNetworkIdentitySynchronization();
    this.networkIdentitySynchronization = synchronization;
    void synchronization.finally(() => {
      if (this.networkIdentitySynchronization === synchronization) {
        this.networkIdentitySynchronization = null;
      }
    }).catch(() => undefined);
    return synchronization;
  }

  private async performNetworkIdentitySynchronization(): Promise<TetiAccount> {
    this.registryAttempt += 1;
    try {
      const synchronize = this.dependencies.synchronizeNetworkIdentity
        ?? this.dependencies.heartbeatDiscovery;
      this.discoveryAccount = clone(await synchronize());
      this.setRegistryStatus({
        state: "registered",
        checkedAt: new Date().toISOString()
      });
      return clone(this.discoveryAccount);
    } catch (error) {
      const status = registryStatusFromError(error);
      const failures = (this.host?.snapshot.jobs.find(
        (job) => job.id === TETI_RUNTIME_JOB_IDS.registryHeartbeat
      )?.consecutiveFailures ?? 0) + 1;
      this.setRegistryStatus(
        status,
        TETI_REGISTRY_RETRY_DELAYS_MS[
          Math.min(failures - 1, TETI_REGISTRY_RETRY_DELAYS_MS.length - 1)
        ]
      );
      throw error;
    }
  }

  async getTetiStatus(): Promise<TetiStatus> {
    const account = await this.loadAccount();
    return account
      ? {
          exists: true,
          address: account.address,
          registry: clone(this.registryStatus),
          onlineStatus: "unknown"
        }
      : {
          exists: false,
          registry: { state: "unknown" },
          onlineStatus: "unknown"
        };
  }

  notifyRegistryRegistered(account: TetiAccount): void {
    this.notifyAccountAvailable(account);
    this.setRegistryStatus({
      state: "registered",
      checkedAt: new Date().toISOString()
    });
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

  getPresenceSnapshot() {
    return this.dependencies.presenceController?.snapshot;
  }

  setPresenceSleeping(sleeping: boolean): void {
    this.dependencies.presenceController?.setSleeping(sleeping);
  }

  setPresenceForeground(foreground: boolean): void {
    this.dependencies.presenceController?.setForeground(foreground);
  }

  setPresencePanelVisible(visible: boolean): void {
    this.dependencies.presenceController?.setPanelVisible(visible);
    if (visible) this.host.runNow(TETI_RUNTIME_JOB_IDS.peerPresenceRefresh);
  }

  setPresenceCollaborationActive(active: boolean): void {
    this.dependencies.presenceController?.setCollaborationActive(active);
    this.notifyNetworkProfileStateChange("collaboration", active);
  }

  notifyNetworkProfileStateChange(
    kind: RuntimeNetworkStateChangeKind,
    value: unknown = true
  ): void {
    if (!this.stateChanges.record(kind, value)) return;
    if (kind !== "profile" && kind !== "capability") return;
    const service = this.dependencies.profileService;
    if (!service) return;
    // synchronize() coalesces concurrent calls and schedules one clean rerun.
    // Its content comparison prevents resource/Passport-only changes writing.
    void service.synchronize().catch(() => undefined);
  }

  getLocalReleaseStatus(): LocalReleaseStatus {
    return this.dependencies.releasePolicyService?.getStatus() ?? {
      schemaVersion: 1,
      state: "temporarily_unavailable",
      currentVersion: "unknown",
      buildTimestamp: "unknown",
      source: "none",
      diagnosticCode: "RELEASE_POLICY_UNAVAILABLE"
    };
  }

  private localReleaseAllowsWork(): boolean {
    return this.dependencies.releasePolicyService?.getStatus().state !== "update_required";
  }

  async setPassportSharing(policy: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    if (this.peerServicePromise) {
      await (await this.peerServicePromise).setPassportSharing(policy);
    } else {
      await this.dependencies.passportSharingStore.save(policy);
    }
    this.notifyNetworkProfileStateChange("share_policy", policy);
    return this.passportService.getSnapshot();
  }

  async getAgentManagementSnapshot(): Promise<AgentManagementSnapshot> {
    const observation = this.dependencies.agentObserver?.getCurrentSnapshot() ?? {
      schemaVersion: 1 as const,
      revision: 0,
      state: "disabled" as const,
      generatedAt: new Date(0).toISOString(),
      agents: [],
      errors: []
    };
    let pathOverrides: Record<string, string> = {};
    const errors = [...observation.errors];
    try {
      pathOverrides = await this.dependencies.agentConfiguration?.getPathOverrides() ?? {};
    } catch {
      errors.push({ code: "AGENT_CONFIG_READ_FAILED", recoverable: true });
    }
    return {
      ...clone(observation),
      pathOverrides: clone(pathOverrides),
      errors
    };
  }

  async rescanAgents(): Promise<AgentManagementSnapshot> {
    if (!this.dependencies.agentObserver) return this.getAgentManagementSnapshot();
    await this.dependencies.agentObserver.discover();
    this.notifyNetworkProfileStateChange("agent", this.dependencies.agentObserver.getCurrentSnapshot());
    return this.getAgentManagementSnapshot();
  }

  setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot> {
    if (!this.dependencies.agentConfiguration || !this.dependencies.agentObserver) {
      return Promise.reject(new Error("Agent management is unavailable."));
    }
    const previous = this.agentMutation ?? Promise.resolve(undefined);
    const operation = previous.catch(() => undefined).then(async () => {
      await this.dependencies.agentConfiguration!.setPathOverride(agentId, path);
      const scanWasAlreadyRunning = this.dependencies.agentObserver!
        .getCurrentSnapshot().state === "discovering";
      await this.dependencies.agentObserver!.discover();
      if (scanWasAlreadyRunning) await this.dependencies.agentObserver!.discover();
      this.notifyNetworkProfileStateChange("agent", this.dependencies.agentObserver!.getCurrentSnapshot());
      return this.getAgentManagementSnapshot();
    });
    this.agentMutation = operation;
    const clear = () => {
      if (this.agentMutation === operation) this.agentMutation = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async hasLocalAccount(): Promise<boolean> {
    const account = await this.loadAccount();
    if (account && !this.discoveryAccount) this.discoveryAccount = clone(account);
    if (!account) this.discoveryAccount = null;
    return Boolean(account);
  }

  private setRegistryStatus(status: RegistryStatus, nextRetryMs?: number): void {
    this.registryStatus = clone(status);
    try {
      this.onRegistryStatusChange({
        status: clone(status),
        attempt: this.registryAttempt,
        ...(nextRetryMs === undefined ? {} : { nextRetryMs })
      });
    } catch {
      // Diagnostics do not own Runtime state.
    }
  }

  private setNetworkStatus(status: RuntimeNetworkContractStatus): void {
    this.networkStatus = clone(status);
    try {
      this.onNetworkStatusChange(clone(status));
    } catch {
      // Diagnostics do not own Runtime state.
    }
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

  private requireNetworkClient(): TetiNetworkClient {
    const client = this.dependencies.networkClient;
    if (!client) throw new Error("Teti Network is not configured.");
    return client;
  }

  private async rawPeerService(): Promise<PeerConnectionService> {
    if (!(await this.hasLocalAccount())) {
      throw new Error("A local Teti account is required before starting Chatmail peer services.");
    }
    this.peerServicePromise ??= this.dependencies.getPeerConnectionService();
    return this.peerServicePromise;
  }

  private capturePeerResult(result: PeerConnectionResult): void {
    this.peerConnections = clone(result.connections);
    const currentIds = new Set(this.peerConnections.map((connection) => connection.remoteTetiId));
    for (const id of this.peerPresence.keys()) {
      if (!currentIds.has(id)) this.peerPresence.delete(id);
    }
    for (const connection of this.peerConnections) {
      if (connection.state === "Confirmed" && !this.peerPresence.has(connection.remoteTetiId)) {
        this.peerPresence.set(connection.remoteTetiId, { state: "checking" });
      }
    }
  }

  private async refreshPeerPresence(): Promise<void> {
    const controller = this.dependencies.presenceController;
    if (!controller) return;
    if (!this.peerConnections) {
      const result = await (await this.rawPeerService()).list();
      this.capturePeerResult(result);
    }
    const ids = [...new Set((this.peerConnections ?? [])
      .filter((connection) => connection.state === "Confirmed")
      .map((connection) => connection.remoteTetiId))];
    await Promise.all(ids.map(async (tetiId) => {
      try {
        const response = await controller.read(tetiId);
        this.peerPresence.set(tetiId, response.state === "online"
          ? {
              state: "online",
              mode: response.mode,
              reportedAt: response.reportedAt,
              observedAt: response.observedAt,
              expiresAt: response.expiresAt
            }
          : { state: "offline", observedAt: response.observedAt });
      } catch (error) {
        this.peerPresence.set(tetiId, {
          state: "unavailable",
          checkedAt: new Date().toISOString(),
          errorCode: error instanceof TetiNetworkClientError
            ? error.code
            : "NETWORK_UNAVAILABLE"
        });
      }
    }));
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

  async sendTask(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.sendTask) throw new Error("Task transport is unavailable.");
    return clone(await service.sendTask(input));
  }

  async listTasks(): Promise<CollaborationTaskTransportSnapshot> {
    const service = await this.rawPeerService();
    if (!service.listTasks) throw new Error("Task transport is unavailable.");
    return clone(await service.listTasks());
  }

  async listTaskSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    const service = await this.rawPeerService();
    if (!service.listTaskSummaries) throw new Error("Task summary service is unavailable.");
    return clone(await service.listTaskSummaries());
  }

  async getTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.getTask) throw new Error("Task detail service is unavailable.");
    return clone(await service.getTask(taskId));
  }

  async stageTaskImage(sourcePath: string): Promise<StagedTaskImage> {
    const service = await this.rawPeerService();
    if (!service.stageTaskImage) throw new Error("Task image staging is unavailable.");
    return clone(await service.stageTaskImage(sourcePath));
  }

  async resolveTaskImage(taskId: string, attachmentId: string): Promise<string> {
    const service = await this.rawPeerService();
    if (!service.resolveTaskImage) throw new Error("Task image resolution is unavailable.");
    return service.resolveTaskImage(taskId, attachmentId);
  }

  async approveTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.approveTask) throw new Error("Task approval is unavailable.");
    return clone(await service.approveTask(taskId));
  }

  async rejectTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.rejectTask) throw new Error("Task rejection is unavailable.");
    return clone(await service.rejectTask(taskId));
  }

  async cancelTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.cancelTask) throw new Error("Task cancellation is unavailable.");
    return clone(await service.cancelTask(taskId));
  }

  async getTaskExecution(taskId: string): Promise<ExecutionHandle | null> {
    const service = await this.rawPeerService();
    if (!service.getTaskExecution) throw new Error("Durable execution is unavailable.");
    return clone(await service.getTaskExecution(taskId));
  }

  async resumeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.resumeTask) throw new Error("Durable execution resume is unavailable.");
    return clone(await service.resumeTask(taskId));
  }

  async submitTaskInput(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.submitTaskInput) throw new Error("Long-horizon Task input is unavailable.");
    return clone(await service.submitTaskInput(taskId, instruction));
  }

  async pauseTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.pauseTask) throw new Error("Long-horizon Task pause is unavailable.");
    return clone(await service.pauseTask(taskId));
  }

  async continueTask(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.continueTask) throw new Error("Long-horizon Task continuation is unavailable.");
    return clone(await service.continueTask(taskId, childAgentId));
  }

  async completeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.completeTask) throw new Error("Long-horizon Task completion is unavailable.");
    return clone(await service.completeTask(taskId));
  }

  async renewTask(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord> {
    const service = await this.rawPeerService();
    if (!service.renewTask) throw new Error("Long-horizon Task renewal is unavailable.");
    return clone(await service.renewTask(taskId, ttlMs));
  }

  async getChildMemory(): Promise<ChildMemorySnapshot> {
    if (!this.dependencies.memoryService) throw new Error("Child Memory is unavailable.");
    return clone(await this.dependencies.memoryService.list());
  }

  async setChildMemoryAuthorization(input: {
    scope: DurableMemoryScope;
    workspaceId: string | null;
    childAgentId: string;
    enabled: boolean;
  }): Promise<ChildMemorySnapshot> {
    if (!this.dependencies.memoryService) throw new Error("Child Memory is unavailable.");
    return clone(await this.dependencies.memoryService.setAuthorization(input));
  }

  async saveTaskMemory(
    taskId: string,
    scope: DurableMemoryScope,
    confirmed: true
  ): Promise<ChildMemorySnapshot> {
    if (!this.dependencies.memoryService) throw new Error("Child Memory is unavailable.");
    const service = await this.rawPeerService();
    if (!service.getTask || !service.getTaskExecution) throw new Error("Task Memory source is unavailable.");
    const [task, execution] = await Promise.all([
      service.getTask(taskId),
      service.getTaskExecution(taskId)
    ]);
    if (!execution) throw new Error("Task has no local Child Agent execution.");
    await this.dependencies.memoryService.saveFromTask({
      task,
      execution,
      scope,
      confirmed
    });
    return clone(await this.dependencies.memoryService.list());
  }

  async deleteChildMemory(memoryId: string): Promise<boolean> {
    if (!this.dependencies.memoryService) throw new Error("Child Memory is unavailable.");
    return this.dependencies.memoryService.delete(memoryId);
  }

  async exportChildMemory(): Promise<MemoryExportResult> {
    if (!this.dependencies.memoryService) throw new Error("Child Memory is unavailable.");
    return clone(await this.dependencies.memoryService.export());
  }

  async getPassportSharing(): Promise<PassportSharingPolicy> {
    return clone(await this.dependencies.passportSharingStore.load());
  }

  async updatePassportSharing(policy: PassportSharingPolicy): Promise<PassportSharingPolicy> {
    if (this.peerServicePromise) {
      const saved = clone(await (await this.peerServicePromise).setPassportSharing(policy));
      this.notifyNetworkProfileStateChange("share_policy", saved);
      return saved;
    }
    await this.dependencies.passportSharingStore.save(policy);
    this.notifyNetworkProfileStateChange("share_policy", policy);
    return clone(policy);
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

  sendTask(input: SendCollaborationTaskInput): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.sendTask(input);
  }

  listTasks(): Promise<CollaborationTaskTransportSnapshot> {
    return this.runtime.listTasks();
  }

  listTaskSummaries(): Promise<CollaborationTaskSummarySnapshot> {
    return this.runtime.listTaskSummaries();
  }

  getTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.getTask(taskId);
  }

  stageTaskImage(sourcePath: string): Promise<StagedTaskImage> {
    return this.runtime.stageTaskImage(sourcePath);
  }

  resolveTaskImage(taskId: string, attachmentId: string): Promise<string> {
    return this.runtime.resolveTaskImage(taskId, attachmentId);
  }

  approveTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.approveTask(taskId);
  }

  rejectTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.rejectTask(taskId);
  }

  cancelTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.cancelTask(taskId);
  }

  getTaskExecution(taskId: string): Promise<ExecutionHandle | null> {
    return this.runtime.getTaskExecution(taskId);
  }

  resumeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.resumeTask(taskId);
  }

  submitTaskInput(taskId: string, instruction: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.submitTaskInput(taskId, instruction);
  }

  pauseTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.pauseTask(taskId);
  }

  continueTask(taskId: string, childAgentId?: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.continueTask(taskId, childAgentId);
  }

  completeTask(taskId: string): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.completeTask(taskId);
  }

  renewTask(taskId: string, ttlMs: number): Promise<CollaborationTaskTransportRecord> {
    return this.runtime.renewTask(taskId, ttlMs);
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

function registryStatusFromError(error: unknown): RegistryStatus {
  if (error instanceof TetiNetworkClientError) {
    return {
      state: error.code === "NETWORK_CONFLICT"
        || error.code === "IDENTITY_ALREADY_EXISTS"
        || error.code === "IDEMPOTENCY_CONFLICT"
          ? "conflict"
          : error.code === "NETWORK_UNAUTHORIZED"
            || error.code === "NETWORK_CLIENT_REVOKED"
            || error.code === "PROTOCOL_UNSUPPORTED"
              ? "rejected"
              : "unreachable",
      checkedAt: new Date().toISOString(),
      errorCode: error.code,
      retryable: error.retryable
    };
  }
  if (
    typeof error === "object"
    && error !== null
    && "registry" in error
    && typeof error.registry === "object"
    && error.registry !== null
    && "state" in error.registry
  ) {
    return clone(error.registry as RegistryStatus);
  }
  return {
    state: "unreachable",
    checkedAt: new Date().toISOString(),
    errorCode: "REG_UNKNOWN",
    retryable: true
  };
}

function networkStatusFromError(error: unknown): RuntimeNetworkContractStatus {
  const checkedAt = new Date().toISOString();
  if (error instanceof TetiNetworkClientError) {
    return {
      state: error.code === "PROTOCOL_UNSUPPORTED" || error.code === "NETWORK_INVALID_RESPONSE"
        ? "incompatible"
        : "unavailable",
      checkedAt,
      errorCode: error.code,
      retryable: error.retryable,
      ...(error.requestId ? { requestId: error.requestId } : {})
    };
  }
  return {
    state: "unavailable",
    checkedAt,
    errorCode: "NETWORK_UNAVAILABLE",
    retryable: true
  };
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
