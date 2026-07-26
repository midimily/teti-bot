import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import type { AgentObservationSnapshot } from "../../../core/observation/types.ts";
import type { AiAgent } from "../../../core/passport/types.ts";
import type { CodexUsageState } from "../src/codex-usage/types.ts";
import type {
  PeerConnectionDto,
  PeerConnectionResult
} from "../src/lifecycle-bridge/protocol.ts";
import type { PeerConnectionService } from "../lifecycle-sidecar/connections.ts";
import { createRuntimeOwnedLifecycleDependencies } from "../lifecycle-sidecar/runtime/lifecycle-adapter.ts";
import {
  TETI_RUNTIME_INTERVALS,
  TetiRuntime,
  type RuntimeCodexUsageService
} from "../lifecycle-sidecar/runtime/service.ts";
import type { LifecycleSidecarDependencies } from "../lifecycle-sidecar/handler.ts";
import type { RuntimeAgentObserver } from "../lifecycle-sidecar/runtime/agents/types.ts";
import type { RuntimeAgentConfiguration } from "../lifecycle-sidecar/runtime/agents/types.ts";
import {
  MemoryPassportSharingStore,
  resourceSharingPolicy
} from "../lifecycle-sidecar/runtime/passport/sharing.ts";

test("Runtime owns Registry, Chatmail, peer heartbeat, AI sync, and Codex background scheduling", async () => {
  const clock = fakeClock();
  let account: TetiAccount | null = null;
  let registryCalls = 0;
  const peer = new FakePeerService();
  const codex = new FakeCodexUsageService();
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return account && clone(account); },
      async heartbeatDiscovery() {
        registryCalls += 1;
        if (!account) throw new Error("missing account");
        account.publicProfile = { ...account.publicProfile, lastSeen: "2026-07-21T10:00:00.000Z" };
        return clone(account);
      },
      async getPeerConnectionService() { return peer; },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: codex
    },
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  runtime.start();
  await drain();
  assert.equal(registryCalls, 0);
  assert.equal(peer.pollCalls, 0);
  assert.equal(codex.refreshCalls, 0);
  assert.deepEqual(clock.pending().map((entry) => entry.delayMs).sort((a, b) => a - b), [
    TETI_RUNTIME_INTERVALS.chatmailPollMs,
    TETI_RUNTIME_INTERVALS.registryHeartbeatMs,
    TETI_RUNTIME_INTERVALS.codexRefreshMs
  ].sort((a, b) => a - b));

  account = createAccount();
  runtime.notifyAccountAvailable(account);
  await drain();
  assert.equal(registryCalls, 1);
  assert.equal(peer.pollCalls, 1);
  assert.equal(codex.refreshCalls, 1);
  assert.equal((await runtime.readDiscoveryAccount()).publicProfile.lastSeen, "2026-07-21T10:00:00.000Z");

  const firstRead = await runtime.getPassportSnapshot();
  const secondRead = await runtime.getPassportSnapshot();
  assert.equal(peer.pollCalls, 1, "Passport reads must not receive Chatmail a second time");
  assert.equal(firstRead.connections[0]?.connectionState, "PendingApproval");
  assert.equal(secondRead.revision, firstRead.revision);

  await runtime.stop();
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(clock.pending().length, 0);
});

test("Agent discovery starts without an account but never enters Callable Passport", async () => {
  const gate = deferred<AgentObservationSnapshot>();
  const observer = new FakeAgentObserver(gate.promise);
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return null; },
      async heartbeatDiscovery() { throw new Error("missing account"); },
      async getPeerConnectionService() { return new FakePeerService(); },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: new FakeCodexUsageService(),
      agentObserver: observer
    }
  });

  runtime.start();
  await drain();
  assert.equal(observer.discoverCalls, 1);
  assert.deepEqual((await runtime.getPassportSnapshot()).localPassport.agents, []);

  observer.agents = [observedAgent()];
  gate.resolve(emptyAgentSnapshot("ready"));
  await drain();
  assert.deepEqual((await runtime.getPassportSnapshot()).localPassport.agents, []);
  await runtime.stop();
});

test("Agent management rescans after a local-only path override without starting account services", async () => {
  const observer = new FakeAgentObserver(Promise.resolve(emptyAgentSnapshot("ready")));
  const configuration = new FakeAgentConfiguration();
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return null; },
      async heartbeatDiscovery() { throw new Error("missing account"); },
      async getPeerConnectionService() { return new FakePeerService(); },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: new FakeCodexUsageService(),
      agentObserver: observer,
      agentConfiguration: configuration
    }
  });

  const updated = await runtime.setAgentPathOverride("codex", "/opt/homebrew/bin/codex");
  assert.equal(observer.discoverCalls, 1);
  assert.equal(updated.pathOverrides.codex, "/opt/homebrew/bin/codex");
  assert.equal(updated.state, "ready");
  assert.equal((await runtime.getPassportSnapshot()).identity, null);
  await runtime.stop();
});

test("Passport reads consume Runtime cache without duplicating network refreshes", async () => {
  const account = createAccount();
  let registryCalls = 0;
  const peer = new FakePeerService();
  const codex = new FakeCodexUsageService();
  const base = fakeLifecycleDependencies(account, peer, codex, () => { registryCalls += 1; });
  const runtime = new TetiRuntime({
    dependencies: {
      loadTetiAccount: base.loadTetiAccount,
      heartbeatDiscovery: base.heartbeatDiscovery,
      getPeerConnectionService: base.getPeerConnectionService,
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: codex
    }
  });
  const dependencies = createRuntimeOwnedLifecycleDependencies(base, runtime);

  runtime.start();
  await drain();
  assert.equal(registryCalls, 1);
  assert.equal(peer.pollCalls, 1);
  assert.equal(codex.refreshCalls, 1);

  const passport = await dependencies.getPassportSnapshot?.();
  assert.equal(passport?.localPassport.resources[0]?.product, "Codex");
  assert.equal(passport?.connections[0]?.connectionState, "PendingApproval");
  assert.equal(registryCalls, 1);
  assert.equal(peer.pollCalls, 1);
  assert.equal(codex.refreshCalls, 1);

  await runtime.stop();
});

test("account creation activates account-bound Runtime jobs without restarting the process", async () => {
  let account: TetiAccount | null = null;
  let registryCalls = 0;
  const peer = new FakePeerService();
  const codex = new FakeCodexUsageService();
  const base = fakeLifecycleDependencies(account, peer, codex, () => { registryCalls += 1; });
  base.loadTetiAccount = async () => account && clone(account);
  base.createTetiAccount = async () => {
    account = createAccount();
    return clone(account);
  };
  base.heartbeatDiscovery = async () => {
    registryCalls += 1;
    if (!account) throw new Error("missing account");
    return clone(account);
  };
  const runtime = new TetiRuntime({
    dependencies: {
      loadTetiAccount: base.loadTetiAccount,
      heartbeatDiscovery: base.heartbeatDiscovery,
      getPeerConnectionService: base.getPeerConnectionService,
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: codex
    }
  });
  const dependencies = createRuntimeOwnedLifecycleDependencies(base, runtime);

  runtime.start();
  await drain();
  assert.equal(registryCalls, 0);
  assert.equal(peer.pollCalls, 0);

  await dependencies.createTetiAccount({ name: "Milo" });
  await drain();
  assert.equal(registryCalls, 1);
  assert.equal(peer.pollCalls, 1);
  assert.equal(codex.refreshCalls, 1);
  await runtime.stop();
});

test("Passport reads and sharing writes cannot start peer RPC before an account exists", async () => {
  let peerFactoryCalls = 0;
  const sharing = new MemoryPassportSharingStore();
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return null; },
      async heartbeatDiscovery() { throw new Error("missing account"); },
      async getPeerConnectionService() {
        peerFactoryCalls += 1;
        return new FakePeerService();
      },
      passportSharingStore: sharing,
      codexUsageService: new FakeCodexUsageService()
    }
  });

  runtime.start();
  await drain();
  await runtime.getPassportSnapshot();
  await runtime.setPassportSharing(resourceSharingPolicy(true));
  await runtime.getPassportSnapshot();

  assert.equal(peerFactoryCalls, 0);
  assert.deepEqual(await sharing.load(), resourceSharingPolicy(true));
  await runtime.stop();
});

test("Registry failures stay distinct, enter Passport, and use the short retry schedule", async () => {
  const account = createAccount();
  const registryEvents: Array<{
    state: string;
    attempt: number;
    nextRetryMs?: number;
  }> = [];
  const clock = fakeClock();
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return clone(account); },
      async heartbeatDiscovery() {
        throw Object.assign(new Error("registry unavailable"), {
          registry: {
            state: "unreachable",
            checkedAt: "2026-07-21T10:00:00.000Z",
            errorCode: "REG_DNS",
            retryable: true
          }
        });
      },
      async getPeerConnectionService() { return new FakePeerService(); },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: new FakeCodexUsageService()
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    onRegistryStatusChange(input) {
      registryEvents.push({
        state: input.status.state,
        attempt: input.attempt,
        ...(input.nextRetryMs === undefined ? {} : { nextRetryMs: input.nextRetryMs })
      });
    }
  });

  runtime.start();
  await drain();

  const passport = await runtime.getPassportSnapshot();
  assert.equal(passport.registry.state, "unreachable");
  assert.equal(passport.registry.errorCode, "REG_DNS");
  assert.deepEqual(registryEvents, [{
    state: "unreachable",
    attempt: 1,
    nextRetryMs: 5_000
  }]);
  assert.equal(clock.pending().some((entry) => entry.delayMs === 5_000), true);
  await runtime.stop();
});

test("Runtime shutdown disposes Chatmail and returns at its deadline when a job never settles", async () => {
  const account = createAccount();
  let disposeCalls = 0;
  const peer = new FakePeerService();
  peer.pollResult = new Promise<PeerConnectionResult>(() => undefined);
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return clone(account); },
      async heartbeatDiscovery() { return clone(account); },
      async getPeerConnectionService() { return peer; },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: new FakeCodexUsageService(),
      async dispose() { disposeCalls += 1; }
    },
    shutdownTimeoutMs: 10
  });

  runtime.start();
  await drain();
  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  assert.equal(firstStop, secondStop);
  assert.deepEqual(await firstStop, { timedOut: true });
  assert.equal(disposeCalls, 1);
});

test("Runtime shutdown owns the local Callable Adapter Kernel without exposing remote execution", async () => {
  let kernelShutdownCalls = 0;
  const runtime = new TetiRuntime({
    dependencies: {
      async loadTetiAccount() { return null; },
      async heartbeatDiscovery() { throw new Error("missing account"); },
      async getPeerConnectionService() { return new FakePeerService(); },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: new FakeCodexUsageService(),
      callableAdapterKernel: {
        getCallableAgents() { return []; },
        async shutdown() { kernelShutdownCalls += 1; }
      }
    }
  });

  runtime.start();
  await drain();
  await runtime.stop();
  await runtime.stop();
  assert.equal(kernelShutdownCalls, 1);
});

class FakeCodexUsageService implements RuntimeCodexUsageService {
  refreshCalls = 0;
  private state: CodexUsageState = {
    status: "unavailable",
    error: { code: "NOT_STARTED", message: "not started", recoverable: true }
  };

  getCurrentState(): CodexUsageState {
    return clone(this.state);
  }

  async refreshNow(): Promise<CodexUsageState> {
    this.refreshCalls += 1;
    this.state = {
      status: "ready",
      snapshot: {
        source: "live",
        planTypeRaw: "plus",
        planDisplayName: null,
        membershipVerified: false,
        weekly: null,
        observedAt: "2026-07-21T10:00:00.000Z",
        fetchedAt: "2026-07-21T10:00:00.000Z",
        stale: false
      }
    };
    return this.getCurrentState();
  }
}

class FakeAgentObserver implements RuntimeAgentObserver {
  discoverCalls = 0;
  agents: AiAgent[] = [];
  private readonly result: Promise<AgentObservationSnapshot>;
  private snapshot = emptyAgentSnapshot("idle");

  constructor(result: Promise<AgentObservationSnapshot>) {
    this.result = result;
  }

  async discover(): Promise<AgentObservationSnapshot> {
    this.discoverCalls += 1;
    this.snapshot = { ...this.snapshot, state: "discovering" };
    this.snapshot = clone(await this.result);
    return clone(this.snapshot);
  }

  getCurrentSnapshot(): AgentObservationSnapshot {
    return clone(this.snapshot);
  }

  getPassportAgents(): AiAgent[] {
    return structuredClone(this.agents);
  }
}

class FakeAgentConfiguration implements RuntimeAgentConfiguration {
  private readonly overrides: Record<string, string> = {};

  async getPathOverrides(): Promise<Record<string, string>> {
    return clone(this.overrides);
  }

  async setPathOverride(agentId: string, path: string | null): Promise<void> {
    if (path) this.overrides[agentId] = path;
    else delete this.overrides[agentId];
  }
}

class FakePeerService implements PeerConnectionService {
  pollCalls = 0;
  pollResult?: Promise<PeerConnectionResult>;
  private sharing = resourceSharingPolicy(false);
  private readonly connection: PeerConnectionDto = {
    requestId: "req-1",
    state: "PendingApproval",
    direction: "incoming",
    remoteTetiId: "teti_remote001",
    remoteAddress: "remote001@mail.seep.im",
    createdAt: "2026-07-21T09:00:00.000Z",
    updatedAt: "2026-07-21T09:00:00.000Z"
  };

  async resolve(query: string) {
    return { id: `teti_${query}`, address: `${query}@mail.seep.im`, publicProfile: {} };
  }
  async request(): Promise<PeerConnectionResult> { return this.empty(); }
  async list(): Promise<PeerConnectionResult> { return this.empty(); }
  async poll(): Promise<PeerConnectionResult> {
    this.pollCalls += 1;
    if (this.pollResult) return this.pollResult;
    return {
      connections: [clone(this.connection)],
      receivedCount: 2,
      heartbeatCount: 1,
      aiStatusCount: 3
    };
  }
  async accept(): Promise<PeerConnectionResult> { return this.empty(); }
  async reject(): Promise<PeerConnectionResult> { return this.empty(); }
  async getPassportSharing() { return { ...this.sharing }; }
  async setPassportSharing(policy: ReturnType<typeof resourceSharingPolicy>) {
    this.sharing = { ...policy };
    return { ...policy };
  }

  private empty(): PeerConnectionResult {
    return { connections: [clone(this.connection)], receivedCount: 0, heartbeatCount: 0, aiStatusCount: 0 };
  }
}

function fakeLifecycleDependencies(
  account: TetiAccount | null,
  peer: PeerConnectionService,
  codex: RuntimeCodexUsageService,
  onHeartbeat: () => void
): LifecycleSidecarDependencies {
  return {
    async loadTetiAccount() { return account && clone(account); },
    async createTetiAccount() {
      if (!account) throw new Error("test account missing");
      return clone(account);
    },
    async getTetiStatus() {
      return {
        exists: Boolean(account),
        registry: { state: account ? "registered" : "unknown" },
        onlineStatus: "unknown"
      };
    },
    async registerDiscovery() {},
    async heartbeatDiscovery() {
      onHeartbeat();
      if (!account) throw new Error("test account missing");
      return clone(account);
    },
    async getPeerConnectionService() { return peer; }
  };
}

function createAccount(): TetiAccount {
  return {
    version: 1,
    id: "teti_local0001",
    address: "local0001@mail.seep.im",
    displayName: "Milo",
    chatmailAccountId: 7,
    publicKey: "public-key",
    publicProfile: { platform: "macOS", category: ["developer"], aiEnvironment: [] },
    createdAt: "2026-07-21T09:00:00.000Z"
  };
}

function fakeClock() {
  let nextHandle = 1;
  const entries: Array<{
    callback: () => void;
    delayMs: number;
    handle: number;
    cancelled: boolean;
    fired: boolean;
  }> = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const entry = { callback, delayMs, handle: nextHandle++, cancelled: false, fired: false };
      entries.push(entry);
      return entry.handle;
    },
    cancel(handle: unknown) {
      const entry = entries.find((candidate) => candidate.handle === handle);
      if (entry) entry.cancelled = true;
    },
    pending() {
      return entries.filter((entry) => !entry.cancelled && !entry.fired);
    }
  };
}

function observedAgent(): AiAgent {
  return {
    id: "codex",
    name: "Codex",
    type: "cli",
    installationStatus: "installed",
    runtimeStatus: "running",
    observedAt: "2026-07-25T00:00:00.000Z"
  };
}

function emptyAgentSnapshot(
  state: AgentObservationSnapshot["state"]
): AgentObservationSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    state,
    generatedAt: "2026-07-25T00:00:00.000Z",
    agents: [],
    errors: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
