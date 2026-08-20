import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  boundStructuredTaskMemoryContent,
  type LongHorizonStageMemoryInput
} from "../../../core/memory/structured-task.ts";
import type { MemoryShadowRetrievalInput } from "../../../core/memory/shadow-retrieval.ts";
import {
  SqliteStructuredTaskMemoryStore,
  StructuredTaskMemoryStoreError
} from "../lifecycle-sidecar/runtime/memory/structured-task-sqlite.ts";

test("SQLite structured memory is durable, idempotent, and private on POSIX", async () => {
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
    const databaseStats = await stat(path);
    const rootStats = await stat(root);
    assert.equal(databaseStats.isFile(), true);
    assert.equal(rootStats.isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal(databaseStats.mode & 0o777, 0o600);
      assert.equal(rootStats.mode & 0o777, 0o700);
    }
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

test("Shadow Retrieval deterministically emits task, workspace, and peer candidates without content", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-shadow-retrieval-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const featureTime = "2026-08-20T00:00:00.000Z";
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(featureTime)
  });
  try {
    await store.initialize();
    await store.saveStage(stageInput("task-current", "artifact-task", featureTime, {
      content: "Current task deployment constraint"
    }));
    await store.saveStage(stageInput("task-workspace", "artifact-workspace", featureTime, {
      content: "Workspace deployment constraint"
    }));
    await store.saveStage(stageInput("task-peer", "artifact-peer", featureTime, {
      workspaceId: "workspace:other",
      content: "Peer deployment constraint"
    }));
    await store.saveStage(stageInput("task-foreign", "artifact-foreign", featureTime, {
      peerTetiId: "teti_foreign0001",
      workspaceId: "workspace:foreign",
      content: "Foreign deployment constraint"
    }));
    await store.saveStage(stageInput("task-other-child", "artifact-other-child", featureTime, {
      childAgentId: "codebuddy",
      content: "Other Child deployment constraint"
    }));

    const input: MemoryShadowRetrievalInput = {
      schemaVersion: 1,
      executionId: "lh_task-current_2:epoch:1",
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "Review the deployment constraint",
      generatedAt: "2026-08-21T00:00:00.000Z"
    };
    const manifest = await store.createShadowManifest(input);
    assert.equal(manifest.mode, "shadow");
    assert.equal(manifest.cliInjectionEnabled, false);
    assert.deepEqual(manifest.scopeCandidateCounts, { task: 1, workspace: 1, peer: 1 });
    assert.deepEqual(manifest.candidates.map((candidate) => candidate.scope), [
      "task",
      "workspace",
      "peer"
    ]);
    assert.ok(manifest.candidates.every((candidate) =>
      candidate.eligibleForCliInjection === false
      && candidate.reasons.includes("keyword_match")
    ));
    assert.equal(JSON.stringify(manifest).includes("deployment constraint"), false);
    assert.equal((await store.getLatestShadowManifest("task-current"))?.manifestDigest, manifest.manifestDigest);
    assert.equal((await store.getTaskSnapshot("task-current")).latestShadowManifest?.manifestId, manifest.manifestId);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      assert.deepEqual(await store.createShadowManifest(input), manifest);
    }
    await assert.rejects(
      () => store.createShadowManifest({ ...input, queryText: "different execution input" }),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_SOURCE_CONFLICT"
    );

    const database = new DatabaseSync(path);
    const persisted = database.prepare(`
      SELECT cli_injection_enabled FROM memory_shadow_manifests WHERE manifest_id = ?
    `).get(manifest.manifestId) as { cli_injection_enabled: number };
    assert.equal(persisted.cli_injection_enabled, 0);
    assert.throws(
      () => database.prepare(`
        UPDATE memory_shadow_manifests SET candidate_count = 0 WHERE manifest_id = ?
      `).run(manifest.manifestId),
      /shadow manifests are immutable/
    );
    assert.throws(
      () => database.prepare(`
        UPDATE memory_shadow_candidates SET score = 0 WHERE manifest_id = ?
      `).run(manifest.manifestId),
      /shadow candidates are immutable/
    );
    const manifestColumns = (database.prepare("PRAGMA table_info(memory_shadow_manifests)").all() as Array<{
      name: string;
    }>).map((column) => column.name);
    const candidateColumns = (database.prepare("PRAGMA table_info(memory_shadow_candidates)").all() as Array<{
      name: string;
    }>).map((column) => column.name);
    assert.equal(manifestColumns.includes("query_text"), false);
    assert.equal(manifestColumns.includes("prompt"), false);
    assert.equal(candidateColumns.includes("content"), false);
    database.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Shadow Retrieval enforces the prospective 8 item and 12 KiB context budgets", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-shadow-budget-"));
  const featureTime = "2026-08-20T00:00:00.000Z";
  const store = new SqliteStructuredTaskMemoryStore({
    path: join(root, "collaboration-memory-v2.sqlite"),
    now: () => new Date(featureTime)
  });
  try {
    await store.initialize();
    for (let stageIndex = 1; stageIndex <= 4; stageIndex += 1) {
      await store.saveStage(stageInput("task-budget", `artifact-budget-${stageIndex}`, featureTime, {
        stageId: `stage:${stageIndex}`,
        stageIndex,
        executionTaskId: `lh_task-budget_${stageIndex}`,
        content: String(stageIndex).repeat(4 * 1_024)
      }));
    }
    const manifest = await store.createShadowManifest({
      schemaVersion: 1,
      executionId: "lh_task-budget_5:epoch:1",
      taskId: "task-budget",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "",
      generatedAt: "2026-08-21T00:00:00.000Z"
    });
    assert.equal(manifest.scopeCandidateCounts.task, 4);
    assert.equal(manifest.candidateCount, 3);
    assert.equal(manifest.candidateBytes, 12 * 1_024);
    assert.ok(manifest.candidateCount <= 8);
    assert.ok(manifest.candidateBytes <= 12 * 1_024);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a schema v1 task ledger migrates to v2 and backfills its FTS shadow index", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-shadow-migration-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const featureTime = "2026-08-20T00:00:00.000Z";
  const initial = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(featureTime)
  });
  await initial.initialize();
  await initial.saveStage(stageInput("task-migrated", "artifact-migrated", featureTime, {
    content: "Migrated deployment constraint"
  }));
  await initial.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DROP TRIGGER memory_shadow_candidates_no_update;
    DROP TRIGGER memory_shadow_manifests_no_update;
    DROP TABLE memory_shadow_candidates;
    DROP TABLE memory_shadow_manifests;
    DROP TABLE long_horizon_task_memory_fts;
    DROP INDEX long_horizon_task_memory_child_task_created;
    DROP INDEX long_horizon_task_memory_child_workspace_created;
    DROP INDEX long_horizon_task_memory_child_peer_created;
    DELETE FROM schema_migrations WHERE version = 2;
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const migrated = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date("2026-08-21T00:00:00.000Z")
  });
  try {
    const manifest = await migrated.createShadowManifest({
      schemaVersion: 1,
      executionId: "lh_task-migrated_2:epoch:1",
      taskId: "task-migrated",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "deployment constraint",
      generatedAt: "2026-08-21T00:00:00.000Z"
    });
    assert.equal(manifest.candidateCount, 1);
    assert.ok(manifest.candidates[0]?.reasons.includes("keyword_match"));
    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    assert.deepEqual(
      (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>).map((row) => row.version),
      [1, 2]
    );
    database.close();
  } finally {
    await migrated.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Shadow Retrieval stays deterministic and bounded with 5,000 scoped memories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teti-shadow-scale-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const featureTime = "2026-08-20T00:00:00.000Z";
  const initial = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(featureTime)
  });
  await initial.initialize();
  await initial.close();

  const database = new DatabaseSync(path);
  const insertMemory = database.prepare(`
    INSERT INTO long_horizon_task_memory (
      memory_id, task_id, peer_teti_id, workspace_id, stage_id, stage_index,
      execution_task_id, execution_epoch, child_agent_id, connector_id,
      artifact_id, workspace_revision, kind, trust, content, content_digest,
      created_at, captured_at
    ) VALUES (?, ?, 'teti_peer00001', 'workspace:scale', 'stage:1', 1,
      ?, 1, 'codex', 'codex.process', ?, 1, 'stage_handoff',
      'peer_originated_reference', ?, ?, ?, ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO long_horizon_task_memory_fts (memory_id, content) VALUES (?, ?)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 5_000; index += 1) {
      const memoryId = `memory:scale:${index}`;
      const taskId = `task-scale-${index}`;
      const content = `Scale deployment constraint ${index}`;
      const contentDigest = createHash("sha256").update(content).digest("hex");
      insertMemory.run(
        memoryId,
        taskId,
        `lh_${taskId}_1`,
        `artifact-scale-${index}`,
        content,
        contentDigest,
        featureTime,
        featureTime
      );
      insertFts.run(memoryId, content);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }

  const store = new SqliteStructuredTaskMemoryStore({ path });
  try {
    const durations: number[] = [];
    let firstDigest: string | null = null;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const startedAt = performance.now();
      const manifest = await store.createShadowManifest({
        schemaVersion: 1,
        executionId: `lh_task-scale-0_2:epoch:${iteration + 1}`,
        taskId: "task-scale-0",
        peerTetiId: "teti_peer00001",
        workspaceId: "workspace:scale",
        childAgentId: "codex",
        queryText: "deployment constraint",
        generatedAt: "2026-08-21T00:00:00.000Z"
      });
      durations.push(performance.now() - startedAt);
      assert.deepEqual(manifest.scopeCandidateCounts, {
        task: 1,
        workspace: 4_999,
        peer: 0
      });
      assert.equal(manifest.candidateCount, 8);
      assert.ok(manifest.candidateBytes <= 12 * 1_024);
      const selectionDigest = createHash("sha256")
        .update(JSON.stringify(manifest.candidates.map((candidate) => ({
          memoryId: candidate.memoryId,
          rank: candidate.rank,
          score: candidate.score,
          reasons: candidate.reasons
        }))))
        .digest("hex");
      firstDigest ??= selectionDigest;
      assert.equal(selectionDigest, firstDigest);
    }
    const coldQueryMs = durations[0] ?? Number.POSITIVE_INFINITY;
    const warmDurations = durations.slice(1).sort((left, right) => left - right);
    const warmP95Ms = warmDurations[Math.ceil(warmDurations.length * 0.95) - 1]
      ?? Number.POSITIVE_INFINITY;
    const strictBenchmark = process.env.TETI_STRICT_MEMORY_BENCHMARK === "1";
    const coldLimitMs = strictBenchmark ? 150 : 500;
    const warmP95LimitMs = strictBenchmark ? 40 : 250;
    context.diagnostic(`5,000-memory Shadow Retrieval (${strictBenchmark ? "strict" : "shared-run"}): cold=${coldQueryMs.toFixed(2)}ms, warm-p95=${warmP95Ms.toFixed(2)}ms`);
    assert.ok(
      coldQueryMs <= coldLimitMs,
      `cold query ${coldQueryMs.toFixed(2)}ms exceeded ${coldLimitMs}ms`
    );
    assert.ok(
      warmP95Ms <= warmP95LimitMs,
      `warm P95 ${warmP95Ms.toFixed(2)}ms exceeded ${warmP95LimitMs}ms`
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown future SQLite schema fails closed without rebuilding the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-structured-memory-future-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const future = new DatabaseSync(path);
  future.exec("PRAGMA user_version = 3");
  future.close();
  const store = new SqliteStructuredTaskMemoryStore({ path });
  try {
    await assert.rejects(
      () => store.initialize(),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_STORE_UNAVAILABLE"
    );
    const preserved = new DatabaseSync(path, { readOnly: true });
    assert.equal((preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    preserved.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function stageInput(
  taskId: string,
  artifactId: string,
  taskCreatedAt: string,
  overrides: Partial<LongHorizonStageMemoryInput> = {}
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
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides
  };
}
