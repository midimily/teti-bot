import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileTetiNetworkEnvironmentPreferenceStore,
  TetiNetworkEnvironmentSettingsService
} from "../lifecycle-sidecar/runtime/network/environment.ts";
import {
  ensureProfileDirectories,
  resolveTetiProfile,
  TETI_PROFILE_DIR
} from "../lifecycle-sidecar/profile.ts";

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

test("release build policy ignores persisted development opt-in and rejects enabling it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-network-environment-release-"));
  const store = new FileTetiNetworkEnvironmentPreferenceStore(join(directory, "environment.json"));
  await store.save({ schemaVersion: 1, useLocalDevelopmentNetwork: true });

  const service = await TetiNetworkEnvironmentSettingsService.create(store, {
    allowLocalDevelopmentNetwork: false
  });
  assert.equal(service.settings.activeEnvironment, "production");
  assert.equal(service.settings.configuredEnvironment, "production");
  assert.equal(service.settings.useLocalDevelopmentNetwork, false);
  await assert.rejects(() => service.setUseLocalDevelopmentNetwork(true), /disabled in release builds/);
});

test("0.3.8 upgrade preserves local account/Chatmail and scoped Network state while discarding unscoped credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-network-state-isolation-"));
  try {
    const profile = await resolveTetiProfile({ [TETI_PROFILE_DIR]: root });
    await ensureProfileDirectories(profile);

    assert.notEqual(
      profile.networkStatePaths.production.credentialsPath,
      profile.networkStatePaths.local_development.credentialsPath
    );
    assert.match(profile.networkStatePaths.production.credentialsPath, /network\/production/);
    assert.match(
      profile.networkStatePaths.local_development.credentialsPath,
      /network\/local_development/
    );

    const accountSentinel = '{"local":"account-preserved"}\n';
    const chatmailSentinelPath = join(profile.chatmailAccountsPath, "accounts.toml");
    await writeFile(profile.accountPath, accountSentinel, "utf8");
    await writeFile(chatmailSentinelPath, "chatmail-preserved", "utf8");
    for (const path of [
      profile.legacyNetworkCredentialsPath,
      profile.legacyNetworkProfileSyncPath,
      profile.legacyNetworkRelationshipCommandPath
    ]) {
      await writeFile(path, "legacy", "utf8");
      await writeFile(`${path}.tmp`, "legacy-temporary", "utf8");
    }
    await mkdir(profile.networkStatePaths.production.root, { recursive: true });
    await mkdir(profile.networkStatePaths.local_development.root, { recursive: true });
    const scopedPaths = [
      profile.networkStatePaths.production.credentialsPath,
      profile.networkStatePaths.production.profileSyncPath,
      profile.networkStatePaths.production.relationshipCommandPath,
      profile.networkStatePaths.production.relationshipReconciliationPath,
      profile.networkStatePaths.production.relayBindingPath,
      profile.networkStatePaths.local_development.credentialsPath,
      profile.networkStatePaths.local_development.profileSyncPath,
      profile.networkStatePaths.local_development.relationshipCommandPath,
      profile.networkStatePaths.local_development.relationshipReconciliationPath,
      profile.networkStatePaths.local_development.relayBindingPath
    ];
    for (const path of scopedPaths) await writeFile(path, `scoped:${path}`, "utf8");

    await ensureProfileDirectories(profile);

    for (const path of [
      profile.legacyNetworkCredentialsPath,
      profile.legacyNetworkProfileSyncPath,
      profile.legacyNetworkRelationshipCommandPath
    ]) {
      await assert.rejects(() => stat(path), /ENOENT/);
      await assert.rejects(() => stat(`${path}.tmp`), /ENOENT/);
    }
    assert.equal(await readFile(profile.accountPath, "utf8"), accountSentinel);
    assert.equal(await readFile(chatmailSentinelPath, "utf8"), "chatmail-preserved");
    for (const path of scopedPaths) assert.equal(await readFile(path, "utf8"), `scoped:${path}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
