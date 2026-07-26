import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileTaskAttachmentStore } from "../lifecycle-sidecar/runtime/tasks/attachments.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("Task attachment store stages a private bounded PNG without exposing its source path", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-attachments-"));
  const source = join(root, "selected.png");
  await writeFile(source, ONE_PIXEL_PNG);
  const store = new FileTaskAttachmentStore(join(root, "private"));

  const staged = await store.stageImage(source);

  assert.equal(staged.part.mimeType, "image/png");
  assert.equal(staged.part.width, 1);
  assert.equal(staged.part.height, 1);
  assert.match(staged.part.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(staged.part).includes(source), false);
  assert.equal((await stat(staged.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(staged.path), ONE_PIXEL_PNG);
  assert.deepEqual((await store.getStagedImage(staged.part)).part, staged.part);
});

test("Task attachment ingestion is digest-bound and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-ingest-"));
  const source = join(root, "selected.png");
  await writeFile(source, ONE_PIXEL_PNG);
  const store = new FileTaskAttachmentStore(join(root, "private"));
  const staged = await store.stageImage(source);

  const first = await store.ingestImage({
    taskId: "task-001",
    purpose: "input",
    part: staged.part,
    sourcePath: staged.path
  });
  const second = await store.ingestImage({
    taskId: "task-001",
    purpose: "input",
    part: staged.part,
    sourcePath: staged.path
  });

  assert.equal(second, first);
  assert.equal(await store.resolveImage({ taskId: "task-001", purpose: "input", part: staged.part }), first);
  await assert.rejects(() => store.ingestImage({
    taskId: "task-002",
    purpose: "input",
    part: { ...staged.part, sha256: `sha256:${"0".repeat(64)}` },
    sourcePath: staged.path
  }), /TASK_ATTACHMENT_MISMATCH/);
});

test("Task attachment ingestion enforces the four-image per-task quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-quota-"));
  const source = join(root, "selected.png");
  await writeFile(source, ONE_PIXEL_PNG);
  const store = new FileTaskAttachmentStore(join(root, "private"));
  const staged = await store.stageImage(source);

  for (let index = 0; index < 4; index += 1) {
    await store.ingestImage({
      taskId: "task-quota",
      purpose: "input",
      part: { ...staged.part, attachmentId: `image-${index}` },
      sourcePath: staged.path
    });
  }
  await assert.rejects(() => store.ingestImage({
    taskId: "task-quota",
    purpose: "input",
    part: { ...staged.part, attachmentId: "image-4" },
    sourcePath: staged.path
  }), /TASK_ATTACHMENT_QUOTA_EXCEEDED/);
});

test("Task attachment cleanup removes expired private files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-cleanup-"));
  const source = join(root, "selected.png");
  await writeFile(source, ONE_PIXEL_PNG);
  const store = new FileTaskAttachmentStore(join(root, "private"));
  const staged = await store.stageImage(source);
  const old = new Date("2026-07-24T00:00:00.000Z");
  await utimes(staged.path, old, old);

  await store.cleanup(new Date("2026-07-26T00:00:00.000Z"));

  await assert.rejects(() => stat(staged.path), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  ));
  assert.deepEqual(await readFile(source), ONE_PIXEL_PNG);
});
