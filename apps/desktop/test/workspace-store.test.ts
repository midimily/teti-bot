import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileCollaborationWorkspaceStore,
  WorkspaceStoreError
} from "../lifecycle-sidecar/runtime/workspaces/store.ts";

const ownerTetiId = "teti_owner0001";
const participantTetiId = "teti_peer00001";

test("durable Workspace commits a versioned Snapshot and recovers after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teti-workspace-durable-"));
  context.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const store = new FileCollaborationWorkspaceStore(root);
  await store.initialize();
  const created = await store.create({
    workspaceId: "workspace-durable-001",
    ownerTetiId,
    participantTetiIds: [participantTetiId],
    mode: "durable_collaboration"
  });
  const snapshot = await store.createSnapshot({
    workspaceId: created.workspaceId,
    workspaceRevision: created.revision,
    access: ["read", "write", "create_artifact"]
  });
  await mkdir(join(snapshot.snapshotPath, "src"));
  await writeFile(join(snapshot.snapshotPath, "src", "result.txt"), "durable result", "utf8");
  const committed = await store.commitSnapshot(snapshot);
  assert.equal(committed.revision, 2);
  assert.equal(committed.manifest.totalFiles, 1);
  assert.equal(committed.manifest.entries[0]?.relativePath, "src/result.txt");

  const orphanedRevision = join(
    root,
    "workspaces",
    created.workspaceId,
    "revisions",
    "3",
    "content"
  );
  await mkdir(orphanedRevision, { recursive: true });
  await writeFile(join(orphanedRevision, "uncommitted.txt"), "crash window", "utf8");

  const restarted = new FileCollaborationWorkspaceStore(root);
  await restarted.initialize();
  const recovered = await restarted.get(created.workspaceId);
  assert.equal(recovered?.revision, 2);
  await assert.rejects(() => readFile(join(orphanedRevision, "uncommitted.txt"), "utf8"), /ENOENT/);
  const recoveredSnapshot = await restarted.createSnapshot({
    workspaceId: created.workspaceId,
    workspaceRevision: 2,
    access: ["read"]
  });
  assert.equal(await readFile(join(recoveredSnapshot.snapshotPath, "src", "result.txt"), "utf8"), "durable result");
  await restarted.discardSnapshot(recoveredSnapshot);
});

test("Snapshot commits are optimistic and reject stale concurrent revisions", async (context) => {
  const { root, store, workspaceId } = await workspaceFixture("conflict", context);
  void root;
  const first = await store.createSnapshot({ workspaceId, workspaceRevision: 1, access: ["read", "write"] });
  const second = await store.createSnapshot({ workspaceId, workspaceRevision: 1, access: ["read", "write"] });
  await writeFile(join(first.snapshotPath, "first.txt"), "first", "utf8");
  await writeFile(join(second.snapshotPath, "second.txt"), "second", "utf8");
  await store.commitSnapshot(first);
  await assert.rejects(() => store.commitSnapshot(second), (error: unknown) =>
    error instanceof WorkspaceStoreError && error.code === "WORKSPACE_REVISION_CONFLICT"
  );
  await store.discardSnapshot(second);
});

test("Workspace commit rejects symlink escape and enforces byte quota", async (context) => {
  const { root, store, workspaceId } = await workspaceFixture("security", context, { maxBytes: 4, maxFiles: 2 });
  const outside = join(root, "outside-secret.txt");
  await writeFile(outside, "secret", "utf8");
  const linked = await store.createSnapshot({ workspaceId, workspaceRevision: 1, access: ["read", "write"] });
  await symlink(outside, join(linked.snapshotPath, "escape"));
  await assert.rejects(() => store.commitSnapshot(linked), (error: unknown) =>
    error instanceof WorkspaceStoreError && error.code === "WORKSPACE_SYMLINK_FORBIDDEN"
  );
  await store.discardSnapshot(linked);

  const oversized = await store.createSnapshot({ workspaceId, workspaceRevision: 1, access: ["read", "write"] });
  await writeFile(join(oversized.snapshotPath, "large.txt"), "12345", "utf8");
  await assert.rejects(() => store.commitSnapshot(oversized), (error: unknown) =>
    error instanceof WorkspaceStoreError && error.code === "WORKSPACE_QUOTA_EXCEEDED"
  );
  await store.discardSnapshot(oversized);
});

test("startup removes crashed ephemeral Workspaces while retaining durable Workspaces", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teti-workspace-recovery-"));
  context.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const first = new FileCollaborationWorkspaceStore(root);
  await first.initialize();
  const ephemeral = await first.create({
    workspaceId: "workspace-ephemeral-crash",
    ownerTetiId,
    participantTetiIds: [participantTetiId],
    mode: "ephemeral_task"
  });
  const durable = await first.create({
    workspaceId: "workspace-durable-survive",
    ownerTetiId,
    participantTetiIds: [participantTetiId],
    mode: "durable_collaboration"
  });

  const restarted = new FileCollaborationWorkspaceStore(root);
  await restarted.initialize();
  assert.equal(await restarted.get(ephemeral.workspaceId), null);
  assert.equal((await restarted.get(durable.workspaceId))?.workspaceId, durable.workspaceId);
});

test("ephemeral Workspace TTL cleanup removes expired state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "teti-workspace-ttl-"));
  context.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  let now = new Date("2026-07-29T00:00:00.000Z");
  const store = new FileCollaborationWorkspaceStore(root, { now: () => now });
  await store.initialize();
  const workspace = await store.create({
    workspaceId: "workspace-ttl-001",
    ownerTetiId,
    participantTetiIds: [participantTetiId],
    mode: "ephemeral_task",
    retentionPolicy: { kind: "ttl", expiresAt: "2026-07-29T00:01:00.000Z" }
  });
  now = new Date("2026-07-29T00:02:00.000Z");
  await store.cleanup(now);
  assert.equal(await store.get(workspace.workspaceId), null);
});

async function workspaceFixture(
  name: string,
  context: { after(callback: () => Promise<void>): void },
  quota = { maxBytes: 1_024, maxFiles: 16 }
) {
  const root = await mkdtemp(join(tmpdir(), `teti-workspace-${name}-`));
  context.after(async () => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }));
  const store = new FileCollaborationWorkspaceStore(root);
  await store.initialize();
  const workspaceId = `workspace-${name}-001`;
  await store.create({
    workspaceId,
    ownerTetiId,
    participantTetiIds: [participantTetiId],
    mode: "durable_collaboration",
    quota
  });
  return { root, store, workspaceId };
}
