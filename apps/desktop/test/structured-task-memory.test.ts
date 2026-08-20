import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  boundStructuredTaskMemoryContent,
  type LongHorizonStageMemoryInput
} from "../../../core/memory/structured-task.ts";
import {
  SqliteStructuredTaskMemoryStore,
  StructuredTaskMemoryStoreError
} from "../lifecycle-sidecar/runtime/memory/structured-task-sqlite.ts";

test("SQLite structured memory is owner-only, durable, and idempotent per stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-structured-memory-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const now = () => new Date("2026-08-20T00:00:00.000Z");
  const store = new SqliteStructuredTaskMemoryStore({ path, now });
  try {
    await store.initialize();
    const input = stageInput("task-new", "artifact-new", now().toISOString());
    await store.saveStage(input);
    await store.saveStage(input);
    const snapshot = await store.getTaskSnapshot(input.taskId);
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.recordCount, 1);
    assert.equal(snapshot.latestStageIndex, 1);
    assert.equal(snapshot.records[0]?.contentPreview, "Stage handoff result");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    await store.close();
  }

  const reopened = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date("2026-08-21T00:00:00.000Z")
  });
  try {
    assert.equal((await reopened.getTaskSnapshot("task-new")).recordCount, 1);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh Beta 0.5 database skips pre-feature tasks instead of migrating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-structured-memory-cutoff-"));
  const store = new SqliteStructuredTaskMemoryStore({
    path: join(root, "collaboration-memory-v2.sqlite"),
    now: () => new Date("2026-08-20T00:00:00.000Z")
  });
  try {
    await store.initialize();
    await store.saveStage(stageInput(
      "task-before-beta-0-5",
      "artifact-before-beta-0-5",
      "2026-08-19T23:59:59.999Z"
    ));
    assert.equal((await store.getTaskSnapshot("task-before-beta-0-5")).recordCount, 0);

    const current = stageInput(
      "task-beta-0-5",
      "artifact-beta-0-5",
      "2026-08-20T00:00:00.000Z"
    );
    await store.saveStage(current);
    await assert.rejects(
      () => store.saveStage({ ...current, artifactId: "artifact-conflict", content: "other" }),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_SOURCE_CONFLICT"
    );
    assert.equal((await store.getTaskSnapshot(current.taskId)).recordCount, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("structured stage content is bounded by UTF-8 bytes before SQLite persistence", () => {
  const content = boundStructuredTaskMemoryContent("协".repeat(2_000));
  assert.ok(new TextEncoder().encode(content).byteLength <= 4 * 1_024);
  assert.ok(content.length > 0);
  assert.equal(content.includes("�"), false);
});

test("an unknown future SQLite schema fails closed without rebuilding the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-structured-memory-future-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const future = new DatabaseSync(path);
  future.exec("PRAGMA user_version = 2");
  future.close();
  const store = new SqliteStructuredTaskMemoryStore({ path });
  try {
    await assert.rejects(
      () => store.initialize(),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_STORE_UNAVAILABLE"
    );
    const preserved = new DatabaseSync(path, { readOnly: true });
    assert.equal((preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    preserved.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function stageInput(
  taskId: string,
  artifactId: string,
  taskCreatedAt: string
): LongHorizonStageMemoryInput {
  return {
    schemaVersion: 1,
    taskId,
    taskCreatedAt,
    peerTetiId: "teti_peer00001",
    workspaceId: "workspace:task-memory",
    stageId: "stage:1",
    stageIndex: 1,
    executionTaskId: `lh_${taskId}_1`,
    executionEpoch: 1,
    childAgentId: "codex",
    connectorId: "codex.process",
    artifactId,
    workspaceRevision: 1,
    content: "Stage handoff result",
    createdAt: "2026-08-20T00:00:00.000Z"
  };
}
