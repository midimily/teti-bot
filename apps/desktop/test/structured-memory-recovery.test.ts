import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { LongHorizonStageMemoryInput } from "../../../core/memory/structured-task.ts";
import {
  restoreStructuredTaskMemoryBackup,
  SqliteStructuredTaskMemoryStore,
  StructuredTaskMemoryStoreError
} from "../lifecycle-sidecar/runtime/memory/structured-task-sqlite.ts";

const FEATURE_TIME = "2026-08-20T00:00:00.000Z";

test("a health-only cold start stays ready without changing an existing parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-health-cold-start-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const expectedParentMode = process.platform === "win32" ? null : 0o755;
  if (expectedParentMode !== null) await chmod(root, expectedParentMode);
  const store = new SqliteStructuredTaskMemoryStore({ path });
  try {
    const health = await store.getHealth();
    assert.equal(health.mode, "ready");
    assert.equal(health.migrationStatus, "created");
    assert.equal(health.integrity, "ok");
    assert.equal(health.foreignKeys, "ok");
    if (expectedParentMode !== null) {
      assert.equal((await stat(root)).mode & 0o777, expectedParentMode);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("0.5.3 WAL recovery survives an abnormal Sidecar exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-wal-recovery-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "apps/desktop/lifecycle-sidecar/runtime/memory/structured-task-sqlite.ts"
  )).href;
  const script = `
    import { SqliteStructuredTaskMemoryStore } from ${JSON.stringify(moduleUrl)};
    const store = new SqliteStructuredTaskMemoryStore({
      path: ${JSON.stringify(path)},
      now: () => new Date(${JSON.stringify(FEATURE_TIME)})
    });
    await store.initialize();
    await store.saveStage(${JSON.stringify(stageInput("task-crash", "artifact-crash"))});
    process.exit(0);
  `;
  try {
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script
    ], { stdio: "pipe" });
    const recovered = new SqliteStructuredTaskMemoryStore({ path });
    try {
      assert.equal((await recovered.getTaskSnapshot("task-crash")).recordCount, 1);
      assert.deepEqual(
        await recovered.getHealth().then((health) => [health.mode, health.integrity, health.journalMode]),
        ["ready", "ok", "wal"]
      );
    } finally {
      await recovered.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified export and restore preserve the chosen rollback point and a safety backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-backup-restore-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const exportPath = join(root, "exports", "memory-rollback.sqlite");
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME)
  });
  try {
    await store.saveStage(stageInput("task-before-backup", "artifact-before-backup"));
    const backupReport = await store.exportBackup(exportPath, {
      confirmed: true,
      createdAt: "2026-08-20T01:00:00.000Z"
    });
    assert.equal(backupReport.integrity, "ok");
    assert.equal(backupReport.sourceSchemaVersion, 4);
    assert.match(backupReport.sha256, /^sha256:[a-f0-9]{64}$/u);
    if (process.platform !== "win32") {
      assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
    }
    await store.saveStage(stageInput("task-after-backup", "artifact-after-backup"));
  } finally {
    await store.close();
  }

  try {
    const restore = await restoreStructuredTaskMemoryBackup({
      databasePath: path,
      backupPath: exportPath,
      confirmed: true,
      restoredAt: "2026-08-20T02:00:00.000Z"
    });
    assert.equal(restore.integrity, "ok");
    assert.equal(restore.restoredSchemaVersion, 4);
    assert.equal(restore.safetyBackupCreated, true);
    assert.ok((await readdir(`${path}.recovery`)).some((name) => name.startsWith("pre-restore-")));

    const restored = new SqliteStructuredTaskMemoryStore({ path });
    try {
      assert.equal((await restored.getTaskSnapshot("task-before-backup")).recordCount, 1);
      assert.equal((await restored.getTaskSnapshot("task-after-backup")).recordCount, 0);
    } finally {
      await restored.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controlled expiry and delete cleanup remove all active and source text without resurrection", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-cleanup-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const secret = "RC_EXPIRED_TEXT_MUST_BE_PHYSICALLY_CLEANED";
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME)
  });
  let sourceMemoryId = "";
  try {
    await store.saveStage(stageInput("task-expiry", "artifact-expiry", { content: secret }));
    sourceMemoryId = (await store.getTaskSnapshot("task-expiry")).records[0]!.memoryId;
    const item = await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId,
      scope: "task",
      kind: "constraint",
      title: "Temporary constraint",
      content: secret,
      pinned: false,
      expiresAt: "2026-08-20T02:00:00.000Z",
      confirmed: true,
      changedAt: "2026-08-20T01:00:00.000Z"
    });
    const preview = await store.createContextPreview({
      schemaVersion: 1,
      taskId: "task-expiry",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "temporary constraint",
      excludedMemoryIds: [],
      generatedAt: "2026-08-20T01:30:00.000Z"
    });
    assert.equal(preview.candidates[0]?.memoryId, item.memoryId);
    const report = await store.runMaintenance({
      schemaVersion: 1,
      confirmed: true,
      executedAt: "2026-08-22T03:00:00.000Z"
    });
    assert.equal(report.expiredItemCount, 1);
    assert.equal(report.expiredPreviewCount, 1);
    assert.equal(report.integrity, "ok");
    assert.equal((await store.getTaskSnapshot("task-expiry")).recordCount, 0);
    await assert.rejects(
      () => store.createStructuredMemoryItem({
        schemaVersion: 1,
        sourceMemoryId,
        scope: "task",
        kind: "constraint",
        title: "Resurrection attempt",
        content: secret,
        pinned: false,
        confirmed: true,
        changedAt: "2026-08-22T04:00:00.000Z"
      }),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_SOURCE_CONFLICT"
    );
    const health = await store.getHealth();
    assert.equal(health.metrics.expirationSuccessCount, 1);
    assert.doesNotMatch(JSON.stringify(health), /task-expiry|teti_peer|workspace|Temporary/u);
  } finally {
    await store.close();
  }

  try {
    const database = new DatabaseSync(path, { readOnly: true });
    const deletion = database.prepare(`
      SELECT actor, reason_code FROM structured_memory_deletions
      WHERE source_memory_id = ?
    `).get(sourceMemoryId) as { actor: string; reason_code: string };
    assert.equal(deletion.actor, "local_maintenance");
    assert.equal(deletion.reason_code, "expired");
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_items_fts
    `).get() as { count: number }).count, 0);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM long_horizon_task_memory_fts
    `).get() as { count: number }).count, 0);
    database.close();
    assert.equal((await readFile(path)).includes(Buffer.from(secret)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("100 concurrent preview/delete operations leave no ghost injection after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-delete-race-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME)
  });
  try {
    await store.saveStage(stageInput("task-race", "artifact-race", { content: "RACE_GHOST_TEXT" }));
    const source = (await store.getTaskSnapshot("task-race")).records[0]!.memoryId;
    const item = await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: source,
      scope: "task",
      kind: "decision",
      title: "Race decision",
      content: "RACE_GHOST_TEXT",
      pinned: true,
      confirmed: true,
      changedAt: "2026-08-20T01:00:00.000Z"
    });
    const previews = await Promise.all(Array.from({ length: 100 }, () =>
      store.createContextPreview({
        schemaVersion: 1,
        taskId: "task-race",
        peerTetiId: "teti_peer00001",
        workspaceId: "workspace:task-memory",
        childAgentId: "codex",
        queryText: "race decision",
        excludedMemoryIds: [],
        generatedAt: "2026-08-20T01:10:00.000Z"
      })
    ));
    const latest = previews.at(-1)!;
    await store.approveContextPreview({
      taskId: "task-race",
      previewId: latest.previewId,
      approvedAt: "2026-08-20T01:11:00.000Z"
    });
    const deleted = await Promise.all(Array.from({ length: 100 }, () =>
      store.deleteStructuredMemoryItem({
        memoryId: item.memoryId,
        confirmed: true,
        deletedAt: "2026-08-20T01:12:00.000Z"
      })
    ));
    assert.equal(deleted.filter(Boolean).length, 1);
    await store.saveStage(stageInput("task-race", "artifact-race", { content: "RACE_GHOST_TEXT" }));
    const shadow = await store.createShadowManifest({
      schemaVersion: 1,
      executionId: "lh_task-race_2:shadow:1",
      taskId: "task-race",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "race decision",
      generatedAt: "2026-08-20T01:12:30.000Z"
    });
    assert.equal(shadow.candidateCount, 0);
    assert.equal((await store.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-race_2:epoch:1",
      taskId: "task-race",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "race decision",
      generatedAt: "2026-08-20T01:13:00.000Z"
    })).manifest, null);
  } finally {
    await store.close();
  }
  const reopened = new SqliteStructuredTaskMemoryStore({ path });
  try {
    assert.equal((await reopened.getTaskSnapshot("task-race")).items?.length, 0);
    assert.equal((await reopened.getHealth()).metrics.deletionSuccessCount, 1);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart reuses only the same execution manifest and a new epoch requires a new approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-manifest-restart-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const store = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME)
  });
  let manifestId = "";
  try {
    await store.saveStage(stageInput("task-manifest", "artifact-manifest"));
    const source = (await store.getTaskSnapshot("task-manifest")).records[0]!.memoryId;
    await store.createStructuredMemoryItem({
      schemaVersion: 1,
      sourceMemoryId: source,
      scope: "task",
      kind: "constraint",
      title: "Restart constraint",
      content: "Preserve the approved restart boundary.",
      pinned: true,
      confirmed: true,
      changedAt: "2026-08-20T01:00:00.000Z"
    });
    const preview = await store.createContextPreview({
      schemaVersion: 1,
      taskId: "task-manifest",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "restart boundary",
      excludedMemoryIds: [],
      generatedAt: "2026-08-20T01:10:00.000Z"
    });
    await store.approveContextPreview({
      taskId: "task-manifest",
      previewId: preview.previewId,
      approvedAt: "2026-08-20T01:11:00.000Z"
    });
    const selection = await store.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-manifest_2:epoch:1",
      taskId: "task-manifest",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "restart boundary",
      generatedAt: "2026-08-20T01:12:00.000Z"
    });
    manifestId = selection.manifest!.manifestId;
  } finally {
    await store.close();
  }

  const restarted = new SqliteStructuredTaskMemoryStore({ path });
  try {
    const resumed = await restarted.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-manifest_2:epoch:1",
      taskId: "task-manifest",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "restart boundary",
      generatedAt: "2026-08-20T01:13:00.000Z"
    });
    assert.equal(resumed.manifest?.manifestId, manifestId);
    assert.equal(resumed.records.length, 1);
    await assert.rejects(
      () => restarted.createExecutionContext({
        schemaVersion: 1,
        executionId: "lh_task-manifest_2:epoch:1",
        taskId: "task-manifest",
        peerTetiId: "teti_peer00001",
        workspaceId: "workspace:task-memory",
        childAgentId: "codex",
        queryText: "conflicting execution input",
        generatedAt: "2026-08-20T01:13:30.000Z"
      }),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_SOURCE_CONFLICT"
    );
    const nextEpoch = await restarted.createExecutionContext({
      schemaVersion: 1,
      executionId: "lh_task-manifest_2:epoch:2",
      taskId: "task-manifest",
      peerTetiId: "teti_peer00001",
      workspaceId: "workspace:task-memory",
      childAgentId: "codex",
      queryText: "restart boundary",
      generatedAt: "2026-08-20T01:14:00.000Z"
    });
    assert.equal(nextEpoch.manifest, null);
    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM structured_memory_injection_manifests
    `).get() as { count: number }).count, 1);
    database.close();
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quota failure and migration-evidence damage fail closed without blocking read-only Task history", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-memory-readonly-"));
  const path = join(root, "collaboration-memory-v2.sqlite");
  const quotaStore = new SqliteStructuredTaskMemoryStore({
    path,
    now: () => new Date(FEATURE_TIME),
    maximumDatabaseBytes: 1
  });
  try {
    await quotaStore.initialize();
    assert.equal((await quotaStore.getHealth()).quotaStatus, "exceeded");
    await assert.rejects(
      () => quotaStore.saveStage(stageInput("task-quota", "artifact-quota")),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_STORE_FULL"
    );
  } finally {
    await quotaStore.close();
  }

  const normal = new SqliteStructuredTaskMemoryStore({ path });
  await normal.saveStage(stageInput("task-readable", "artifact-readable"));
  await normal.close();
  const damaged = new DatabaseSync(path);
  damaged.prepare("UPDATE schema_migrations SET checksum = 'damaged' WHERE version = 4").run();
  damaged.close();

  const readOnly = new SqliteStructuredTaskMemoryStore({ path });
  try {
    await readOnly.initialize();
    const health = await readOnly.getHealth();
    assert.equal(health.mode, "read_only");
    assert.equal(health.migrationStatus, "integrity_failure_read_only");
    const snapshot = await readOnly.getTaskSnapshot("task-readable");
    assert.equal(snapshot.status, "read_only");
    assert.equal(snapshot.recordCount, 1);
    await assert.rejects(
      () => readOnly.saveStage(stageInput("task-denied", "artifact-denied")),
      (error: unknown) => error instanceof StructuredTaskMemoryStoreError
        && error.code === "MEMORY_STORE_READ_ONLY"
    );
  } finally {
    await readOnly.close();
    await rm(root, { recursive: true, force: true });
  }
});

function stageInput(
  taskId: string,
  artifactId: string,
  overrides: Partial<LongHorizonStageMemoryInput> = {}
): LongHorizonStageMemoryInput {
  return {
    schemaVersion: 1,
    taskId,
    taskCreatedAt: FEATURE_TIME,
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
    createdAt: FEATURE_TIME,
    ...overrides
  };
}
