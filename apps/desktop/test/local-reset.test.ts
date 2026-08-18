import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALPHA_LOCAL_RESET_CONFIRMATION,
  LEGACY_TETI_DESKTOP_BUNDLE_ID,
  ONBOARDING_RESET_CONFIRMATION,
  TETI_DESKTOP_BUNDLE_ID,
  assertAlphaLocalResetConfirmed,
  assertOnboardingResetConfirmed,
  defaultLocalResetTargets,
  onboardingResetTargets,
  resetLocalTeti,
  resetTetiOnboarding
} from "../scripts/local-reset.ts";

test("Alpha local reset requires an exact destructive confirmation", () => {
  assert.throws(() => assertAlphaLocalResetConfirmed(undefined), /DELETE_LOCAL_TETI/);
  assert.throws(() => assertAlphaLocalResetConfirmed("delete-local-teti"), /DELETE_LOCAL_TETI/);
  assert.doesNotThrow(() => assertAlphaLocalResetConfirmed(ALPHA_LOCAL_RESET_CONFIRMATION));
});

test("Alpha local reset removes first-install state locally without remote deletion", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-alpha-local-reset-"));
  try {
    const targets = defaultLocalResetTargets(home);
    await mkdir(join(home, ".teti", "account"), { recursive: true });
    await writeFile(
      join(home, ".teti", "account", "account.json"),
      JSON.stringify({ address: "alpha-reset@mail.seep.im" }),
      "utf8"
    );
    await mkdir(targets[1], { recursive: true });
    await writeFile(join(targets[1], "webview-state"), "test", "utf8");

    await assert.rejects(() => resetLocalTeti({ home, dryRun: true }), /Refusing to remove/);

    const result = await resetLocalTeti({
      home,
      allowOrphanRealAccount: true
    });

    assert.equal(result.localOnly, true);
    assert.equal(result.remoteChatmailDeleted, false);
    assert.equal(result.remoteNetworkDeleted, false);
    assert.equal(result.results.find((item) => item.path === join(home, ".teti"))?.removed, true);
    await assert.rejects(() => stat(join(home, ".teti")), /ENOENT/);
    await assert.rejects(() => stat(targets[1]), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Alpha local reset recognizes current and legacy macOS UI containers without moving the Teti profile", () => {
  const home = "/Users/tester";
  const targets = defaultLocalResetTargets(home);

  assert.equal(targets[0], join(home, ".teti"));
  assert.ok(targets.includes(join(home, "Library", "Application Support", TETI_DESKTOP_BUNDLE_ID)));
  assert.ok(targets.includes(join(home, "Library", "Application Support", LEGACY_TETI_DESKTOP_BUNDLE_ID)));
});

test("onboarding reset requires the exact local confirmation", () => {
  assert.throws(
    () => assertOnboardingResetConfirmed(undefined),
    /RESET_TETI_ONBOARDING/
  );
  assert.doesNotThrow(
    () => assertOnboardingResetConfirmed(ONBOARDING_RESET_CONFIRMATION)
  );
});

test("onboarding reset clears first-launch state while preserving Chatmail accounts", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-onboarding-reset-"));
  try {
    const accountDir = join(home, ".teti", "account");
    const chatmailDir = join(home, ".teti", "credentials", "chatmail-accounts");
    const uiState = join(home, "Library", "WebKit", TETI_DESKTOP_BUNDLE_ID);
    await mkdir(accountDir, { recursive: true });
    await mkdir(chatmailDir, { recursive: true });
    await mkdir(join(home, ".teti", "lifecycle"), { recursive: true });
    await mkdir(uiState, { recursive: true });
    await writeFile(
      join(accountDir, "account.json"),
      JSON.stringify({
        id: "teti_abc123xyz",
        address: "abc123xyz@mail.seep.im"
      }),
      "utf8"
    );
    await writeFile(join(home, ".teti", "connections.json"), "{}", "utf8");
    await writeFile(join(home, ".teti", "settings.json"), "{}", "utf8");
    await writeFile(join(home, ".teti", "lifecycle", "creation-marker.json"), "{}", "utf8");
    await writeFile(join(chatmailDir, "accounts.toml"), "preserved", "utf8");
    await writeFile(join(uiState, "state"), "clear", "utf8");

    const result = await resetTetiOnboarding({
      home,
      confirmation: ONBOARDING_RESET_CONFIRMATION
    });

    assert.equal(result.preservedChatmail, true);
    assert.equal(result.localTetiId, "teti_abc123xyz");
    assert.equal(result.remoteNetworkDeleted, false);
    await assert.rejects(() => stat(accountDir), /ENOENT/);
    await assert.rejects(() => stat(join(home, ".teti", "connections.json")), /ENOENT/);
    await assert.rejects(() => stat(uiState), /ENOENT/);
    assert.equal(await readFile(join(chatmailDir, "accounts.toml"), "utf8"), "preserved");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Beta 0.2 onboarding reset clears the active Store but preserves v2 Chatmail accounts", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-onboarding-v2-reset-"));
  try {
    const storeDir = join(home, ".teti", "store-v2");
    const accountDir = join(storeDir, "account");
    const chatmailDir = join(storeDir, "credentials", "chatmail-accounts");
    const productionNetworkDir = join(storeDir, "network", "production");
    const developmentNetworkDir = join(storeDir, "network", "local_development");
    await mkdir(accountDir, { recursive: true });
    await mkdir(chatmailDir, { recursive: true });
    await mkdir(productionNetworkDir, { recursive: true });
    await mkdir(developmentNetworkDir, { recursive: true });
    await writeFile(
      join(accountDir, "account.json"),
      JSON.stringify({
        id: "teti_v2a123xyz",
        address: "v2a123xyz@mail.seep.im"
      }),
      "utf8"
    );
    for (const file of [
      "connections.json",
      "messages.json",
      "tasks.json",
      "peer-protocol-capabilities.json"
    ]) {
      await writeFile(join(storeDir, file), "{}", "utf8");
    }
    await writeFile(join(chatmailDir, "accounts.toml"), "preserved-v2", "utf8");
    await writeFile(join(productionNetworkDir, "identity-credentials-v1.json"), "production", "utf8");
    await writeFile(join(developmentNetworkDir, "identity-credentials-v1.json"), "development", "utf8");
    await writeFile(
      join(storeDir, "credentials", "teti-network-identity-v1.json"),
      "legacy-unscoped",
      "utf8"
    );
    await writeFile(
      join(storeDir, "credentials", "teti-network-identity-v1.json.tmp"),
      "legacy-unscoped-temporary",
      "utf8"
    );
    await writeFile(
      join(storeDir, "network-environment-v1.json"),
      JSON.stringify({ schemaVersion: 1, useLocalDevelopmentNetwork: true }),
      "utf8"
    );

    const result = await resetTetiOnboarding({
      home,
      confirmation: ONBOARDING_RESET_CONFIRMATION
    });

    assert.equal(result.localTetiId, "teti_v2a123xyz");
    assert.deepEqual(result.networkState, {
      scope: "all_environments",
      cleared: true
    });
    await assert.rejects(() => stat(accountDir), /ENOENT/);
    await assert.rejects(() => stat(join(storeDir, "tasks.json")), /ENOENT/);
    await assert.rejects(() => stat(join(storeDir, "network")), /ENOENT/);
    await assert.rejects(
      () => stat(join(storeDir, "credentials", "teti-network-identity-v1.json")),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(join(storeDir, "credentials", "teti-network-identity-v1.json.tmp")),
      /ENOENT/
    );
    await assert.rejects(() => stat(join(storeDir, "network-environment-v1.json")), /ENOENT/);
    assert.equal(await readFile(join(chatmailDir, "accounts.toml"), "utf8"), "preserved-v2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding reset refuses to run while the Teti Runtime lock owner is alive", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-onboarding-active-"));
  try {
    const lifecycleDir = join(home, ".teti", "lifecycle");
    await mkdir(lifecycleDir, { recursive: true });
    await writeFile(
      join(lifecycleDir, "runtime.lock"),
      JSON.stringify({ version: 1, pid: 4321 }),
      "utf8"
    );

    await assert.rejects(
      () => resetTetiOnboarding({
        home,
        confirmation: ONBOARDING_RESET_CONFIRMATION,
        isProcessAlive: (pid) => pid === 4321
      }),
      /Teti is still running/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding reset target list excludes the Chatmail credential directory", () => {
  const home = "/Users/tester";
  const targets = onboardingResetTargets(home);

  assert.equal(targets.includes(join(home, ".teti")), false);
  assert.equal(
    targets.some((target) => target.includes("credentials/chatmail-accounts")),
    false
  );
  assert.ok(targets.includes(join(home, ".teti", "account")));
  assert.ok(targets.includes(join(home, ".teti", "store-v2", "account")));
  assert.ok(targets.includes(join(home, ".teti", "store-v2", "network")));
  assert.ok(targets.includes(
    join(home, ".teti", "store-v2", "credentials", "teti-network-identity-v1.json")
  ));
  assert.ok(targets.includes(join(home, ".teti", "store-v2", "network-environment-v1.json")));
  assert.ok(targets.includes(join(home, "Library", "Logs", "Teti")));
});

test("connection input uses the privacy-safe nine-star community ID placeholder", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const chineseCatalog = await readFile(new URL("../src/i18n/locales/zh-hans.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /input\.placeholder = i18n\.messages\.connections\.panel\.placeholder/);
  assert.match(chineseCatalog, /placeholder: "\*{9}（teti\.bot 社区 9 位 ID）"/);
  assert.match(styles, /\.teti-connect-input::placeholder[\s\S]*opacity: 0\.48/);
});
