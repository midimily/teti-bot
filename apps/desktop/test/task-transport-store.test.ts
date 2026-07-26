import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTaskTransportStore,
  emptyTaskTransportStoreState
} from "../lifecycle-sidecar/runtime/tasks/store.ts";

test("Task transport store is private, atomic, and fails closed on corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-store-"));
  const path = join(root, "tasks.json");
  const store = new FileTaskTransportStore(path);
  try {
    await store.save(emptyTaskTransportStoreState());
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, "utf8"), /token|credential|privateKey/);

    await writeFile(path, '{"schemaVersion":1,"records":"damaged","peers":[]}\n', "utf8");
    await assert.rejects(() => store.load(), /records are invalid/);

    await writeFile(path, '{"schemaVersion":1,"records":[],"peers":[],"token":"leak"}\n', "utf8");
    await assert.rejects(() => store.load(), /unsupported field/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
