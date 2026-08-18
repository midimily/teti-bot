import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimePassportSnapshot } from "../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../core/passport/types.ts";
import {
  emptyAgentManagementSnapshot,
  type AgentManagementSnapshot
} from "../../../core/observation/management.ts";
import {
  PassportController,
  emptyPassportSnapshot,
  type PassportClient
} from "../src/passport/controller.ts";

test("one Passport controller reads the Runtime snapshot every three seconds", async () => {
  const client = new FakePassportClient();
  let scheduled: (() => void) | undefined;
  let delay = 0;
  const controller = new PassportController({
    client,
    onChange: () => undefined,
    schedule(callback, delayMs) {
      scheduled = callback;
      delay = delayMs;
      return 1;
    },
    cancel: () => undefined
  });

  controller.start();
  await flushPromises();
  assert.equal(client.getCalls, 1);
  assert.equal(delay, 3_000);
  scheduled?.();
  await flushPromises();
  assert.equal(client.getCalls, 2);
  controller.stop();
});

test("timestamp-only Passport polling does not rebuild an expanded peer detail UI", async () => {
  const client = new FakePassportClient();
  let changes = 0;
  let scheduled: (() => void) | undefined;
  const controller = new PassportController({
    client,
    initialSnapshot: structuredClone(client.snapshot),
    onChange: () => { changes += 1; },
    schedule(callback) {
      scheduled = callback;
      return 1;
    },
    cancel: () => undefined
  });
  controller.start();
  await flushPromises();
  assert.equal(changes, 0);

  client.snapshot.generatedAt = "2026-07-22T00:00:03.000Z";
  client.snapshot.revision += 1;
  scheduled?.();
  await flushPromises();
  assert.equal(changes, 0, "generatedAt/revision churn must not replace the Passport DOM");

  client.snapshot.sharing = { ...policy(true), capabilities: true };
  await controller.refreshNow();
  assert.equal(changes, 1, "a visible semantic change still refreshes the UI");
  controller.stop();
});

test("peer Passport refresh survives unavailable local Agent and Osaurus settings", async () => {
  const client = new FakePassportClient();
  client.failAgentRead = true;
  client.failOsaurusRead = true;
  client.snapshot.connections = [{
    requestId: "remote-passport",
    connectionState: "Confirmed",
    direction: "incoming",
    identity: {
      tetiId: "teti_remote001",
      address: "remote001@mail.seep.im",
      displayName: "Remote"
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z",
    lastSeen: "2026-07-22T00:00:01.000Z",
    compatibility: "compatible",
    passport: {
      state: "fresh",
      resources: [],
      agents: [],
      capabilities: [],
      bindings: []
    }
  }];
  let changes = 0;
  const controller = new PassportController({
    client,
    onChange: () => { changes += 1; }
  });

  controller.start();
  await flushPromises();

  assert.equal(controller.snapshot.passport.connections.length, 1);
  assert.equal(controller.snapshot.passport.connections[0]?.passport.state, "fresh");
  assert.equal(changes, 1, "valid remote Passport data must reach the UI independently");
  controller.stop();
});

test("Passport sharing updates optimistically and rolls back on persistence failure", async () => {
  const client = new FakePassportClient();
  const controller = new PassportController({ client, onChange: () => undefined });

  await controller.setResourceSharing(true);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, true);
  assert.equal(controller.snapshot.passport.sharing.resourceQuota, true);
  assert.equal(controller.snapshot.passport.sharing.agents, true);
  assert.equal(controller.snapshot.passport.sharing.capabilities, true);

  client.failSet = true;
  await controller.setResourceSharing(false);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, true);
  assert.equal(controller.snapshot.sharingErrorCode, "sharing_save_failed");
});

test("rapid Passport sharing changes remain interactive and persist the latest intent", async () => {
  let finishFirst!: (snapshot: RuntimePassportSnapshot) => void;
  const client = new FakePassportClient();
  const calls: boolean[] = [];
  client.setSharing = (policy) => {
    calls.push(policy.resourceSummary);
    if (calls.length === 1) {
      return new Promise((resolve) => { finishFirst = resolve; });
    }
    client.snapshot.sharing = { ...policy };
    return Promise.resolve(structuredClone(client.snapshot));
  };
  const controller = new PassportController({ client, onChange: () => undefined });

  const first = controller.setResourceSharing(true);
  const latest = controller.setResourceSharing(false);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, false);
  assert.equal(controller.snapshot.sharingBusy, true);

  const firstSnapshot = structuredClone(client.snapshot);
  firstSnapshot.sharing = policy(true);
  finishFirst(firstSnapshot);
  await Promise.all([first, latest]);

  assert.deepEqual(calls, [true, false]);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, false);
  assert.equal(controller.snapshot.sharingBusy, false);
});

test("Passport controller owns toolbar panel state independently of data refresh", () => {
  const controller = new PassportController({
    client: new FakePassportClient(),
    onChange: () => undefined
  });
  controller.togglePanel("passport");
  assert.equal(controller.snapshot.openPanel, "passport");
  controller.togglePanel("sharing");
  assert.equal(controller.snapshot.openPanel, "sharing");
  controller.closePanel();
  assert.equal(controller.snapshot.openPanel, null);
});

test("Agent management supports explicit rescan and local path override", async () => {
  const client = new FakePassportClient();
  const controller = new PassportController({ client, onChange: () => undefined });

  await controller.rescanAgents();
  assert.equal(controller.snapshot.agentManagement.state, "ready");
  await controller.setAgentPathOverride("codex", " /opt/homebrew/bin/codex ");
  assert.equal(
    controller.snapshot.agentManagement.pathOverrides.codex,
    "/opt/homebrew/bin/codex"
  );
  await controller.setAgentPathOverride("codex", "");
  assert.equal(controller.snapshot.agentManagement.pathOverrides.codex, undefined);
});

test("Settings exposes an explicit restart-bound local Network opt-in", async () => {
  const client = new FakePassportClient();
  client.provideNetworkSettings = true;
  const controller = new PassportController({ client, onChange: () => undefined });
  controller.start();
  await flushPromises();

  assert.equal(controller.snapshot.networkEnvironment?.useLocalDevelopmentNetwork, false);
  assert.equal(controller.snapshot.networkContract?.state, "compatible");
  assert.equal(controller.snapshot.presence?.state, "online");
  await controller.setLocalDevelopmentNetwork(true);
  assert.equal(controller.snapshot.networkEnvironment?.configuredBaseUrl, "http://127.0.0.1:8788");
  assert.equal(controller.snapshot.networkEnvironment?.activeBaseUrl, "https://network.teti.bot");
  assert.equal(controller.snapshot.networkEnvironment?.restartRequired, true);
  controller.stop();
});

test("Settings local logout stops polling and reports a local cleanup failure", async () => {
  const client = new FakePassportClient();
  client.failLogout = true;
  const controller = new PassportController({ client, onChange: () => undefined });
  controller.start();
  await flushPromises();

  controller.requestLocalProfileLogout();
  await controller.confirmLocalProfileLogout();

  assert.equal(client.logoutCalls, 1);
  assert.equal(controller.snapshot.localLogoutBusy, false);
  assert.equal(controller.snapshot.localLogoutErrorCode, "local_profile_logout_failed");
  controller.stop();
});

test("Settings local logout remains busy while native cleanup restarts the App", async () => {
  const client = new FakePassportClient();
  const controller = new PassportController({ client, onChange: () => undefined });

  controller.requestLocalProfileLogout();
  void controller.confirmLocalProfileLogout();
  await flushPromises();

  assert.equal(client.logoutCalls, 1);
  assert.equal(controller.snapshot.localLogoutBusy, true);
});

test("Settings local logout requires an explicit in-panel second confirmation", async () => {
  const client = new FakePassportClient();
  const controller = new PassportController({ client, onChange: () => undefined });

  await controller.confirmLocalProfileLogout();
  assert.equal(client.logoutCalls, 0, "cleanup cannot start without the first intent click");

  controller.requestLocalProfileLogout();
  assert.equal(controller.snapshot.localLogoutConfirmationRequired, true);
  assert.equal(client.logoutCalls, 0);

  controller.cancelLocalProfileLogout();
  assert.equal(controller.snapshot.localLogoutConfirmationRequired, false);
  assert.equal(client.logoutCalls, 0);

  controller.requestLocalProfileLogout();
  void controller.confirmLocalProfileLogout();
  await flushPromises();
  assert.equal(controller.snapshot.localLogoutConfirmationRequired, false);
  assert.equal(controller.snapshot.localLogoutBusy, true);
  assert.equal(client.logoutCalls, 1);
});

class FakePassportClient implements PassportClient {
  getCalls = 0;
  failSet = false;
  failAgentRead = false;
  failOsaurusRead = false;
  provideNetworkSettings = false;
  failLogout = false;
  logoutCalls = 0;
  snapshot = emptyPassportSnapshot(new Date("2026-07-22T00:00:00.000Z"));
  agents = emptyAgentManagementSnapshot(new Date("2026-07-22T00:00:00.000Z"));
  networkEnvironment = {
    schemaVersion: 1 as const,
    useLocalDevelopmentNetwork: false,
    activeEnvironment: "production" as const,
    activeBaseUrl: "https://network.teti.bot",
    configuredEnvironment: "production" as "production" | "local_development",
    configuredBaseUrl: "https://network.teti.bot",
    restartRequired: false
  };

  async getSnapshot(): Promise<RuntimePassportSnapshot> {
    this.getCalls += 1;
    return structuredClone(this.snapshot);
  }

  async setSharing(policyValue: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    if (this.failSet) throw new Error("disk unavailable");
    this.snapshot.sharing = { ...policyValue };
    this.snapshot.revision += 1;
    return structuredClone(this.snapshot);
  }

  async getAgentManagement(): Promise<AgentManagementSnapshot> {
    if (this.failAgentRead) throw new Error("agent observation unavailable");
    return structuredClone(this.agents);
  }

  async getOsaurusNativeChildSettings() {
    if (this.failOsaurusRead) throw new Error("Osaurus settings unavailable");
    return { schemaVersion: 1 as const, agentId: null, readiness: "unconfigured" as const };
  }

  async getNetworkEnvironmentSettings() {
    if (!this.provideNetworkSettings) throw new Error("Network settings unavailable");
    return structuredClone(this.networkEnvironment);
  }

  async getNetworkContractStatus() {
    if (!this.provideNetworkSettings) throw new Error("Network contract unavailable");
    return {
      state: "compatible" as const,
      checkedAt: "2026-08-13T09:30:00.000Z",
      protocolVersion: 1,
      contractRevision: 8,
      serviceVersion: "0.1.8"
    };
  }

  async setLocalDevelopmentNetwork(enabled: boolean) {
    this.networkEnvironment = {
      ...this.networkEnvironment,
      useLocalDevelopmentNetwork: enabled,
      configuredEnvironment: enabled ? "local_development" : "production",
      configuredBaseUrl: enabled ? "http://127.0.0.1:8788" : "https://network.teti.bot",
      restartRequired: enabled
    };
    return structuredClone(this.networkEnvironment);
  }

  async getPresenceStatus() {
    if (!this.provideNetworkSettings) throw new Error("Presence unavailable");
    return {
      schemaVersion: 1 as const,
      state: "online" as const,
      mode: "online" as const,
      sessionId: "ps_AAAAAAAAAAAAAAAAAAAAAA",
      sequence: 1,
      foreground: true,
      panelVisible: false,
      collaborationActive: false
    };
  }

  async logoutLocalProfile(): Promise<never> {
    this.logoutCalls += 1;
    if (this.failLogout) throw new Error("profile busy");
    return new Promise<never>(() => undefined);
  }

  async rescanAgents(): Promise<AgentManagementSnapshot> {
    this.agents.revision += 1;
    this.agents.state = "ready";
    return structuredClone(this.agents);
  }

  async setAgentPathOverride(agentId: string, path: string | null): Promise<AgentManagementSnapshot> {
    if (path) this.agents.pathOverrides[agentId] = path;
    else delete this.agents.pathOverrides[agentId];
    return structuredClone(this.agents);
  }
}

function policy(enabled: boolean): PassportSharingPolicy {
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: enabled,
    resourceQuota: enabled,
    agents: enabled,
    capabilities: false
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
