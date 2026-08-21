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

const FEATURE_TIME = "2026-08-20T00:00:00.000Z";

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

test("Structured Memory requires confirmation, exact authorization, preview, and one-shot approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-context-injection-"));
  const path = join(root, "collaboration-memory-v3.sqlite");
  const featureTime = "2026-08-20T00:00:00.000Z";
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(featureTime)
  });
  let deletedPeerMemoryId = "";
  try {
    await store.initialize();
    const sources = [
      stageInput("task-current", "artifact-task", featureTime, {
        content: "Current task deployment decision"
      }),
      stageInput("task-workspace", "artifact-workspace", featureTime, {
        content: "Workspace deployment constraint"
      }),
      stageInput("task-peer", "artifact-peer", featureTime, {
        workspaceId: "workspace:other",
        content: "Peer deployment fact"
      }),
      stageInput("task-foreign", "artifact-foreign", featureTime, {
        peerTetiId: "teti_foreign0001",
        workspaceId: "workspace:foreign",
        content: "Foreign peer secret"
      }),
      stageInput("task-other-child", "artifact-other-child", featureTime, {
        childAgentId: "codebuddy",
        content: "Other Child secret"
      })
    ];
    for (const source of sources) await store.saveStage(source);
    const sourceIds = new Map(sources.map((source) => [
      source.taskId,
      store.getTaskSnapshot(source.taskId).then((snapshot) => snapshot.records[0]!.memoryId)
    ]));
    const sourceId = async (taskId: string) => await sourceIds.get(taskId)!;

    const taskItem = await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: await sourceId("task-current"),
      scope: "task",
      kind: "decision",
      title: "Deployment decision",
      content: "Use a blue-green deployment for the current task.",
      pinned: true,
      confirmed: true,
      changedAt: "2026-08-20T01:00:00.000Z"
    });
    const workspaceItem = await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: await sourceId("task-workspace"),
      scope: "workspace",
      kind: "constraint",
      title: "Workspace constraint",
      content: "Keep the deployment manifest in the current workspace.",
      pinned: false,
      confirmed: true,
      changedAt: "2026-08-20T01:01:00.000Z"
    });
    const peerItem = await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: await sourceId("task-peer"),
      scope: "peer",
      kind: "fact",
      title: "Peer preference",
      content: "This peer prefers a deployment summary before rollout.",
      pinned: false,
      confirmed: true,
      changedAt: "2026-08-20T01:02:00.000Z"
    });
    deletedPeerMemoryId = peerItem.memoryId;
    await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: await sourceId("task-foreign"),
      scope: "peer",
      kind: "local_note",
      title: "Foreign",
      content: "Never visible to the current peer.",
      pinned: false,
      confirmed: true,
      changedAt: "2026-08-20T01:03:00.000Z"
    });
    await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: await sourceId("task-other-child"),
      scope: "workspace",
      kind: "local_note",
      title: "Other Child",
      content: "Never visible to the current Child.",
      pinned: false,
      confirmed: true,
      changedAt: "2026-08-20T01:04:00.000Z"
    });

    const previewInput = {
      schemaVersion: 1 as const,
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "Review the deployment decision and constraint",
      excludedMemoryIds: [] as string[],
      generatedAt: "2026-08-21T00:00:00.000Z"
    };
    const defaultPreview = await store.createContextPreview(previewInput);
    assert.deepEqual(defaultPreview.candidates.map((item) => item.memoryId), [taskItem.memoryId]);
    assert.equal(defaultPreview.scopeAuthorizations.find((item) => item.scope === "peer")?.enabled, false);
    assert.equal(defaultPreview.cliInjectionEnabled, false);

    await store.setStructuredMemoryAuthorization({
      schemaVersion: 1,
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      scope: "workspace",
      enabled: true,
      changedAt: "2026-08-21T00:01:00.000Z"
    });
    await store.setStructuredMemoryAuthorization({
      schemaVersion: 1,
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      scope: "peer",
      enabled: true,
      changedAt: "2026-08-21T00:02:00.000Z"
    });
    const preview = await store.createContextPreview({
      ...previewInput,
      excludedMemoryIds: [workspaceItem.memoryId],
      generatedAt: "2026-08-21T00:03:00.000Z"
    });
    assert.deepEqual(new Set(preview.candidates.map((item) => item.memoryId)), new Set([
      taskItem.memoryId,
      workspaceItem.memoryId,
      peerItem.memoryId
    ]));
    assert.equal(preview.candidates.find((item) => item.memoryId === workspaceItem.memoryId)?.included, false);
    assert.deepEqual(preview.candidates.filter((item) => item.included).map((item) => item.memoryId), [
      taskItem.memoryId,
      peerItem.memoryId
    ]);

    await store.approveContextPreview({
      taskId: "task-current",
      previewId: preview.previewId,
      approvedAt: "2026-08-21T00:04:00.000Z"
    });
    const selection = await store.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-current_2:epoch:1",
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: previewInput.queryText,
      generatedAt: "2026-08-21T00:05:00.000Z"
    });
    assert.equal(selection.manifest?.cliInjectionEnabled, true);
    assert.deepEqual(selection.records.map((record) => record.memoryId), [
      taskItem.memoryId,
      peerItem.memoryId
    ]);
    assert.equal((await store.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-current_3:epoch:1",
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: previewInput.queryText,
      generatedAt: "2026-08-21T00:06:00.000Z"
    })).manifest, null);

    const stalePreview = await store.createContextPreview({
      ...previewInput,
      generatedAt: "2026-08-21T00:07:00.000Z"
    });
    await store.approveContextPreview({
      taskId: "task-current",
      previewId: stalePreview.previewId,
      approvedAt: "2026-08-21T00:08:00.000Z"
    });
    const updated = await store.updateStructuredMemoryItem({
      schemaVersion: 1,
      memoryId: taskItem.memoryId,
      expectedVersion: 1,
      scope: "task",
      kind: "decision",
      title: "Deployment decision v2",
      content: "Use a canary deployment after local review.",
      pinned: false,
      confirmed: true,
      changedAt: "2026-08-21T00:09:00.000Z"
    });
    assert.equal(updated.version, 2);
    assert.equal((await store.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-current_4:epoch:1",
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: previewInput.queryText,
      generatedAt: "2026-08-21T00:10:00.000Z"
    })).manifest, null);

    assert.equal(await store.deleteStructuredMemoryItem({
      memoryId: peerItem.memoryId,
      confirmed: true,
      deletedAt: "2026-08-21T00:11:00.000Z"
    }), true);
    assert.equal(await store.getStructuredMemoryItem({ memoryId: peerItem.memoryId }), null);
    assert.equal((await store.getTaskSnapshot("task-current")).latestInjectionManifest?.candidateCount, 2);
    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_versions WHERE memory_id = ?
    `).get(taskItem.memoryId) as { count: number }).count, 2);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_deletions WHERE memory_id = ?
    `).get(peerItem.memoryId) as { count: number }).count, 1);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_items_fts WHERE memory_id = ?
    `).get(peerItem.memoryId) as { count: number }).count, 0);
    database.close();

    await store.setStructuredMemoryAuthorization({
      schemaVersion: 1,
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      scope: "peer",
      enabled: false,
      changedAt: "2026-08-21T00:12:00.000Z"
    });
  } finally {
    await store.close();
  }

  const reopened = new SqliteStructuredTaskMemoryStore({ path });
  try {
    const preview = await reopened.createContextPreview({
      schemaVersion: 1,
      taskId: "task-current",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "deployment",
      excludedMemoryIds: [],
      generatedAt: "2026-08-21T00:13:00.000Z"
    });
    assert.equal(preview.scopeAuthorizations.find((item) => item.scope === "peer")?.enabled, false);
    assert.equal(preview.candidates.some((item) => item.memoryId === deletedPeerMemoryId), false);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a schema v1 task ledger backs up and migrates through v4", async () => {
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
    DROP TRIGGER structured_memory_maintenance_events_no_update;
    DROP TABLE structured_memory_maintenance_events;
    DROP TABLE structured_memory_metrics;
    DROP TRIGGER structured_memory_injection_candidates_no_update;
    DROP TRIGGER structured_memory_injection_manifests_no_update;
    DROP TRIGGER structured_memory_deletions_no_update;
    DROP TRIGGER structured_memory_versions_no_update;
    DROP TABLE structured_memory_injection_candidates;
    DROP TABLE structured_memory_injection_manifests;
    DROP TABLE structured_memory_preview_candidates;
    DROP TABLE structured_memory_previews;
    DROP TABLE structured_memory_deletions;
    DROP TABLE structured_memory_authorizations;
    DROP TABLE structured_memory_items_fts;
    DROP TABLE structured_memory_versions;
    DROP TABLE structured_memory_items;
    DROP TRIGGER memory_shadow_candidates_no_update;
    DROP TRIGGER memory_shadow_manifests_no_update;
    DROP TABLE memory_shadow_candidates;
    DROP TABLE memory_shadow_manifests;
    DROP TABLE long_horizon_task_memory_fts;
    DROP INDEX long_horizon_task_memory_child_task_created;
    DROP INDEX long_horizon_task_memory_child_workspace_created;
    DROP INDEX long_horizon_task_memory_child_peer_created;
    DELETE FROM schema_migrations WHERE version IN (2, 3, 4);
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
    assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    assert.deepEqual(
      (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>).map((row) => row.version),
      [1, 2, 3, 4]
    );
    assert.equal((await migrated.getHealth()).recoveryBackupAvailable, true);
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

test("approved Structured Memory preview stays deterministic and bounded with 5,000 items", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teti-context-scale-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const initial = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME)
  });
  await initial.initialize();
  await initial.close();

  const database = new DatabaseSync(path);
  const insertSource = database.prepare(`
    INSERT INTO long_horizon_task_memory (
      memory_id, task_id, peer_teti_id, workspace_id, stage_id, stage_index,
      execution_task_id, execution_epoch, child_agent_id, connector_id,
      artifact_id, workspace_revision, kind, trust, content, content_digest,
      created_at, captured_at
    ) VALUES (?, ?, 'teti_peer00001', 'workspace:context-scale', 'stage:1', 1,
      ?, 1, 'codex', 'codex.process', ?, 1, 'stage_handoff',
      'peer_originated_reference', ?, ?, ?, ?)
  `);
  const insertRawFts = database.prepare(`
    INSERT INTO long_horizon_task_memory_fts (memory_id, content) VALUES (?, ?)
  `);
  const insertItem = database.prepare(`
    INSERT INTO structured_memory_items (
      memory_id, source_memory_id, source_task_id, peer_teti_id,
      workspace_id, child_agent_id, current_version, trust,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'teti_peer00001', 'workspace:context-scale',
      'codex', 1, 'local_user_confirmed', ?, ?, NULL)
  `);
  const insertVersion = database.prepare(`
    INSERT INTO structured_memory_versions (
      memory_id, version, scope, kind, title, content, content_digest,
      pinned, editor, created_at
    ) VALUES (?, 1, 'workspace', 'constraint', ?, ?, ?, 0, 'local_user', ?)
  `);
  const insertFts = database.prepare(`
    INSERT INTO structured_memory_items_fts (memory_id, title, content) VALUES (?, ?, ?)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 5_000; index += 1) {
      const sourceMemoryId = `memory:context-scale:${index}`;
      const memoryId = `item:context-scale:${index}`;
      const taskId = `task-context-scale-${index}`;
      const title = `Deployment constraint ${index}`;
      const content = `Use bounded rollout policy ${index}`;
      const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      insertSource.run(
        sourceMemoryId,
        taskId,
        `lh_${taskId}_1`,
        `artifact-context-scale-${index}`,
        content,
        contentDigest,
        FEATURE_TIME,
        FEATURE_TIME
      );
      insertRawFts.run(sourceMemoryId, content);
      insertItem.run(memoryId, sourceMemoryId, taskId, FEATURE_TIME, FEATURE_TIME);
      insertVersion.run(memoryId, title, content, contentDigest, FEATURE_TIME);
      insertFts.run(memoryId, title, content);
    }
    database.prepare(`
      INSERT INTO structured_memory_authorizations (
        scope, scope_key, workspace_id, peer_teti_id, child_agent_id,
        enabled, authorized_at, revoked_at
      ) VALUES ('workspace', 'workspace:context-scale', 'workspace:context-scale',
        NULL, 'codex', 1, ?, NULL)
    `).run(FEATURE_TIME);
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
    let firstSelection: string | null = null;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const startedAt = performance.now();
      const preview = await store.createContextPreview({
        schemaVersion: 1,
        taskId: "task-context-scale-0",
        peerTetiId: "teti_peer00001",
        workspaceId: "workspace:context-scale",
        childAgentId: "codex",
        queryText: "deployment constraint bounded rollout",
        excludedMemoryIds: [],
        generatedAt: "2026-08-21T00:00:00.000Z"
      });
      durations.push(performance.now() - startedAt);
      assert.equal(preview.candidateCount, 8);
      assert.equal(preview.candidates.length, 16);
      assert.ok(preview.candidateBytes <= 12 * 1_024);
      const selection = JSON.stringify(preview.candidates.map((candidate) => ({
        memoryId: candidate.memoryId,
        included: candidate.included,
        rank: candidate.rank,
        score: candidate.score
      })));
      firstSelection ??= selection;
      assert.equal(selection, firstSelection);
    }
    const coldQueryMs = durations[0] ?? Number.POSITIVE_INFINITY;
    const warmDurations = durations.slice(1).sort((left, right) => left - right);
    const warmP95Ms = warmDurations[Math.ceil(warmDurations.length * 0.95) - 1]
      ?? Number.POSITIVE_INFINITY;
    const strictBenchmark = process.env.TETI_STRICT_MEMORY_BENCHMARK === "1";
    const coldLimitMs = strictBenchmark ? 150 : 500;
    const warmP95LimitMs = strictBenchmark ? 40 : 250;
    context.diagnostic(`5,000-item Structured Memory preview (${strictBenchmark ? "strict" : "shared-run"}): cold=${coldQueryMs.toFixed(2)}ms, warm-p95=${warmP95Ms.toFixed(2)}ms`);
    assert.ok(coldQueryMs <= coldLimitMs);
    assert.ok(warmP95Ms <= warmP95LimitMs);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown future SQLite schema fails closed without rebuilding the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-structured-memory-future-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const future = new DatabaseSync(path);
  future.exec("PRAGMA user_version = 5");
  future.close();
  const store = new SqliteStructuredTaskMemoryStore({ path });
  try {
    await store.initialize();
    assert.deepEqual(
      await store.getHealth().then((health) => [health.mode, health.migrationStatus]),
      ["read_only", "future_schema_read_only"]
    );
    await assert.rejects(
      () => store.saveStage(stageInput("future-task", "future-artifact", new Date().toISOString())),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_STORE_READ_ONLY"
    );
    const preserved = new DatabaseSync(path, { readOnly: true });
    assert.equal((preserved.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
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
