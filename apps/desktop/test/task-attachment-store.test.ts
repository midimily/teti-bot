import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTaskAttachmentStore,
  isAbsoluteTaskAttachmentPath
} from "../lifecycle-sidecar/runtime/tasks/attachments.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("Task attachment paths use the host platform absolute-path rules", () => {
  assert.equal(isAbsoluteTaskAttachmentPath("/Users/teti/image.png", "darwin"), true);
  assert.equal(isAbsoluteTaskAttachmentPath("relative/image.png", "darwin"), false);
  assert.equal(isAbsoluteTaskAttachmentPath("C:\\Users\\teti\\image.png", "win32"), true);
  assert.equal(isAbsoluteTaskAttachmentPath("C:image.png", "win32"), false);
  assert.equal(isAbsoluteTaskAttachmentPath("\\\\server\\share\\image.png", "win32"), false);
});

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

test("Task attachment writes reject a symlink or junction that leaves the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-containment-"));
  const source = join(root, "selected.png");
  const storeRoot = join(root, "private");
  const outside = join(root, "outside");
  await writeFile(source, ONE_PIXEL_PNG);
  await mkdir(storeRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(storeRoot, "staged"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    () => new FileTaskAttachmentStore(storeRoot).stageImage(source),
    /TASK_ATTACHMENT_PATH_OUTSIDE_STORE/
  );
  await assert.rejects(() => stat(join(outside, "unexpected.png")), /ENOENT/);
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

test("Task v7 Artifact document is private, bounded, and rejected after byte tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-artifact-document-"));
  const store = new FileTaskAttachmentStore(join(root, "private"));
  const artifact = {
    schemaVersion: 2 as const,
    taskId: "task-artifact-001",
    artifactId: "artifact-001",
    parts: [{ kind: "text" as const, text: `large-result:${"结果".repeat(2_000)}` }],
    createdAt: "2026-08-13T02:11:19.201Z"
  };
  const staged = await store.stageArtifactDocument(artifact.taskId, artifact);
  const descriptor = {
    schemaVersion: 1 as const,
    taskId: artifact.taskId,
    requesterTetiId: "teti_sender001",
    targetTetiId: "teti_target001",
    artifactId: artifact.artifactId,
    byteLength: staged.byteLength,
    sha256: staged.sha256,
    createdAt: artifact.createdAt,
    expiresAt: "2026-08-13T03:11:19.201Z",
    deliveryReceiptRequested: true as const
  };

  assert.equal((await stat(staged.path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.readArtifactDocument(staged.path, descriptor), artifact);
  await writeFile(staged.path, Buffer.from("tampered", "utf8"));
  await assert.rejects(
    () => store.readArtifactDocument(staged.path, descriptor),
    /SIZE_MISMATCH|DIGEST_MISMATCH/
  );
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
