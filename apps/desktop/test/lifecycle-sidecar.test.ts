import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import {
  LIFECYCLE_MAX_LINE_BYTES,
  LIFECYCLE_METHODS,
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
import type { ExecutionHandle } from "../../../core/callability/execution.ts";
import { emptyChildMemorySnapshot } from "../../../core/memory/types.ts";

test("sidecar returns health response", async () => {
  const response = await handleLifecycleRequest(request("lifecycle.health"), fakeDependencies());

  assert.equal(response.ok, true);
  assert.equal(response.id, "r1");
  assert.equal(response.ok && response.result.status, "ok");
});

test("the native Tauri bridge allows every lifecycle protocol method", async () => {
  const source = await readFile(
    new URL("../src-tauri/src/lifecycle_bridge.rs", import.meta.url),
    "utf8"
  );
  const allowlist = source.slice(
    source.indexOf("fn is_allowed_method"),
    source.indexOf("fn failure", source.indexOf("fn is_allowed_method"))
  );
  assert.ok(allowlist.length > 0, "Rust lifecycle allowlist must remain inspectable");
  for (const method of LIFECYCLE_METHODS) {
    assert.match(allowlist, new RegExp(`"${method.replaceAll(".", "\\.")}"`));
  }
});

test("Osaurus Native settings get and set requests reach their sidecar dependencies", async () => {
  const deps = fakeDependencies();
  let savedAgentId: string | null | undefined;
  deps.getOsaurusNativeChildSettings = async () => ({
    schemaVersion: 1,
    agentId: null,
    readiness: "unconfigured"
  });
  deps.setOsaurusNativeChildAgentId = async (agentId) => {
    savedAgentId = agentId;
    return {
      schemaVersion: 1,
      agentId,
      readiness: agentId ? "checking" : "unconfigured"
    };
  };

  const current = await handleLifecycleRequest(request("osaurus.native.get"), deps);
  const updated = await handleLifecycleRequest(request("osaurus.native.set", {
    agentId: "123E4567-E89B-42D3-A456-426614174000"
  }), deps);

  assert.equal(current.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(savedAgentId, "123E4567-E89B-42D3-A456-426614174000");
});

test("local Release Policy locks obsolete builds without using peer compatibility", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  deps.getLocalReleaseStatus = async () => ({
    schemaVersion: 1,
    state: "update_required",
    currentVersion: "0.2.8",
    buildTimestamp: "2026-08-02T09:00:00.000Z",
    source: "cache",
    minimumSupportedVersion: "0.2.9",
    policyVersion: 2,
    effectiveAt: "2026-08-02T00:00:00.000Z"
  });

  const status = await handleLifecycleRequest(request("release.status"), deps);
  const account = await handleLifecycleRequest(request("account.load"), deps);
  const blocked = await handleLifecycleRequest(request("passport.get"), deps);

  assert.equal(status.ok && status.result.state, "update_required");
  assert.equal(account.ok, true, "read-only identity remains available to render the upgrade screen");
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.error.code, "APP_UPDATE_REQUIRED");
  assert.equal(!blocked.ok && blocked.error.diagnosticCode, "RELEASE-UPDATE-REQUIRED");
});

test("unknown or unavailable Release Policy never creates a false global lock", async () => {
  const deps = fakeDependencies();
  deps.getLocalReleaseStatus = async () => ({
    schemaVersion: 1,
    state: "temporarily_unavailable",
    currentVersion: "0.2.8",
    buildTimestamp: "2026-08-02T09:00:00.000Z",
    source: "none",
    diagnosticCode: "RELEASE_POLICY_UNAVAILABLE"
  });

  assert.equal((await handleLifecycleRequest(request("passport.get"), deps)).ok, true);
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
    executionMode: "long_horizon",
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
  const unsafeWorkspace = await handleLifecycleRequest(request("task.send", {
    connectionRequestId: "connection-001",
    taskId: "task-003",
    capabilityId: "code-analysis",
    text: "Review this.",
    workspace: {
      kind: "reference",
      workspaceId: "workspace-001",
      workspaceRevision: 1,
      access: ["read"],
      path: "/Users/receiver/private"
    }
  }), deps);

  assert.equal(sent.ok, true);
  assert.equal(sent.ok && "request" in sent.result && sent.result.request.executionMode, "long_horizon");
  assert.equal(sent.ok && "request" in sent.result && sent.result.request.taskId, "task-001");
  assert.equal(listed.ok, true);
  assert.equal(listed.ok && "records" in listed.result && listed.result.records.length, 1);
  assert.equal(unsafe.ok, false);
  assert.equal(!unsafe.ok && unsafe.error.code, "TASK_TRANSPORT_FAILED");
  assert.equal(unsafeWorkspace.ok, false);
  assert.equal(!unsafeWorkspace.ok && unsafeWorkspace.error.code, "TASK_TRANSPORT_FAILED");
  assert.equal(LIFECYCLE_PROTOCOL_VERSION, 1, "Task transport does not create a second lifecycle protocol");
});

test("sidecar accepts only local explicit Delegation selections and rejects injected transport fields", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const service = await deps.getPeerConnectionService();
  const target = {
    childAgentId: "osaurus-runtime",
    connectorId: "osaurus.runtime",
    capabilityId: "general-text-assistance",
    resourceBindingId: "binding:osaurus.runtime",
    workspacePolicy: "none" as const,
    inputModes: ["text"] as Array<"text" | "image">,
    outputModes: ["text"] as Array<"text" | "image">,
    timeoutMs: 60_000,
    maxOutputBytes: 24 * 1_024
  };
  let approved: unknown;
  deps.getPeerConnectionService = async () => ({
    ...service,
    async listTaskDelegationTargets() { return [clone(target)]; },
    async approveTaskDelegation(_taskId: string, selections: unknown) {
      approved = clone(selections);
      return taskRecord("task-delegation-001", "working");
    }
  });

  const listed = await handleLifecycleRequest(request("task.delegation.targets", {
    taskId: "task-delegation-001"
  }), deps);
  const accepted = await handleLifecycleRequest(request("task.delegation.approve", {
    taskId: "task-delegation-001",
    selections: [{
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      capabilityId: target.capabilityId
    }]
  }), deps);
  const injected = await handleLifecycleRequest(request("task.delegation.approve", {
    taskId: "task-delegation-001",
    selections: [{
      childAgentId: target.childAgentId,
      connectorId: target.connectorId,
      capabilityId: target.capabilityId,
      endpoint: "http://remote.example/agent"
    }]
  }), deps);

  assert.equal(listed.ok, true);
  assert.equal(listed.ok && Array.isArray(listed.result) && listed.result.length, 1);
  assert.equal(accepted.ok, true);
  assert.deepEqual(approved, [{
    childAgentId: target.childAgentId,
    connectorId: target.connectorId,
    capabilityId: target.capabilityId
  }]);
  assert.equal(injected.ok, false);
  assert.equal(!injected.ok && injected.error.code, "TASK_TRANSPORT_FAILED");
});

test("sidecar exposes durable execution query and explicit resume only through local lifecycle methods", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  const service = await deps.getPeerConnectionService();
  let resumedTaskId = "";
  const handle: ExecutionHandle = {
    schemaVersion: 1,
    taskId: "task-durable-001",
    workspaceId: "workspace:task-durable-001",
    childAgentId: "test-child",
    connectorId: "test.connector",
    executionEpoch: 2,
    providerExecutionId: "pid:1234",
    leaseExpiresAt: "2026-07-26T00:01:00.000Z",
    progress: {
      state: "interrupted",
      completedUnits: null,
      totalUnits: null,
      message: "执行已中断，可从显式检查点重新开始",
      updatedAt: "2026-07-26T00:00:00.000Z"
    },
    checkpointRef: "/receiver-private/checkpoints/task-durable-001/state.json",
    resumeCapability: "checkpoint_restart"
  };
  const resumedRecord = taskRecord("task-durable-001", "working");
  deps.getPeerConnectionService = async () => ({
    ...service,
    async getTaskExecution(taskId: string) {
      return taskId === handle.taskId ? clone(handle) : null;
    },
    async resumeTask(taskId: string) {
      resumedTaskId = taskId;
      return clone(resumedRecord);
    }
  });

  const queried = await handleLifecycleRequest(request("task.execution.get", {
    taskId: handle.taskId
  }), deps);
  const resumed = await handleLifecycleRequest(request("task.execution.resume", {
    taskId: handle.taskId
  }), deps);
  const invalid = await handleLifecycleRequest(request("task.execution.get", {
    taskId: "../../private"
  }), deps);

  assert.equal(queried.ok && "executionEpoch" in queried.result && queried.result.executionEpoch, 2);
  assert.equal(resumed.ok && "request" in resumed.result && resumed.result.state, "working");
  assert.equal(resumedTaskId, handle.taskId);
  assert.equal(invalid.ok, false);
});

test("sidecar exposes Child Memory only through validated local explicit-authority methods", async () => {
  const deps = fakeDependencies({ account: createAccount("Milo") });
  let authorization: unknown;
  let saveConfirmation: unknown;
  deps.getChildMemory = async () => emptyChildMemorySnapshot(new Date("2026-07-29T00:00:00.000Z"));
  deps.setChildMemoryAuthorization = async (input) => {
    authorization = clone(input);
    return emptyChildMemorySnapshot(new Date("2026-07-29T00:00:00.000Z"));
  };
  deps.saveTaskMemory = async (_taskId, _scope, confirmed) => {
    saveConfirmation = confirmed;
    throw new Error("test stop after validation");
  };

  const listed = await handleLifecycleRequest(request("memory.get"), deps);
  const authorized = await handleLifecycleRequest(request("memory.authorization.set", {
    scope: "workspace",
    workspaceId: "workspace-safe",
    childAgentId: "codex",
    enabled: true
  }), deps);
  const remoteLikeSave = await handleLifecycleRequest(request("memory.task.save", {
    taskId: "task-safe",
    scope: "child_agent",
    confirmed: false
  }), deps);
  const invalidWorkspace = await handleLifecycleRequest(request("memory.authorization.set", {
    scope: "workspace",
    workspaceId: "/Users/private",
    childAgentId: "codex",
    enabled: true
  }), deps);

  assert.equal(listed.ok, true);
  assert.equal(authorized.ok, true);
  assert.deepEqual(authorization, {
    scope: "workspace",
    workspaceId: "workspace-safe",
    childAgentId: "codex",
    enabled: true
  });
  assert.equal(remoteLikeSave.ok, false);
  assert.equal(saveConfirmation, undefined, "confirmation must be rejected before the Memory service is called");
  assert.equal(invalidWorkspace.ok, false);
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
              executionMode: input.executionMode ?? "single_stage",
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

function taskRecord(
  taskId: string,
  state: CollaborationTaskTransportRecord["state"]
): CollaborationTaskTransportRecord {
  const now = "2026-07-26T00:00:00.000Z";
  return {
    schemaVersion: 1,
    direction: "incoming",
    peerTetiId: "teti_peer00001",
    protocolVersion: 5,
    envelopeMessageId: "task-envelope-durable-001",
    request: {
      schemaVersion: 5,
      taskId,
      requesterTetiId: "teti_peer00001",
      targetTetiId: "teti_milo00000",
      offerId: "capability:code-analysis",
      capabilityId: "code-analysis",
      input: { kind: "text", text: "Continue from the explicit checkpoint." },
      workspace: {
        kind: "temporary",
        access: ["read", "write", "create_artifact"]
      },
      createdAt: now,
      expiresAt: "2026-07-26T01:00:00.000Z"
    },
    state,
    approval: "approved",
    delivery: "delivered",
    attachmentsReady: true,
    createdAt: now,
    updatedAt: now
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
