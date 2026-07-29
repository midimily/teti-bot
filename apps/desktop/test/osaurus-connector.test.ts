import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  issueExecutionAuthority,
  type ExecutionExit,
  type ExecutionTransportHandle,
  type ExecutionSpec,
  type ExecutionTransport
} from "../../../core/callability/agent-core.ts";
import type { CallableAdapterTaskRequest } from "../../../core/callability/adapter.ts";
import { projectCallablePassport } from "../../../core/passport/callable-projection.ts";
import {
  OSAURUS_RUNTIME_CHILD,
  qualifyOsaurusConnector,
  type OsaurusRuntimeTrustVerifier
} from "../../../integrations/agents/osaurus/connector.ts";
import type { OsaurusRuntimeIdentity } from "../../../integrations/agents/osaurus/runtime-identity.ts";
import {
  TetiHostAgentError,
  TetiHostAgentKernel
} from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const IDENTITY: OsaurusRuntimeIdentity = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  endpoint: "http://127.0.0.1:1337/v1/chat/completions",
  listenerPid: 4242,
  appPath: "/Applications/Osaurus.app",
  executablePath: "/Applications/Osaurus.app/Contents/MacOS/osaurus",
  bundleIdentifier: "com.dinoki.osaurus",
  teamIdentifier: "4W8QF9VR2F",
  codeDirectoryHash: "a".repeat(40),
  codeIdentityHash: `sha256:${"b".repeat(64)}`,
  appVersion: "0.22.2",
  observedAt: "2026-07-29T04:00:00.000Z"
};

test("current official Insights retention blocks callable Osaurus registration", async () => {
  const qualification = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier(),
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    now: () => new Date("2026-07-29T04:00:00.000Z")
  });

  assert.equal(qualification.connector, null);
  assert.equal(qualification.readiness.state, "degraded");
  assert.equal(qualification.readiness.reasonCode, "OSAURUS_INSIGHTS_BODY_RETENTION");
  assert.deepEqual(qualification.releaseBlockers, ["OSAURUS_INSIGHTS_BODY_RETENTION"]);
});

test("a running claim with failed process identity is reported as untrusted, not offline", async () => {
  const verifier = trustVerifier();
  verifier.discoverRuntime = async () => ({ state: "untrusted", identity: null });
  const qualification = await qualifyOsaurusConnector({ trustVerifier: verifier });
  assert.equal(qualification.connector, null);
  assert.equal(qualification.readiness.state, "degraded");
  assert.equal(qualification.readiness.reasonCode, "OSAURUS_RUNTIME_UNTRUSTED");
});

test("a verifiable no-retention Runtime qualifies only the fixed local Bonsai model", async () => {
  const qualified = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier(),
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    inspectInsightsRetention: async () => "disabled"
  });
  assert.ok(qualified.connector);
  assert.equal(qualified.readiness.state, "ready");
  assert.equal(qualified.connector.descriptor.origin, "runtime_facade");
  assert.equal(qualified.connector.descriptor.workspacePolicy, "none");
  assert.equal(qualified.connector.descriptor.maxConcurrentExecutions, 1);
  assert.deepEqual(qualified.connector.descriptor.inputModes, ["text"]);
  assert.deepEqual(qualified.connector.descriptor.outputModes, ["text"]);
  assert.deepEqual(qualified.connector.descriptor.capabilityIds, ["general-text-assistance"]);
  assert.deepEqual(qualified.connector.computeOffer, {
    offerId: "local.compute.general-text-assistance.v1",
    capability: "general-text-assistance",
    resourceClass: "local_model",
    executionLocation: "receiver_local",
    inputModes: ["text"],
    outputModes: ["text"],
    concurrency: 1,
    approval: "allow_once"
  });

  const missingModel = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier(),
    probeApi: async () => ({ healthy: true, models: [] }),
    inspectInsightsRetention: async () => "disabled"
  });
  assert.equal(missingModel.connector, null);
  assert.equal(missingModel.readiness.reasonCode, "OSAURUS_BONSAI_MODEL_NOT_INSTALLED");

  const unsupportedVersion = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier({ appVersion: "0.22.1" }),
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    inspectInsightsRetention: async () => "disabled"
  });
  assert.equal(unsupportedVersion.connector, null);
  assert.equal(unsupportedVersion.readiness.reasonCode, "OSAURUS_RUNTIME_VERSION_UNSUPPORTED");
});

test("a qualified facade fails closed while Osaurus is stopped and rebinds after recovery", async () => {
  let discovery: Awaited<ReturnType<NonNullable<OsaurusRuntimeTrustVerifier["discoverRuntime"]>>> = {
    state: "ready",
    identity: structuredClone(IDENTITY)
  };
  const verifier = trustVerifier();
  verifier.discoverRuntime = async () => structuredClone(discovery);
  const qualification = await qualifyOsaurusConnector({
    trustVerifier: verifier,
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    inspectInsightsRetention: async () => "disabled"
  });
  assert.ok(qualification.connector);
  discovery = { state: "not_running", identity: null };
  await assert.rejects(() => qualification.connector!.createExecutionSpec({
    taskId: "osaurus-stopped",
    capabilityId: "general-text-assistance",
    workspacePath: null,
    images: [],
    executionEpoch: 1,
    checkpointRef: null
  }), /OSAURUS_TRUSTED_RUNTIME_NOT_RUNNING/);

  discovery = {
    state: "ready",
    identity: { ...structuredClone(IDENTITY), listenerPid: 5252, instanceId: "22222222-2222-4222-8222-222222222222" }
  };
  const recovered = await qualification.connector.createExecutionSpec({
    taskId: "osaurus-recovered",
    capabilityId: "general-text-assistance",
    workspacePath: null,
    images: [],
    executionEpoch: 1,
    checkpointRef: null
  });
  assert.equal(recovered.kind, "loopback_http");
  if (recovered.kind === "loopback_http") {
    assert.equal(recovered.listenerPid, 5252);
    assert.equal(recovered.runtimeInstanceId, "22222222-2222-4222-8222-222222222222");
  }

  const transport = new ControlledLoopbackTransport();
  const host = new TetiHostAgentKernel({
    connectors: [qualification.connector],
    transports: [transport]
  });
  discovery = { state: "not_running", identity: null };
  const stoppedTask = task("osaurus-host-stopped");
  const stoppedResult = await host.execute(stoppedTask, issueExecutionAuthority(stoppedTask));
  assert.equal(stoppedResult.safeErrorCode, "ADAPTER_RUNTIME_UNAVAILABLE");
  discovery = {
    state: "ready",
    identity: { ...structuredClone(IDENTITY), listenerPid: 6262, instanceId: "33333333-3333-4333-8333-333333333333" }
  };
  const recoveredTask = task("osaurus-host-recovered");
  const recoveredResult = host.execute(recoveredTask, issueExecutionAuthority(recoveredTask));
  await transport.started;
  transport.completeNext("recovered through Host");
  assert.equal((await recoveredResult).artifact?.text, "recovered through Host");
  await host.shutdown();
});

test("Host runs Osaurus facade without Workspace with concurrency one and a bounded queue", async () => {
  const qualification = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier(),
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    inspectInsightsRetention: async () => "disabled"
  });
  const connector = qualification.connector!;
  const transport = new ControlledLoopbackTransport();
  const host = new TetiHostAgentKernel({
    connectors: [connector],
    transports: [transport],
    maxConcurrentTasks: 4
  });
  try {
    const firstRequest = task("osaurus-runtime-first");
    const first = host.execute(firstRequest, issueExecutionAuthority(firstRequest));
    await transport.started;
    assert.equal(transport.workspacePath, null);

    const secondRequest = task("osaurus-runtime-second");
    const second = host.execute(secondRequest, issueExecutionAuthority(secondRequest));
    assert.equal(host.getTask(secondRequest.taskId)?.state, "submitted");

    transport.completeNext("Bonsai local text");
    const result = await first;
    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.text, "Bonsai local text");
    await waitUntil(() => transport.startCount === 2);
    transport.completeNext("Bonsai queued text");
    assert.equal((await second).artifact?.text, "Bonsai queued text");

    assert.deepEqual(host.getLocalChildAgents(), [{
      schemaVersion: 1,
      childAgentId: "osaurus-runtime",
      origin: "runtime_facade",
      workspacePolicy: "none",
      maxConcurrentExecutions: 1,
      connectorIds: ["osaurus.runtime.bonsai-chat"],
      resourceBindingIds: ["osaurus.loopback.bonsai-text"],
      capabilityIds: ["general-text-assistance"],
      inputModes: ["text"],
      outputModes: ["text"]
    }]);
    const passport = projectCallablePassport(host.getCallableAgents(), host.getComputeOffers());
    assert.equal(passport.agents[0]?.id, "osaurus-runtime");
    assert.equal(passport.agents[0]?.name, "Osaurus Runtime (Bonsai)");
    assert.notEqual(passport.agents[0]?.name, "Osaurus Native Agent");
    assert.deepEqual(passport.computeOffers, [{
      offerId: "local.compute.general-text-assistance.v1",
      capability: "general-text-assistance",
      resourceClass: "local_model",
      executionLocation: "receiver_local",
      inputModes: ["text"],
      outputModes: ["text"],
      concurrency: 1,
      approval: "allow_once",
      observedAt: passport.agents[0]!.observedAt
    }]);
    assert.doesNotMatch(
      JSON.stringify(passport.computeOffers),
      /"(?:bonsaiPath|osaurusPort|endpoint|hardware|credential|token|model|path|agentConfig)"/i
    );
  } finally {
    await host.shutdown();
  }
});

test("receiver resolves only the advertised offer and bounds or cancels queued local compute", async () => {
  const qualification = await qualifyOsaurusConnector({
    trustVerifier: trustVerifier(),
    probeApi: async () => ({
      healthy: true,
      models: [{ id: OSAURUS_RUNTIME_CHILD.model, ownedBy: "osaurus" }]
    }),
    inspectInsightsRetention: async () => "disabled"
  });
  const transport = new ControlledLoopbackTransport();
  const host = new TetiHostAgentKernel({
    connectors: [qualification.connector!],
    transports: [transport]
  });
  const target = host.resolveTarget(
    "local.compute.general-text-assistance.v1",
    "general-text-assistance",
    ["text"]
  );
  assert.equal(target?.connectorId, OSAURUS_RUNTIME_CHILD.connectorId);
  assert.equal(host.resolveTarget(
    "capability:general-text-assistance",
    "general-text-assistance",
    ["text"]
  ), null);
  assert.equal(host.resolveTarget(
    "/Applications/Osaurus.app",
    "general-text-assistance",
    ["text"]
  ), null);

  const activeRequest = task("osaurus-active");
  const active = host.execute(activeRequest, issueExecutionAuthority(activeRequest));
  await transport.started;
  const canceledRequest = task("osaurus-queued-cancel");
  const canceled = host.execute(canceledRequest, issueExecutionAuthority(canceledRequest));
  assert.equal(host.cancel(canceledRequest.taskId), true);
  assert.equal((await canceled).state, "canceled");

  const queued = Array.from({ length: 8 }, (_, index) => {
    const request = task(`osaurus-queued-${index}`);
    return host.execute(request, issueExecutionAuthority(request));
  });
  const overflow = task("osaurus-queue-overflow");
  await assert.rejects(
    () => host.execute(overflow, issueExecutionAuthority(overflow)),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "HOST_CHILD_AGENT_BUSY"
  );
  await host.shutdown();
  assert.equal((await active).state, "canceled");
  assert.ok((await Promise.all(queued)).every((result) => result.state === "canceled"));
});

function trustVerifier(overrides: Partial<OsaurusRuntimeIdentity> = {}): OsaurusRuntimeTrustVerifier {
  return {
    async discoverLatestTrustedRuntime() {
      return structuredClone({ ...IDENTITY, ...overrides });
    },
    async verifyListener() {},
    async verifyConnectedSocket() {}
  };
}

function task(taskId: string): CallableAdapterTaskRequest {
  return {
    schemaVersion: 2,
    taskId,
    adapterId: OSAURUS_RUNTIME_CHILD.connectorId,
    agentId: OSAURUS_RUNTIME_CHILD.childAgentId,
    capabilityId: "general-text-assistance",
    input: { kind: "text", text: "answer locally" },
    createdAt: new Date().toISOString()
  };
}

class ControlledLoopbackTransport implements ExecutionTransport {
  readonly kind = "loopback_http" as const;
  workspacePath: string | null | undefined;
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  private readonly handles: ControlledHandle[] = [];
  startCount = 0;

  start(input: { spec: ExecutionSpec; workspacePath: string | null }): ExecutionTransportHandle {
    assert.equal(input.spec.kind, "loopback_http");
    this.workspacePath = input.workspacePath;
    const handle = new ControlledHandle();
    this.handles.push(handle);
    this.startCount += 1;
    this.resolveStarted();
    return handle;
  }

  completeNext(text: string): void {
    this.handles.shift()?.complete(text);
  }
}

async function waitUntil(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!read() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(read(), true, "queued execution did not start");
}

class ControlledHandle implements ExecutionTransportHandle {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly completion: Promise<ExecutionExit>;
  private resolveCompletion!: (exit: ExecutionExit) => void;
  private settled = false;

  constructor() {
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  async writeInput(_text: string): Promise<void> {}

  async terminate(): Promise<void> {
    if (!this.settled) this.finish({ code: null, signal: "SIGTERM" });
  }

  forceKill(): void {
    if (!this.settled) this.finish({ code: null, signal: "SIGKILL" });
  }

  complete(text: string): void {
    if (this.settled) return;
    this.stdout.write(text);
    this.finish({ code: 0, signal: null });
  }

  private finish(exit: ExecutionExit): void {
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveCompletion(exit);
  }
}
