import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  CallableAdapterTaskRequest
} from "../../../core/callability/adapter.ts";
import {
  issueExecutionAuthority,
  type AgentConnector,
  type AgentConnectorContext
} from "../../../core/callability/agent-core.ts";
import {
  TetiHostAgentKernel,
  TetiHostAgentError
} from "../lifecycle-sidecar/runtime/callable/kernel.ts";
import { FileTaskAttachmentStore } from "../lifecycle-sidecar/runtime/tasks/attachments.ts";
import { parseRunnerManifest } from "../../../integrations/agents/codex/image-adapter.ts";
import type { TaskImagePart } from "../../../core/task/types.ts";
import {
  DurableExecutionRegistry,
  MemoryExecutionHandleStore
} from "../lifecycle-sidecar/runtime/callable/execution-store.ts";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-callable-agent.mjs"
);

test("fake Agent completes a bounded text task through stdin and workspace is removed", async () => {
  const connector = fakeConnector("echo");
  const hostAgent = new TetiHostAgentKernel({ connectors: [connector] });
  const result = await authorizedExecute(hostAgent, task("echo-task"));

  assert.equal(result.state, "completed");
  assert.equal(result.artifact?.text, "fake:hello agent");
  assert.equal(hostAgent.snapshot.activeTaskCount, 0);
  assert.ok(connector.lastContext);
  await assert.rejects(() => stat(connector.lastContext!.workspacePath));
  await hostAgent.shutdown();
});

test("Connector context never receives task text or execution authority", async () => {
  const connector = fakeConnector("echo");
  const hostAgent = new TetiHostAgentKernel({ connectors: [connector] });
  await authorizedExecute(hostAgent, task("no-text-in-launch"));
  assert.deepEqual(Object.keys(connector.lastContext!).sort(), [
    "capabilityId",
    "checkpointRef",
    "executionEpoch",
    "images",
    "taskId",
    "workspaceContext",
    "workspacePath"
  ]);
  assert.equal("input" in (connector.lastContext as unknown as Record<string, unknown>), false);
  assert.equal("authority" in (connector.lastContext as unknown as Record<string, unknown>), false);
  await hostAgent.shutdown();
});

test("Host injects only the bounded Teti-selected Child Memory envelope into Agent input", async () => {
  const connector = fakeConnector("echo");
  const queries: Array<{ taskId: string; workspaceId: string; childAgentId: string }> = [];
  const hostAgent = new TetiHostAgentKernel({
    connectors: [connector],
    memoryProvider: {
      async selectContext(input) {
        queries.push(structuredClone(input));
        return {
          schemaVersion: 1,
          records: [{
            memoryId: "memory-1",
            scope: "child_agent",
            contentDigest: `sha256:${"a".repeat(64)}`,
            content: "user-approved reference"
          }],
          byteLength: new TextEncoder().encode("user-approved reference").byteLength
        };
      }
    }
  });
  const result = await authorizedExecute(hostAgent, task("memory-input-task"));

  assert.deepEqual(queries, [{
    taskId: "memory-input-task",
    workspaceId: "workspace:memory-input-task",
    childAgentId: "fake-agent"
  }]);
  assert.match(result.artifact?.text ?? "", /\[TETI_CHILD_MEMORY_V1\]/);
  assert.match(result.artifact?.text ?? "", /user-approved reference/);
  assert.match(result.artifact?.text ?? "", /\[CURRENT_TASK\]\nhello agent/);
  assert.equal("memory" in (connector.lastContext as unknown as Record<string, unknown>), false);
  await hostAgent.shutdown();
});

test("Kernel persists a real image file before deleting the Adapter workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-callable-image-"));
  try {
    const connector: AgentConnector = {
      descriptor: {
        contractVersion: 2,
        connectorId: "test.image-agent",
        connectorRevision: 1,
        childAgentId: "fake-image",
        capabilityIds: ["image-editing"],
        inputModes: ["text", "image"],
        outputModes: ["text", "image"],
        transportKind: "process",
        executionCapabilities: {
          supportsProgress: false,
          supportsPause: false,
          supportsResume: false,
          supportsCheckpoint: false,
          supportsCancel: true
        },
        executionSemantics: "external_side_effects_possible",
        timeoutMs: 2_000,
        cancelGraceMs: 20,
        maxOutputBytes: 64 * 1024
      },
      resourceBinding: {
        schemaVersion: 1,
        bindingId: "fake-image.process.image-editing",
        childAgentId: "fake-image",
        connectorId: "test.image-agent",
        transportKind: "process",
        capabilityIds: ["image-editing"]
      },
      fixedProcessEntrypoint: process.execPath,
      createExecutionSpec() {
        return { kind: "process", executable: process.execPath, args: [fixturePath, "image"] };
      },
      decodeArtifact(stdout) {
        const manifest = parseRunnerManifest(stdout);
        return { kind: "parts", text: manifest.text, images: manifest.images };
      }
    };
    const store = new FileTaskAttachmentStore(join(root, "artifacts"));
    const hostAgent = new TetiHostAgentKernel({ connectors: [connector], artifactImageStore: store });
    const request: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId: "image-output-task",
      adapterId: "test.image-agent",
      agentId: "fake-image",
      capabilityId: "image-editing",
      input: { kind: "parts", text: "edit this image", images: [] },
      createdAt: new Date().toISOString()
    };
    const result = await authorizedExecute(hostAgent, request);

    assert.equal(result.state, "completed");
    assert.equal(result.artifact?.kind, "parts");
    const image = result.artifact?.kind === "parts" ? result.artifact.images[0] : undefined;
    assert.ok(image);
    assert.ok(await store.resolveImage({ taskId: result.taskId, purpose: "artifact", part: image }));
    await hostAgent.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a canceled execution removes an image Artifact that becomes stale during persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-callable-stale-image-"));
  try {
    const connector: AgentConnector = {
      descriptor: {
        contractVersion: 2,
        connectorId: "test.stale-image-agent",
        connectorRevision: 1,
        childAgentId: "fake-stale-image",
        capabilityIds: ["image-editing"],
        inputModes: ["text", "image"],
        outputModes: ["text", "image"],
        transportKind: "process",
        executionCapabilities: {
          supportsProgress: false,
          supportsPause: false,
          supportsResume: false,
          supportsCheckpoint: false,
          supportsCancel: true
        },
        executionSemantics: "external_side_effects_possible",
        timeoutMs: 2_000,
        cancelGraceMs: 20,
        maxOutputBytes: 64 * 1024
      },
      resourceBinding: {
        schemaVersion: 1,
        bindingId: "fake-stale-image.process.image-editing",
        childAgentId: "fake-stale-image",
        connectorId: "test.stale-image-agent",
        transportKind: "process",
        capabilityIds: ["image-editing"]
      },
      fixedProcessEntrypoint: process.execPath,
      createExecutionSpec() {
        return { kind: "process", executable: process.execPath, args: [fixturePath, "image"] };
      },
      decodeArtifact(stdout) {
        const manifest = parseRunnerManifest(stdout);
        return { kind: "parts", text: manifest.text, images: manifest.images };
      }
    };
    const backingStore = new FileTaskAttachmentStore(join(root, "artifacts"));
    const registry = new DurableExecutionRegistry({
      store: new MemoryExecutionHandleStore(),
      checkpointRoot: join(root, "checkpoints")
    });
    let ingestedPart: TaskImagePart | null = null;
    const artifactStore = {
      async ingestGeneratedImage(taskId: string, sourcePath: string) {
        const staged = await backingStore.ingestGeneratedImage(taskId, sourcePath);
        ingestedPart = staged.part;
        const handle = await registry.get(taskId);
        assert.ok(handle);
        await registry.cancel(taskId, handle.executionEpoch);
        return staged;
      },
      removeGeneratedImage(taskId: string, part: TaskImagePart) {
        return backingStore.removeGeneratedImage(taskId, part);
      }
    };
    const hostAgent = new TetiHostAgentKernel({
      connectors: [connector],
      artifactImageStore: artifactStore,
      executionRegistry: registry
    });
    const request: CallableAdapterTaskRequest = {
      schemaVersion: 2,
      taskId: "stale-image-output-task",
      adapterId: connector.descriptor.connectorId,
      agentId: connector.descriptor.childAgentId,
      capabilityId: "image-editing",
      input: { kind: "parts", text: "cancel during persistence", images: [] },
      createdAt: new Date().toISOString()
    };

    const result = await authorizedExecute(hostAgent, request);

    assert.equal(result.state, "canceled");
    assert.equal(result.artifact, undefined);
    assert.ok(ingestedPart);
    assert.equal(await backingStore.resolveImage({
      taskId: request.taskId,
      purpose: "artifact",
      part: ingestedPart
    }), null);
    await hostAgent.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout escalates process termination and returns only a safe error", async () => {
  const adapter = fakeConnector("hang", { timeoutMs: 50, cancelGraceMs: 10 });
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const result = await authorizedExecute(kernel, task("timeout-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_TIMEOUT");
  assert.equal(result.artifact, undefined);
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  await kernel.shutdown();
});

test("explicit cancellation kills the complete fake Agent process group", async () => {
  const adapter = fakeConnector("child-tree", { timeoutMs: 5_000, cancelGraceMs: 10 });
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const request = task("cancel-tree-task");
  const completion = authorizedExecute(kernel, request);
  const context = await waitFor(() => adapter.lastContext);
  const pidFile = join(context.workspacePath, "fake-process-tree.json");
  const pids = JSON.parse(await waitForFile(pidFile)) as { parentPid: number; childPid: number };

  assert.equal(kernel.cancel("cancel-tree-task"), true);
  const result = await completion;
  assert.equal(result.state, "canceled");
  assert.equal(result.safeErrorCode, "ADAPTER_CANCELED");
  await waitForProcessExit(pids.parentPid);
  await waitForProcessExit(pids.childPid);
  await assert.rejects(() => stat(context.workspacePath));
  await kernel.shutdown();
});

test("combined stdout and stderr are bounded and partial output is discarded", async () => {
  const adapter = fakeConnector("overflow", { timeoutMs: 2_000, maxOutputBytes: 1_024 });
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const result = await authorizedExecute(kernel, task("overflow-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_OUTPUT_LIMIT");
  assert.equal(result.artifact, undefined);
  await kernel.shutdown();
});

test("one failing Adapter execution is isolated from another task", async () => {
  const failing = fakeConnector("fail", { connectorId: "test.failing-agent" });
  const healthy = fakeConnector("echo", { connectorId: "test.healthy-agent" });
  const kernel = new TetiHostAgentKernel({ connectors: [failing, healthy] });
  const [failed, completed] = await Promise.all([
    authorizedExecute(kernel, task("failed-task", "test.failing-agent")),
    authorizedExecute(kernel, task("healthy-task", "test.healthy-agent"))
  ]);

  assert.equal(failed.state, "failed");
  assert.equal(failed.safeErrorCode, "ADAPTER_EXIT_NONZERO");
  assert.equal(completed.state, "completed");
  assert.equal(completed.artifact?.text, "fake:hello agent");
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  await kernel.shutdown();
});

test("an Agent that exits unexpectedly is failed safely and its workspace is recovered", async () => {
  const adapter = fakeConnector("exit-signal");
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const result = await authorizedExecute(kernel, task("agent-exit-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_EXIT_NONZERO");
  assert.equal(result.artifact, undefined);
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  assert.ok(adapter.lastContext);
  await assert.rejects(() => stat(adapter.lastContext!.workspacePath));
  await kernel.shutdown();
});

test("Host rejects duplicate IDs, unknown Connectors, and new work after shutdown", async () => {
  const adapter = fakeConnector("echo");
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  await authorizedExecute(kernel, task("retained-task"));
  await assert.rejects(
    () => authorizedExecute(kernel, task("retained-task")),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "HOST_TASK_DUPLICATE"
  );
  await assert.rejects(
    () => authorizedExecute(kernel, task("unknown-task", "test.unknown")),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "CONNECTOR_NOT_FOUND"
  );
  await kernel.shutdown();
  await assert.rejects(
    () => authorizedExecute(kernel, task("after-stop")),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "HOST_AGENT_STOPPED"
  );
});

test("Host safely registers a qualified Connector after Runtime bootstrap", async () => {
  const adapter = fakeConnector("echo");
  const kernel = new TetiHostAgentKernel();

  await assert.rejects(
    () => authorizedExecute(kernel, task("before-qualification")),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "CONNECTOR_NOT_FOUND"
  );

  const descriptor = kernel.registerConnector(adapter, "2026-07-26T00:00:00.000Z");
  assert.equal(descriptor.connectorId, adapter.descriptor.connectorId);
  assert.deepEqual(kernel.snapshot.connectors.map((item) => item.connectorId), [
    adapter.descriptor.connectorId
  ]);
  assert.deepEqual(kernel.getCallableAgents(), [{
    schemaVersion: 1,
    agentId: "fake-agent",
    adapterId: "test.fake-agent",
    adapterRevision: 1,
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    readyAt: "2026-07-26T00:00:00.000Z"
  }]);
  assert.deepEqual(kernel.getLocalChildAgents(), [{
    schemaVersion: 1,
    childAgentId: "fake-agent",
    origin: "native_agent",
    workspacePolicy: "snapshot",
    maxConcurrentExecutions: null,
    connectorIds: ["test.fake-agent"],
    resourceBindingIds: ["fake.process.test.fake-agent"],
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"]
  }]);
  assert.throws(
    () => kernel.registerConnector(adapter),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "CONNECTOR_DUPLICATE"
  );

  const result = await authorizedExecute(kernel, task("after-qualification"));
  assert.equal(result.state, "completed");
  await kernel.shutdown();
  assert.throws(
    () => kernel.registerConnector(fakeConnector("echo", { connectorId: "test.after-stop" })),
    (error: unknown) => error instanceof TetiHostAgentError
      && error.code === "HOST_AGENT_STOPPED"
  );
});

test("Runtime shutdown cancels active local tasks and reaps their process", async () => {
  const adapter = fakeConnector("hang", { timeoutMs: 5_000, cancelGraceMs: 10 });
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const completion = authorizedExecute(kernel, task("shutdown-task"));
  await waitFor(() => adapter.lastContext);
  await kernel.shutdown();
  const result = await completion;

  assert.equal(result.state, "canceled");
  assert.equal(result.safeErrorCode, "ADAPTER_RUNTIME_SHUTDOWN");
  assert.equal(kernel.snapshot.activeTaskCount, 0);
});

test("Runtime shutdown bypasses a long Adapter grace period", async () => {
  const adapter = fakeConnector("hang", { timeoutMs: 5_000, cancelGraceMs: 5_000 });
  const kernel = new TetiHostAgentKernel({ connectors: [adapter] });
  const completion = authorizedExecute(kernel, task("bounded-shutdown-task"));
  await waitFor(() => adapter.lastContext);
  const startedAt = Date.now();
  await kernel.shutdown();
  const result = await completion;

  assert.equal(result.state, "canceled");
  assert.equal(result.safeErrorCode, "ADAPTER_RUNTIME_SHUTDOWN");
  assert.ok(Date.now() - startedAt < 1_000, "shutdown must not wait for a five-second Adapter grace");
});

interface FakeConnectorOverrides {
  connectorId?: string;
  timeoutMs?: number;
  cancelGraceMs?: number;
  maxOutputBytes?: number;
}

interface CapturingFakeConnector extends AgentConnector {
  lastContext: AgentConnectorContext | null;
}

function fakeConnector(mode: string, overrides: FakeConnectorOverrides = {}): CapturingFakeConnector {
  return {
    descriptor: {
      contractVersion: 2,
      connectorId: overrides.connectorId ?? "test.fake-agent",
      connectorRevision: 1,
      childAgentId: "fake-agent",
      capabilityIds: ["code-analysis"],
      inputModes: ["text"],
      outputModes: ["text"],
      transportKind: "process",
      executionCapabilities: {
        supportsProgress: false,
        supportsPause: false,
        supportsResume: false,
        supportsCheckpoint: false,
        supportsCancel: true
      },
      executionSemantics: "external_side_effects_possible",
      timeoutMs: overrides.timeoutMs ?? 2_000,
      cancelGraceMs: overrides.cancelGraceMs ?? 20,
      maxOutputBytes: overrides.maxOutputBytes ?? 4 * 1_024
    },
    resourceBinding: {
      schemaVersion: 1,
      bindingId: `fake.process.${overrides.connectorId ?? "test.fake-agent"}`,
      childAgentId: "fake-agent",
      connectorId: overrides.connectorId ?? "test.fake-agent",
      transportKind: "process",
      capabilityIds: ["code-analysis"]
    },
    fixedProcessEntrypoint: process.execPath,
    lastContext: null,
    createExecutionSpec(context) {
      this.lastContext = structuredClone(context);
      return {
        kind: "process",
        executable: process.execPath,
        args: [fixturePath, mode],
        environment: { TETI_FAKE_AGENT: "1" }
      };
    }
  };
}

function task(taskId: string, adapterId = "test.fake-agent"): CallableAdapterTaskRequest {
  return {
    schemaVersion: 1,
    taskId,
    adapterId,
    agentId: "fake-agent",
    capabilityId: "code-analysis",
    input: { kind: "text", text: "hello agent" },
    createdAt: new Date().toISOString()
  };
}

function authorizedExecute(
  hostAgent: TetiHostAgentKernel,
  request: CallableAdapterTaskRequest
) {
  return hostAgent.execute(request, issueExecutionAuthority(request));
}

async function waitFor<T>(read: () => T | null, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(5);
  }
  throw new Error("Timed out waiting for fake Agent state.");
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(10);
    }
  }
  throw new Error("Timed out waiting for fake Agent process tree.");
}

async function waitForProcessExit(pid: number, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(10);
    } catch (error) {
      if (readErrorCode(error) === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Fake Agent process ${pid} was not reaped.`);
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
