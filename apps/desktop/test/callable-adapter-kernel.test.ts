import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  CallableAdapter,
  CallableAdapterLaunchContext,
  CallableAdapterTaskRequest
} from "../../../core/callability/adapter.ts";
import {
  CallableAdapterKernel,
  CallableAdapterKernelError
} from "../lifecycle-sidecar/runtime/callable/kernel.ts";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-callable-agent.mjs"
);

test("fake Agent completes a bounded text task through stdin and workspace is removed", async () => {
  const adapter = fakeAdapter("echo");
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const result = await kernel.execute(task("echo-task"));

  assert.equal(result.state, "completed");
  assert.equal(result.artifact?.text, "fake:hello agent");
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  assert.ok(adapter.lastContext);
  await assert.rejects(() => stat(adapter.lastContext!.workspacePath));
  await kernel.shutdown();
});

test("Adapter launch context never receives task text", async () => {
  const adapter = fakeAdapter("echo");
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  await kernel.execute(task("no-text-in-launch"));
  assert.deepEqual(Object.keys(adapter.lastContext!).sort(), [
    "capabilityId",
    "images",
    "taskId",
    "workspacePath"
  ]);
  assert.equal("input" in (adapter.lastContext as unknown as Record<string, unknown>), false);
  await kernel.shutdown();
});

test("timeout escalates process termination and returns only a safe error", async () => {
  const adapter = fakeAdapter("hang", { timeoutMs: 50, cancelGraceMs: 10 });
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const result = await kernel.execute(task("timeout-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_TIMEOUT");
  assert.equal(result.artifact, undefined);
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  await kernel.shutdown();
});

test("explicit cancellation kills the complete fake Agent process group", async () => {
  const adapter = fakeAdapter("child-tree", { timeoutMs: 5_000, cancelGraceMs: 10 });
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const completion = kernel.execute(task("cancel-tree-task"));
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
  const adapter = fakeAdapter("overflow", { timeoutMs: 2_000, maxOutputBytes: 1_024 });
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const result = await kernel.execute(task("overflow-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_OUTPUT_LIMIT");
  assert.equal(result.artifact, undefined);
  await kernel.shutdown();
});

test("one failing Adapter execution is isolated from another task", async () => {
  const failing = fakeAdapter("fail", { adapterId: "test.failing-agent" });
  const healthy = fakeAdapter("echo", { adapterId: "test.healthy-agent" });
  const kernel = new CallableAdapterKernel({ adapters: [failing, healthy] });
  const [failed, completed] = await Promise.all([
    kernel.execute(task("failed-task", "test.failing-agent")),
    kernel.execute(task("healthy-task", "test.healthy-agent"))
  ]);

  assert.equal(failed.state, "failed");
  assert.equal(failed.safeErrorCode, "ADAPTER_EXIT_NONZERO");
  assert.equal(completed.state, "completed");
  assert.equal(completed.artifact?.text, "fake:hello agent");
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  await kernel.shutdown();
});

test("an Agent that exits unexpectedly is failed safely and its workspace is recovered", async () => {
  const adapter = fakeAdapter("exit-signal");
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const result = await kernel.execute(task("agent-exit-task"));

  assert.equal(result.state, "failed");
  assert.equal(result.safeErrorCode, "ADAPTER_EXIT_NONZERO");
  assert.equal(result.artifact, undefined);
  assert.equal(kernel.snapshot.activeTaskCount, 0);
  assert.ok(adapter.lastContext);
  await assert.rejects(() => stat(adapter.lastContext!.workspacePath));
  await kernel.shutdown();
});

test("Kernel rejects duplicate IDs, unknown Adapters, and new work after shutdown", async () => {
  const adapter = fakeAdapter("echo");
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  await kernel.execute(task("retained-task"));
  await assert.rejects(
    () => kernel.execute(task("retained-task")),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_TASK_DUPLICATE"
  );
  await assert.rejects(
    () => kernel.execute(task("unknown-task", "test.unknown")),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_NOT_FOUND"
  );
  await kernel.shutdown();
  await assert.rejects(
    () => kernel.execute(task("after-stop")),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_KERNEL_STOPPED"
  );
});

test("Kernel safely registers a qualified Adapter after Runtime bootstrap", async () => {
  const adapter = fakeAdapter("echo");
  const kernel = new CallableAdapterKernel();

  await assert.rejects(
    () => kernel.execute(task("before-qualification")),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_NOT_FOUND"
  );

  const descriptor = kernel.registerAdapter(adapter, "2026-07-26T00:00:00.000Z");
  assert.equal(descriptor.adapterId, adapter.descriptor.adapterId);
  assert.deepEqual(kernel.snapshot.adapters.map((item) => item.adapterId), [
    adapter.descriptor.adapterId
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
  assert.throws(
    () => kernel.registerAdapter(adapter),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_DUPLICATE"
  );

  const result = await kernel.execute(task("after-qualification"));
  assert.equal(result.state, "completed");
  await kernel.shutdown();
  assert.throws(
    () => kernel.registerAdapter(fakeAdapter("echo", { adapterId: "test.after-stop" })),
    (error: unknown) => error instanceof CallableAdapterKernelError
      && error.code === "ADAPTER_KERNEL_STOPPED"
  );
});

test("Runtime shutdown cancels active local tasks and reaps their process", async () => {
  const adapter = fakeAdapter("hang", { timeoutMs: 5_000, cancelGraceMs: 10 });
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const completion = kernel.execute(task("shutdown-task"));
  await waitFor(() => adapter.lastContext);
  await kernel.shutdown();
  const result = await completion;

  assert.equal(result.state, "canceled");
  assert.equal(result.safeErrorCode, "ADAPTER_RUNTIME_SHUTDOWN");
  assert.equal(kernel.snapshot.activeTaskCount, 0);
});

test("Runtime shutdown bypasses a long Adapter grace period", async () => {
  const adapter = fakeAdapter("hang", { timeoutMs: 5_000, cancelGraceMs: 5_000 });
  const kernel = new CallableAdapterKernel({ adapters: [adapter] });
  const completion = kernel.execute(task("bounded-shutdown-task"));
  await waitFor(() => adapter.lastContext);
  const startedAt = Date.now();
  await kernel.shutdown();
  const result = await completion;

  assert.equal(result.state, "canceled");
  assert.equal(result.safeErrorCode, "ADAPTER_RUNTIME_SHUTDOWN");
  assert.ok(Date.now() - startedAt < 1_000, "shutdown must not wait for a five-second Adapter grace");
});

interface FakeAdapterOverrides {
  adapterId?: string;
  timeoutMs?: number;
  cancelGraceMs?: number;
  maxOutputBytes?: number;
}

interface CapturingFakeAdapter extends CallableAdapter {
  lastContext: CallableAdapterLaunchContext | null;
}

function fakeAdapter(mode: string, overrides: FakeAdapterOverrides = {}): CapturingFakeAdapter {
  return {
    descriptor: {
      contractVersion: 1,
      adapterId: overrides.adapterId ?? "test.fake-agent",
      adapterRevision: 1,
      agentId: "fake-agent",
      capabilityIds: ["code-analysis"],
      inputMode: "text",
      outputMode: "text",
      timeoutMs: overrides.timeoutMs ?? 2_000,
      cancelGraceMs: overrides.cancelGraceMs ?? 20,
      maxOutputBytes: overrides.maxOutputBytes ?? 4 * 1_024
    },
    entrypoint: process.execPath,
    lastContext: null,
    createLaunchSpec(context) {
      this.lastContext = structuredClone(context);
      return {
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
