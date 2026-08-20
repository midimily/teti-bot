import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableExecutionRegistry,
  FileExecutionHandleStore,
  MemoryExecutionHandleStore
} from "../lifecycle-sidecar/runtime/callable/execution-store.ts";
import {
  validateConnectorExecutionCapabilities,
  validateExecutionHandle,
  type ConnectorExecutionCapabilities
} from "../../../core/callability/execution.ts";

const noResume: ConnectorExecutionCapabilities = {
  supportsProgress: false,
  supportsPause: false,
  supportsResume: false,
  supportsCheckpoint: false,
  supportsCancel: true
};

const checkpointResume: ConnectorExecutionCapabilities = {
  supportsProgress: true,
  supportsPause: false,
  supportsResume: true,
  supportsCheckpoint: true,
  supportsCancel: true
};

test("Sidecar restart makes an orphaned non-resumable execution queryable but never replays it", async () => {
  const store = new MemoryExecutionHandleStore();
  const firstSidecar = registry(store);
  const handle = await firstSidecar.prepare(input("restart-task"), noResume, "external_side_effects_possible");
  await firstSidecar.markRunning(handle.taskId, handle.executionEpoch, "pid:1234");

  const restartedSidecar = registry(store);
  const interrupted = await restartedSidecar.reconcile([]);

  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].progress.state, "interrupted");
  assert.equal(interrupted[0].resumeCapability, "none");
  assert.equal(interrupted[0].providerExecutionId, null);
  await assert.rejects(
    () => restartedSidecar.prepare(input("restart-task", true), noResume, "external_side_effects_possible"),
    /EXECUTION_RESUME_UNAVAILABLE/
  );
});

test("Workspace-pure execution resumes only from a captured explicit checkpoint and increments epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-execution-checkpoint-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const checkpoint = join(workspace, "state.json");
  await writeFile(checkpoint, "{\"step\":4}\n", { mode: 0o600 });
  const service = new DurableExecutionRegistry({
    store: new MemoryExecutionHandleStore(),
    checkpointRoot: join(root, "private-checkpoints")
  });
  const first = await service.prepare(input("checkpoint-task"), checkpointResume, "workspace_pure_compute");
  await service.markRunning(first.taskId, first.executionEpoch, "pid:41");
  assert.equal(await service.captureCheckpoint({
    taskId: first.taskId,
    executionEpoch: first.executionEpoch,
    sourcePath: checkpoint,
    workspacePath: workspace,
    resumeEligible: true
  }), true);
  await service.finish(first.taskId, first.executionEpoch, "failed", "CHILD_CRASHED");
  const resumable = await service.get(first.taskId);
  assert.equal(resumable?.resumeCapability, "checkpoint_restart");
  assert.notEqual(resumable?.checkpointRef, checkpoint, "checkpoint is copied out of the disposable Snapshot");
  assert.equal(await readFile(resumable!.checkpointRef!, "utf8"), "{\"step\":4}\n");

  const second = await service.prepare(
    input("checkpoint-task", true),
    checkpointResume,
    "workspace_pure_compute"
  );
  assert.equal(second.executionEpoch, 2);
  assert.equal(second.checkpointRef, resumable?.checkpointRef);
});

test("a tampered private checkpoint is rejected and loses its resume capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-execution-checkpoint-tamper-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const checkpoint = join(workspace, "state.json");
  await writeFile(checkpoint, "{\"step\":4}\n", { mode: 0o600 });
  const service = new DurableExecutionRegistry({
    store: new MemoryExecutionHandleStore(),
    checkpointRoot: join(root, "private-checkpoints")
  });
  const first = await service.prepare(input("tampered-checkpoint-task"), checkpointResume, "workspace_pure_compute");
  await service.markRunning(first.taskId, first.executionEpoch, "pid:42");
  assert.equal(await service.captureCheckpoint({
    taskId: first.taskId,
    executionEpoch: first.executionEpoch,
    sourcePath: checkpoint,
    workspacePath: workspace,
    resumeEligible: true
  }), true);
  await service.finish(first.taskId, first.executionEpoch, "failed", "CHILD_CRASHED");
  const captured = await service.get(first.taskId);
  await writeFile(captured!.checkpointRef!, "{\"step\":999,\"injected\":true}\n");

  await assert.rejects(
    () => service.prepare(input(first.taskId, true), checkpointResume, "workspace_pure_compute"),
    /EXECUTION_CHECKPOINT_INTEGRITY_FAILED/
  );
  const quarantined = await service.get(first.taskId);
  assert.equal(quarantined?.resumeCapability, "none");
  assert.equal(quarantined?.checkpointRef, null);
  assert.match(quarantined?.progress.message ?? "", /完整性验证失败/);
});

test("the 0.2.9 Execution Handle store migrates without trusting legacy checkpoint bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-execution-store-migration-"));
  const path = join(root, "execution-handles.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, handles: [] }), "utf8");
  const migrated = await new FileExecutionHandleStore(path).load();
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.checkpointIntegrity, []);
});

test("old completion, late Artifact epoch, and cancel/resume race cannot overwrite the current execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-execution-race-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const checkpoint = join(workspace, "checkpoint.bin");
  await writeFile(checkpoint, "checkpoint", { mode: 0o600 });
  const service = new DurableExecutionRegistry({
    store: new MemoryExecutionHandleStore(),
    checkpointRoot: join(root, "checkpoints")
  });
  const first = await service.prepare(input("race-task"), checkpointResume, "workspace_pure_compute");
  await service.markRunning(first.taskId, first.executionEpoch, "pid:1");
  await service.captureCheckpoint({
    taskId: first.taskId,
    executionEpoch: first.executionEpoch,
    sourcePath: checkpoint,
    workspacePath: workspace,
    resumeEligible: true
  });
  await service.finish(first.taskId, first.executionEpoch, "failed");
  const second = await service.prepare(input("race-task", true), checkpointResume, "workspace_pure_compute");

  assert.equal(await service.finish(first.taskId, first.executionEpoch, "completed"), false);
  assert.equal(await service.isCurrent(second.taskId, second.executionEpoch), true);
  const [canceled, staleCompletion] = await Promise.all([
    service.cancel(second.taskId, second.executionEpoch),
    service.finish(second.taskId, second.executionEpoch, "completed")
  ]);
  assert.equal(canceled || staleCompletion, true);
  const final = await service.get(second.taskId);
  assert.ok(final?.progress.state === "canceled" || final?.progress.state === "completed");
  assert.equal(await service.finish(second.taskId, second.executionEpoch, "completed"), false);
  await assert.rejects(
    () => service.prepare(input("race-task", true), checkpointResume, "workspace_pure_compute"),
    /EXECUTION_RESUME_UNAVAILABLE/
  );
});

test("duplicate completion is idempotent and the local store stays private", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-execution-store-"));
  await chmod(root, 0o700);
  const path = join(root, "execution-handles.json");
  const service = new DurableExecutionRegistry({
    store: new FileExecutionHandleStore(path),
    checkpointRoot: join(root, "checkpoints")
  });
  const handle = await service.prepare(input("complete-once"), noResume, "external_side_effects_possible");
  await service.markRunning(handle.taskId, handle.executionEpoch, "loopback:instance:request");
  assert.equal(await service.finish(handle.taskId, handle.executionEpoch, "completed"), true);
  assert.equal(await service.finish(handle.taskId, handle.executionEpoch, "completed"), false);
  validateExecutionHandle(await service.get(handle.taskId));
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  const serialized = await readFile(path, "utf8");
  assert.match(serialized, /loopback:instance:request/);
  assert.doesNotMatch(serialized, /Passport|Chatmail|remoteTetiId/);
});

test("Connector capability declarations cannot claim resume without checkpoint", () => {
  assert.throws(() => validateConnectorExecutionCapabilities({
    supportsProgress: false,
    supportsPause: false,
    supportsResume: true,
    supportsCheckpoint: false,
    supportsCancel: true
  }), /must support explicit checkpoints/);
});

function registry(store: MemoryExecutionHandleStore): DurableExecutionRegistry {
  return new DurableExecutionRegistry({
    store,
    checkpointRoot: join(tmpdir(), "teti-execution-test-checkpoints")
  });
}

function input(taskId: string, resume = false) {
  return {
    taskId,
    workspaceId: `workspace:${taskId}`,
    childAgentId: "test-child",
    connectorId: "test.connector",
    resume
  };
}
