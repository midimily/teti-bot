import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTetiNetworkRelationshipCommandStore,
  validateRelationshipCommandRecord
} from "./relationship-command-store.ts";

test("Relationship command store durably preserves exact command bytes and removes terminal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-relationship-command-"));
  const path = join(directory, "pending.json");
  const store = new FileTetiNetworkRelationshipCommandStore(path);
  const rawBody = JSON.stringify({
    schemaVersion: 1,
    peerTetiId: "teti_bbbbbbbbb",
    expectedRevision: 0
  });
  await store.save({
    schemaVersion: 1,
    pending: {
      tetiId: "teti_aaaaaaaaa",
      operation: "request",
      peerTetiId: "teti_bbbbbbbbb",
      expectedRevision: 0,
      ifMatch: '"relationship-r0"',
      idempotencyKey: "relationship.request:00000000-0000-4000-8000-000000000000",
      rawBody
    }
  });

  assert.equal((await store.load()).pending?.rawBody, rawBody);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).includes("privateKey"), false);

  await store.save({ schemaVersion: 1 });
  assert.deepEqual(await store.load(), { schemaVersion: 1 });
});

test("Relationship command store rejects mismatched revision, target, and JSON", () => {
  assert.throws(() => validateRelationshipCommandRecord({
    schemaVersion: 1,
    pending: {
      tetiId: "teti_aaaaaaaaa",
      operation: "reject",
      relationshipId: "rel_AAAAAAAAAAAAAAAAAAAAAA",
      expectedRevision: 2,
      ifMatch: '"relationship-r1"',
      idempotencyKey: "relationship.reject:00000000-0000-4000-8000-000000000000",
      rawBody: '{"schemaVersion":1,"expectedRevision":2}'
    }
  }), /invalid/);
});
