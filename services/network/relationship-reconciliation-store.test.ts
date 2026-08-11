import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTetiNetworkRelationshipReconciliationStore,
  MemoryTetiNetworkRelationshipReconciliationStore,
  validateRelationshipReconciliationRecord
} from "./relationship-reconciliation-store.ts";

test("Relationship reconciliation store binds an opaque checkpoint to one identity", async () => {
  const store = new MemoryTetiNetworkRelationshipReconciliationStore();
  await store.save({ schemaVersion: 1, tetiId: "teti_aaaaaaaaa", checkpoint: "rcp_checkpoint" });
  assert.deepEqual(await store.load(), {
    schemaVersion: 1,
    tetiId: "teti_aaaaaaaaa",
    checkpoint: "rcp_checkpoint"
  });
  await store.save({ schemaVersion: 1 });
  assert.deepEqual(await store.load(), { schemaVersion: 1 });
});

test("Relationship reconciliation file store writes atomically with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-relationship-reconciliation-"));
  const path = join(root, "network", "relationship-reconciliation-v1.json");
  const store = new FileTetiNetworkRelationshipReconciliationStore(path);
  try {
    await store.save({
      schemaVersion: 1,
      tetiId: "teti_aaaaaaaaa",
      checkpoint: "rcp_checkpoint"
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /rcp_checkpoint/);
    assert.deepEqual(await store.load(), {
      schemaVersion: 1,
      tetiId: "teti_aaaaaaaaa",
      checkpoint: "rcp_checkpoint"
    });
    await store.save({ schemaVersion: 1 });
    assert.deepEqual(await store.load(), { schemaVersion: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Relationship reconciliation store rejects partial or synthesized bindings", () => {
  assert.throws(
    () => validateRelationshipReconciliationRecord({ schemaVersion: 1, checkpoint: "rcp_checkpoint" }),
    /binding is invalid/
  );
  assert.throws(
    () => validateRelationshipReconciliationRecord({
      schemaVersion: 1,
      tetiId: "teti_aaaaaaaaa",
      checkpoint: "rcp_<decoded>"
    }),
    /binding is invalid/
  );
});
