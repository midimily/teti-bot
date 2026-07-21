import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
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
      codexUsageService: codex
    },
    schedule: clock.schedule,
    cancel: clock.cancel
  });

  runtime.start();
  await drain();
  assert.equal(registryCalls, 0);
  assert.equal(peer.pollCalls, 0);
  assert.equal(codex.refreshCalls, 1);
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
  assert.equal((await runtime.readDiscoveryAccount()).publicProfile.lastSeen, "2026-07-21T10:00:00.000Z");

  const compatibility = runtime.getPeerConnectionFacade();
  const firstRead = await compatibility.poll();
  const secondRead = await compatibility.poll();
  assert.equal(peer.pollCalls, 1, "compatibility polling must not receive Chatmail a second time");
  assert.equal(firstRead.receivedCount, 2);
  assert.equal(firstRead.heartbeatCount, 1);
  assert.equal(firstRead.aiStatusCount, 3);
  assert.equal(firstRead.connections[0]?.state, "PendingApproval");
  assert.deepEqual(
    { receivedCount: secondRead.receivedCount, heartbeatCount: secondRead.heartbeatCount, aiStatusCount: secondRead.aiStatusCount },
    { receivedCount: 0, heartbeatCount: 0, aiStatusCount: 0 }
  );

  await runtime.stop();
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(clock.pending().length, 0);
});

test("legacy lifecycle methods read Runtime state without duplicating network refreshes", async () => {
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
      codexUsageService: codex
    }
  });
  const dependencies = createRuntimeOwnedLifecycleDependencies(base, runtime);

  runtime.start();
  await drain();
  assert.equal(registryCalls, 1);
  assert.equal(peer.pollCalls, 1);
  assert.equal(codex.refreshCalls, 1);

  await dependencies.heartbeatDiscovery();
  await (await dependencies.getPeerConnectionService()).poll();
  await dependencies.refreshCodexUsage?.();
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

class FakePeerService implements PeerConnectionService {
  pollCalls = 0;
  pollResult?: Promise<PeerConnectionResult>;
  private sharing = false;
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
  async getStatusSharing() { return { statusSharing: this.sharing }; }
  async setStatusSharing(enabled: boolean) {
    this.sharing = enabled;
    return { statusSharing: enabled };
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
      return { exists: Boolean(account), registered: Boolean(account), onlineStatus: "unknown" };
    },
    async registerDiscovery() {},
    async heartbeatDiscovery() {
      onHeartbeat();
      if (!account) throw new Error("test account missing");
      return clone(account);
    },
    async getPeerConnectionService() { return peer; },
    getCodexUsageState: () => codex.getCurrentState(),
    refreshCodexUsage: () => codex.refreshNow()
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

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
