import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FilePassportSharingStore,
  resourceSharingPolicy
} from "../lifecycle-sidecar/runtime/passport/sharing.ts";

test("Passport sharing defaults off and persists a private field-level policy", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "teti-passport-settings-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "settings.json");
  const store = new FilePassportSharingStore(path);

  assert.deepEqual(await store.load(), resourceSharingPolicy(false));
  await store.save(resourceSharingPolicy(true));
  assert.deepEqual(await store.load(), resourceSharingPolicy(true));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 2,
    passportSharing: resourceSharingPolicy(true)
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("legacy statusSharing is migrated once to the Passport policy", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "teti-passport-migration-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({ version: 1, statusSharing: true }));
  const store = new FilePassportSharingStore(path);

  assert.deepEqual(await store.load(), resourceSharingPolicy(true));
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
});

test("invalid or unsupported sharing fields fail closed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "teti-passport-settings-invalid-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({
    version: 2,
    passportSharing: { ...resourceSharingPolicy(true), agents: true }
  }));
  const store = new FilePassportSharingStore(path);
  await assert.rejects(() => store.load(), /not implemented/);
});
