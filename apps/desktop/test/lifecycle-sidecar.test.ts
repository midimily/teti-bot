import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import {
  LIFECYCLE_MAX_LINE_BYTES,
  LIFECYCLE_PROTOCOL_VERSION,
  type LifecycleRequest
} from "../src/lifecycle-bridge/protocol.ts";
import {
  handleLifecycleLine,
  handleLifecycleRequest,
  type LifecycleSidecarDependencies
} from "../lifecycle-sidecar/handler.ts";
import { redactSecretLikeText } from "../lifecycle-sidecar/security.ts";
import type { RuntimePassportSnapshot } from "../../../core/passport/snapshot.ts";
import { resourceSharingPolicy } from "../lifecycle-sidecar/runtime/passport/sharing.ts";
import { emptyAgentManagementSnapshot } from "../../../core/observation/management.ts";
import type {
  CollaborationTaskTransportRecord,
  SendCollaborationTaskInput
} from "../../../core/task/transport.ts";

test("sidecar returns health response", async () => {
  const response = await handleLifecycleRequest(request("lifecycle.health"), fakeDependencies());

  assert.equal(response.ok, true);
  assert.equal(response.id, "r1");
  assert.equal(response.ok && response.result.status, "ok");
});

test("sidecar reports missing account without creating one", async () => {
  const deps = fakeDependencies();
  const response = await handleLifecycleRequest(request("account.status"), deps);

  assert.equal(response.ok, true);
  assert.deepEqual(response.ok && response.result, {
    exists: false,
    registry: { state: "unknown" },
    onlineStatus: "unknown"
  });
  assert.equal(deps.createCalls.length, 0);
});

test("sidecar loads public account DTO only", async () => {
  const account = createAccount("Milo") as TetiAccount & { privateKey?: string; password?: string };
  account.privateKey = "secret-private-key";
  account.password = "secret-password";
  const response = await handleLifecycleRequest(request("account.load"), fakeDependencies({ account }));

  assert.equal(response.ok, true);
  assert.equal(response.ok && response.result?.id, account.id);
  assert.equal(JSON.stringify(response), JSON.stringify(response).includes("secret") ? "leaked" : JSON.stringify(response));
});

test("sidecar creates account through injected authoritative lifecycle", async () => {
  const deps = fakeDependencies();
  const response = await handleLifecycleRequest(
    request("account.create", { name: "  Milo  " }),
    deps
  );

  assert.equal(response.ok, true);
  assert.deepEqual(deps.createCalls, ["Milo"]);
  assert.equal(response.ok && response.result?.displayName, "Milo");
});

test("sidecar rejects invalid methods and protocol versions", async () => {
  const unknown = await handleLifecycleRequest(
    { version: 1, id: "bad-method", method: "shell.exec", params: {} },
    fakeDependencies()
  );
  const wrongVersion = await handleLifecycleRequest(
    { version: 2, id: "bad-version", method: "lifecycle.health", params: {} },
    fakeDependencies()
  );

  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error.code, "UNKNOWN_METHOD");
  assert.equal(wrongVersion.ok, false);
  assert.equal(!wrongVersion.ok && wrongVersion.error.code, "UNSUPPORTED_PROTOCOL_VERSION");
});

test("sidecar rejects malformed and oversized requests", async () => {
  const malformed = await handleLifecycleLine("{not-json", fakeDependencies());
  const oversized = await handleLifecycleLine("x".repeat(LIFECYCLE_MAX_LINE_BYTES + 1), fakeDependencies());

  assert.equal(malformed.ok, false);
  assert.equal(!malformed.ok && malformed.error.code, "MALFORMED_REQUEST");
  assert.equal(oversized.ok, false);
  assert.equal(!oversized.ok && oversized.error.code, "OVERSIZED_REQUEST");
});

test("sidecar redacts secret-like errors", async () => {
  const deps = fakeDependencies();
  deps.createTetiAccount = async () => {
    throw new Error("failed password=abc token=def privateKey super-secret");
  };

  const response = await handleLifecycleRequest(request("account.create", { name: "Milo" }), deps);

  assert.equal(response.ok, false);
  assert.equal(JSON.stringify(response).includes("abc"), false);
  assert.equal(JSON.stringify(response).includes("def"), false);
  assert.equal(redactSecretLikeText("authorization:Bearer abc").includes("abc"), false);
});

test("sidecar discovery retry registers existing account without creating another one", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const response = await handleLifecycleRequest(request("discovery.retry"), deps);

  assert.equal(response.ok, true);
  assert.equal(deps.registerCalls.length, 1);
  assert.equal(deps.createCalls.length, 0);
});

test("sidecar discovery heartbeat refreshes the local public profile and registry activity", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const response = await handleLifecycleRequest(request("discovery.heartbeat"), deps);

  assert.equal(response.ok, true);
  assert.equal(deps.heartbeatCalls, 1);
  assert.equal(
    response.ok && response.result?.publicProfile.lastSeen,
    "2026-07-18T00:00:00.000Z"
  );
});

test("sidecar keeps discovery heartbeat failures distinct from registration failures", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  deps.heartbeatDiscovery = async () => {
    throw new Error("registry fetch timeout");
  };

  const response = await handleLifecycleRequest(request("discovery.heartbeat"), deps);

  assert.equal(response.ok, false);
  assert.equal(!response.ok && response.error.code, "DISCOVERY_HEARTBEAT_FAILED");
  assert.equal(!response.ok && response.error.retryTarget, "discovery.heartbeat");
});

test("sidecar keeps peer commands while rejecting the removed connection polling read", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const resolved = await handleLifecycleRequest(request("connection.resolve", { query: "076bm9evq" }), deps);
  const polled = await handleLifecycleRequest(
    { version: 1, id: "removed", method: "connection.poll", params: {} },
    deps
  );

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.result?.id, "teti_076bm9evq");
  assert.equal(polled.ok, false);
  assert.equal(!polled.ok && polled.error.code, "UNKNOWN_METHOD");
});

test("sidecar exposes one sanitized Runtime Passport snapshot", async () => {
  const deps = fakeDependencies();
  const current = await handleLifecycleRequest(request("passport.get"), deps);
  assert.equal(current.ok, true);
  assert.equal(current.ok && current.result.localPassport.resources[0]?.product, "Codex");
  assert.equal(JSON.stringify(current).includes("token"), false);
});

test("sidecar validates field-level Passport sharing and returns the updated snapshot", async () => {
  const deps = fakeDependencies();
  const enabled = await handleLifecycleRequest(request("passport.sharing.set", {
    policy: resourceSharingPolicy(true)
  }), deps);
  const invalid = await handleLifecycleRequest(request("passport.sharing.set", {
    policy: { ...resourceSharingPolicy(true), capabilities: false }
  }), deps);

  assert.deepEqual(enabled.ok && enabled.result.sharing, resourceSharingPolicy(true));
  assert.equal(invalid.ok, false);
  assert.equal(!invalid.ok && invalid.error.code, "INTERNAL_ERROR");
});

test("sidecar exposes bounded local Agent management commands only", async () => {
  const deps = fakeDependencies();
  let pathOverride: string | null = null;
  let scans = 0;
  deps.getAgentManagementSnapshot = async () => ({
    ...emptyAgentManagementSnapshot(),
    revision: 1,
    state: "ready"
  });
  deps.rescanAgents = async () => ({
    ...emptyAgentManagementSnapshot(),
    revision: ++scans,
    state: "ready"
  });
  deps.setAgentPathOverride = async (_agentId, path) => {
    pathOverride = path;
    return {
      ...emptyAgentManagementSnapshot(),
      revision: 1,
      state: "ready",
      pathOverrides: path ? { codex: path } : {}
    };
  };

  const current = await handleLifecycleRequest(request("agent.observation.get"), deps);
  const rescanned = await handleLifecycleRequest(request("agent.observation.scan"), deps);
  const updated = await handleLifecycleRequest(request("agent.observation.override.set", {
    agentId: "codex",
    path: "/opt/homebrew/bin/codex"
  }), deps);
  const malformed = await handleLifecycleRequest(request("agent.observation.override.set", {
    agentId: "../../shell",
    path: "/tmp/shell"
  }), deps);

  assert.equal(current.ok && current.result.state, "ready");
  assert.equal(rescanned.ok && rescanned.result.revision, 1);
  assert.equal(pathOverride, "/opt/homebrew/bin/codex");
  assert.equal(updated.ok && updated.result.pathOverrides.codex, "/opt/homebrew/bin/codex");
  assert.equal(malformed.ok, false);
});

test("sidecar keeps Task send/list bounded and rejects remote execution fields", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const sent = await handleLifecycleRequest(request("task.send", {
    connectionRequestId: "connection-001",
    taskId: "task-001",
    capabilityId: "code-analysis",
    text: "Review this explicit text.",
    ttlMs: 60_000
  }), deps);
  const listed = await handleLifecycleRequest(request("task.list", { limit: 1 }), deps);
  const unsafe = await handleLifecycleRequest(request("task.send", {
    connectionRequestId: "connection-001",
    taskId: "task-002",
    capabilityId: "code-analysis",
    text: "Review this.",
    command: "unsafe"
  }), deps);

  assert.equal(sent.ok, true);
  assert.equal(sent.ok && "request" in sent.result && sent.result.request.taskId, "task-001");
  assert.equal(listed.ok, true);
  assert.equal(listed.ok && "records" in listed.result && listed.result.records.length, 1);
  assert.equal(unsafe.ok, false);
  assert.equal(!unsafe.ok && unsafe.error.code, "TASK_TRANSPORT_FAILED");
  assert.equal(LIFECYCLE_PROTOCOL_VERSION, 1, "Task transport does not create a second lifecycle protocol");
});

function request(method: LifecycleRequest["method"], params: Record<string, unknown> = {}): LifecycleRequest {
  return {
    version: LIFECYCLE_PROTOCOL_VERSION,
    id: "r1",
    method,
    params
  };
}

function fakeDependencies(options: { account?: TetiAccount | null } = {}): LifecycleSidecarDependencies & {
  createCalls: string[];
  registerCalls: TetiAccount[];
  heartbeatCalls: number;
} {
  const createCalls: string[] = [];
  const registerCalls: TetiAccount[] = [];
  let account = options.account ?? null;
  let passport = createPassportSnapshot();
  const tasks: CollaborationTaskTransportRecord[] = [];

  const dependencies: LifecycleSidecarDependencies & {
    createCalls: string[];
    registerCalls: TetiAccount[];
    heartbeatCalls: number;
  } = {
    createCalls,
    registerCalls,
    heartbeatCalls: 0,
    async loadTetiAccount() {
      return account ? clone(account) : null;
    },
    async createTetiAccount(input: { name: string }) {
      createCalls.push(input.name);
      account = createAccount(input.name);
      return clone(account);
    },
    async getTetiStatus(): Promise<TetiStatus> {
      return {
        exists: account !== null,
        registry: {
          state: account === null
            ? "unknown"
            : registerCalls.length > 0
              ? "registered"
              : "not_registered"
        },
        onlineStatus: "unknown"
      };
    },
    async registerDiscovery(existing: TetiAccount) {
      registerCalls.push(clone(existing));
    },
    async heartbeatDiscovery() {
      if (!account) throw new Error("A local Teti account is required.");
      account.publicProfile = {
        ...account.publicProfile,
        lastSeen: "2026-07-18T00:00:00.000Z"
      };
      dependencies.heartbeatCalls += 1;
      return clone(account);
    },
    async getPassportSnapshot() {
      return clone(passport);
    },
    async setPassportSharing(policy) {
      passport = { ...passport, revision: passport.revision + 1, sharing: clone(policy) };
      return clone(passport);
    },
    async getPeerConnectionService() {
      const empty = { connections: [], receivedCount: 0, heartbeatCount: 0 } as const;
      return {
        async resolve(query: string) {
          return {
            id: `teti_${query}`,
            address: `${query}@mail.seep.im`,
            publicKey: "remote-public-key",
            publicProfile: {}
          };
        },
        async request() { return empty; },
        async list() { return empty; },
        async poll() { return empty; },
        async accept() { return empty; },
        async reject() { return empty; },
        async getPassportSharing() { return clone(passport.sharing); },
        async setPassportSharing(policy) {
          passport.sharing = clone(policy);
          return clone(policy);
        },
        async sendTask(input: SendCollaborationTaskInput) {
          const now = "2026-07-26T00:00:00.000Z";
          const record: CollaborationTaskTransportRecord = {
            schemaVersion: 1,
            direction: "outgoing",
            peerTetiId: "teti_peer00001",
            protocolVersion: 1,
            envelopeMessageId: "task-envelope-001",
            request: {
              schemaVersion: 1,
              taskId: input.taskId ?? "generated-task",
              requesterTetiId: "teti_milo00000",
              targetTetiId: "teti_peer00001",
              offerId: input.offerId ?? `capability:${input.capabilityId}`,
              capabilityId: input.capabilityId,
              input: { kind: "text", text: input.text },
              createdAt: now,
              expiresAt: "2026-07-26T01:00:00.000Z"
            },
            state: "submitted",
            approval: "pending",
            delivery: "sent",
            createdAt: now,
            updatedAt: now
          };
          tasks.push(record);
          return clone(record);
        },
        async listTasks() {
          return {
            schemaVersion: 1 as const,
            generatedAt: "2026-07-26T00:00:00.000Z",
            records: clone(tasks),
            peers: []
          };
        }
      };
    }
  };
  return dependencies;
}

function createPassportSnapshot(): RuntimePassportSnapshot {
  const generatedAt = "2026-07-22T00:00:00.000Z";
  return {
    schemaVersion: 2,
    revision: 1,
    generatedAt,
    identity: null,
    registry: { state: "unknown" },
    localPassport: {
      schemaVersion: 2,
      generatedAt,
      resources: [{
        id: "openai.codex",
        provider: "OpenAI",
        product: "Codex",
        kind: "subscription",
        availability: "available",
        plan: { key: "plus", displayName: "Plus" },
        quotas: [],
        assurance: "provider_observed",
        observedAt: generatedAt
      }],
      agents: [],
      capabilities: [],
      bindings: []
    },
    connections: [],
    sharing: resourceSharingPolicy(false)
  };
}

function createAccount(displayName: string): TetiAccount {
  const publicIdCode = "milo00000";
  return {
    version: 1,
    id: `teti_${publicIdCode}`,
    address: `${publicIdCode}@mail.seep.im`,
    displayName,
    chatmailAccountId: 7,
    publicKey: "public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Teti Desktop Lifecycle Bridge Alpha"]
    },
    createdAt: new Date().toISOString()
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
