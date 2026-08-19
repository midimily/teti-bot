import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionHandle } from "../../../core/callability/execution.ts";
import type { CollaborationTaskTransportRecord } from "../../../core/task/transport.ts";
import { CHILD_MEMORY_LIMITS } from "../../../core/memory/types.ts";
import {
  ChildMemoryService,
  ChildMemoryServiceError,
  MemoryChildMemoryStore
} from "../lifecycle-sidecar/runtime/memory/service.ts";

test("durable Child Memory is disabled by default and remote task completion cannot write it", async () => {
  const service = memoryService();
  const task = completedTask("task-default", "workspace-default", "private result");

  assert.deepEqual((await service.list()).authorizations, []);
  assert.deepEqual((await service.selectContext({
    taskId: "task-query",
    workspaceId: "workspace-default",
    childAgentId: "codex"
  })).records, []);
  await assert.rejects(
    () => service.saveFromTask({
      task,
      execution: executionFor(task, "codex"),
      scope: "child_agent",
      confirmed: true
    }),
    (error: unknown) => error instanceof ChildMemoryServiceError
      && error.code === "MEMORY_SCOPE_DISABLED"
  );
  await service.setAuthorization({
    scope: "child_agent",
    workspaceId: null,
    childAgentId: "codex",
    enabled: true
  });
  await assert.rejects(
    () => service.saveFromTask({
      task,
      execution: executionFor(task, "codex"),
      scope: "child_agent",
      confirmed: false as true
    }),
    (error: unknown) => error instanceof ChildMemoryServiceError
      && error.code === "MEMORY_WRITE_NOT_AUTHORIZED"
  );
  assert.equal((await service.list()).records.length, 0);
});

test("Workspace and Child Agent Memory retrieval remains bounded and scope-isolated", async () => {
  const service = memoryService();
  await service.setAuthorization({
    scope: "child_agent",
    workspaceId: null,
    childAgentId: "codex",
    enabled: true
  });
  await service.setAuthorization({
    scope: "workspace",
    workspaceId: "workspace-a",
    childAgentId: "codex",
    enabled: true
  });
  const workspaceTask = completedTask("task-workspace", "workspace-a", "workspace-private");
  await service.saveFromTask({
    task: workspaceTask,
    execution: executionFor(workspaceTask, "codex"),
    scope: "workspace",
    confirmed: true
  });
  for (let index = 0; index < 5; index += 1) {
    const task = completedTask(`task-child-${index}`, "workspace-a", `${index}:${"x".repeat(2_900)}`);
    await service.saveFromTask({
      task,
      execution: executionFor(task, "codex"),
      scope: "child_agent",
      confirmed: true
    });
  }
  const selected = await service.selectContext({
    taskId: "task-query-a",
    workspaceId: "workspace-a",
    childAgentId: "codex"
  });
  assert.ok(selected.records.length <= CHILD_MEMORY_LIMITS.maximumContextRecords);
  assert.ok(selected.byteLength <= CHILD_MEMORY_LIMITS.maximumContextBytes);
  assert.ok(selected.records.some((record) => record.content === "workspace-private"));
  const otherWorkspace = await service.selectContext({
    taskId: "task-query-b",
    workspaceId: "workspace-b",
    childAgentId: "codex"
  });
  assert.equal(otherWorkspace.records.some((record) => record.content === "workspace-private"), false);
  const otherChild = await service.selectContext({
    taskId: "task-query-child",
    workspaceId: "workspace-a",
    childAgentId: "codebuddy"
  });
  assert.deepEqual(otherChild.records, []);
});

test("deletion and expiry immediately invalidate retrieval while export stays receiver-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-child-memory-"));
  let now = new Date("2026-07-29T00:00:00.000Z");
  const service = new ChildMemoryService({
    store: new MemoryChildMemoryStore(),
    exportRoot: root,
    now: () => new Date(now)
  });
  try {
    await service.setAuthorization({
      scope: "child_agent",
      workspaceId: null,
      childAgentId: "codex",
      enabled: true
    });
    const task = completedTask("task-delete", "workspace-a", "delete me");
    const record = await service.saveFromTask({
      task,
      execution: executionFor(task, "codex"),
      scope: "child_agent",
      confirmed: true
    });
    assert.equal((await service.selectContext(query())).records.length, 1);
    assert.equal(await service.delete(record.memoryId), true);
    assert.equal((await service.selectContext(query())).records.length, 0);

    const expiringTask = completedTask("task-expire", "workspace-a", "expire me");
    await service.saveFromTask({
      task: expiringTask,
      execution: executionFor(expiringTask, "codex"),
      scope: "child_agent",
      confirmed: true
    });
    const exported = await service.export();
    assert.equal(exported.recordCount, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(exported.path)).mode & 0o777, 0o600);
    }
    assert.match(await readFile(exported.path, "utf8"), /"actor": "local_user"/);

    now = new Date(now.getTime() + CHILD_MEMORY_LIMITS.defaultRetentionMs + 1);
    assert.equal((await service.list()).records.length, 0);
    assert.equal((await service.selectContext(query())).records.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function memoryService(): ChildMemoryService {
  return new ChildMemoryService({
    store: new MemoryChildMemoryStore(),
    exportRoot: join(tmpdir(), "teti-child-memory-test-export"),
    now: () => new Date("2026-07-29T00:00:00.000Z")
  });
}

function query() {
  return {
    taskId: "task-query",
    workspaceId: "workspace-a",
    childAgentId: "codex"
  };
}

function completedTask(
  taskId: string,
  workspaceId: string,
  text: string
): CollaborationTaskTransportRecord {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    schemaVersion: 1,
    direction: "incoming",
    peerTetiId: "teti_peer00001",
    protocolVersion: 5,
    request: {
      schemaVersion: 5,
      taskId,
      requesterTetiId: "teti_peer00001",
      targetTetiId: "teti_local0001",
      offerId: "capability:code-analysis",
      capabilityId: "code-analysis",
      input: { kind: "text", text: "untrusted remote prompt" },
      createdAt: now,
      expiresAt: "2026-07-29T01:00:00.000Z"
    },
    workspaceBinding: {
      workspaceId,
      workspaceRevision: 1,
      mode: "durable_collaboration",
      access: ["read", "write", "create_artifact"]
    },
    state: "completed",
    approval: "approved",
    delivery: "acknowledged",
    artifacts: [{
      schemaVersion: 1,
      taskId,
      artifactId: `artifact-${taskId}`,
      kind: "text",
      text,
      createdAt: now
    }],
    createdAt: now,
    updatedAt: now
  };
}

function executionFor(
  task: CollaborationTaskTransportRecord,
  childAgentId: string
): ExecutionHandle {
  return {
    schemaVersion: 1,
    taskId: task.request.taskId,
    workspaceId: task.workspaceBinding!.workspaceId,
    childAgentId,
    connectorId: `connector.${childAgentId}`,
    executionEpoch: 1,
    providerExecutionId: null,
    leaseExpiresAt: "2026-07-29T00:01:00.000Z",
    progress: {
      state: "completed",
      completedUnits: 1,
      totalUnits: 1,
      message: "done",
      updatedAt: "2026-07-29T00:00:00.000Z"
    },
    checkpointRef: null,
    resumeCapability: "none"
  };
}
