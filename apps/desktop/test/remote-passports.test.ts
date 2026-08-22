import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileRemotePassportStore } from "../lifecycle-sidecar/runtime/passport/remote-passports.ts";

test("File remote Passport store writes atomically with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-remote-passports-"));
  const path = join(directory, "remote-passports.json");
  try {
    const store = new FileRemotePassportStore(path);
    await store.upsert(remotePassport());
    const restored = await store.list();
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.snapshot.contentHash, "a".repeat(64));
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(await readFile(path, "utf8"), /privateKey|credentials|chatHistory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("File remote Passport store quarantines corruption and continues from an empty cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-remote-passports-corrupt-"));
  const path = join(directory, "remote-passports.json");
  const recoveries: string[] = [];
  try {
    await writeFile(path, "{broken", "utf8");
    const store = new FileRemotePassportStore(path, ({ backupPath }) => recoveries.push(backupPath));
    assert.deepEqual(await store.list(), []);
    assert.equal(recoveries.length, 1);
    assert.ok((await readdir(directory)).some((name) => name.startsWith("remote-passports.json.corrupt-")));
    await store.upsert(remotePassport());
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function remotePassport() {
  const generatedAt = "2026-08-22T00:00:00.000Z";
  const validUntil = "2026-08-22T00:05:00.000Z";
  return {
    requestId: "request-passport-store",
    remoteTetiId: "teti_remote001",
    snapshot: {
      schemaVersion: 4 as const,
      sharing: "enabled" as const,
      generatedAt,
      expiresAt: validUntil,
      tools: [],
      agents: [],
      capabilities: [],
      bindings: [],
      computeOffers: [],
      receivedAt: generatedAt,
      validUntil,
      contentHash: "a".repeat(64),
      leaseCheckedAt: generatedAt,
      leaseReceivedAt: generatedAt
    }
  };
}
