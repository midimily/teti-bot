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

    await writeFile(path, '{"schemaVersion":2,"records":"damaged","peers":[]}\n', "utf8");
    await assert.rejects(() => store.load(), /records are invalid/);

    await writeFile(path, '{"schemaVersion":2,"records":[],"peers":[],"token":"leak"}\n', "utf8");
    await assert.rejects(() => store.load(), /unsupported field/);

    await writeFile(path, '{"schemaVersion":1,"records":[],"peers":[]}\n', "utf8");
    await assert.rejects(() => store.load(), /Unsupported Teti Task transport store/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Task transport store migrates the 0.2.8 schema without importing a remote Delegation Plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-store-migration-"));
  const path = join(root, "tasks.json");
  const store = new FileTaskTransportStore(path);
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 3,
      records: [],
      peers: []
    }), "utf8");
    const migrated = await store.load();
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.records, []);

    await writeFile(path, JSON.stringify({
      schemaVersion: 3,
      records: [],
      peers: [],
      delegationPlan: { injected: true }
    }), "utf8");
    await assert.rejects(() => store.load(), /unsupported field/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
