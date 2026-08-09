import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTetiNetworkEnvironmentPreferenceStore,
  TetiNetworkEnvironmentSettingsService
} from "../lifecycle-sidecar/runtime/network/environment.ts";

test("Network environment defaults to production and persists an explicit local opt-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-network-environment-"));
  const store = new FileTetiNetworkEnvironmentPreferenceStore(join(directory, "environment.json"));
  const service = await TetiNetworkEnvironmentSettingsService.create(store);

  assert.deepEqual(service.settings, {
    schemaVersion: 1,
    useLocalDevelopmentNetwork: false,
    activeEnvironment: "production",
    activeBaseUrl: "https://network.teti.bot",
    configuredEnvironment: "production",
    configuredBaseUrl: "https://network.teti.bot",
    restartRequired: false
  });

  const changed = await service.setUseLocalDevelopmentNetwork(true);
  assert.equal(changed.configuredBaseUrl, "http://127.0.0.1:8788");
  assert.equal(changed.activeBaseUrl, "https://network.teti.bot");
  assert.equal(changed.restartRequired, true);

  const restarted = await TetiNetworkEnvironmentSettingsService.create(store);
  assert.equal(restarted.settings.activeEnvironment, "local_development");
  assert.equal(restarted.settings.restartRequired, false);
});

test("Network environment rejects malformed or widened configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-network-environment-invalid-"));
  const path = join(directory, "environment.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    useLocalDevelopmentNetwork: true,
    arbitraryBaseUrl: "https://attacker.invalid"
  }));
  await assert.rejects(
    () => TetiNetworkEnvironmentSettingsService.create(
      new FileTetiNetworkEnvironmentPreferenceStore(path)
    ),
    /unsupported fields/
  );
});
