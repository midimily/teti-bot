import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAiStatusSettingsStore } from "../lifecycle-sidecar/ai-status/settings.ts";

test("sharing defaults off and persists in a private sidecar-owned file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "teti-ai-status-settings-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "settings.json");
  const store = new FileAiStatusSettingsStore(path);

  assert.deepEqual(await store.load(), { statusSharing: false });
  await store.save({ statusSharing: true });
  assert.deepEqual(await store.load(), { statusSharing: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    statusSharing: true
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("invalid settings fail closed instead of silently enabling sharing", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "teti-ai-status-settings-invalid-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  const store = new FileAiStatusSettingsStore(path);
  await writeFile(path, JSON.stringify({ version: 1, statusSharing: "yes" }));
  await assert.rejects(() => store.load(), /Unsupported Teti AI status settings/);
});
