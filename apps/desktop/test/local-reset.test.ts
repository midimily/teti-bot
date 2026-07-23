import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ALPHA_LOCAL_RESET_CONFIRMATION,
  LEGACY_TETI_DESKTOP_BUNDLE_ID,
  ONBOARDING_REGISTRY_RESET_CONFIRMATION,
  ONBOARDING_RESET_CONFIRMATION,
  TETI_DESKTOP_BUNDLE_ID,
  assertAlphaLocalResetConfirmed,
  assertOnboardingRegistryResetConfirmed,
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
    assert.equal(result.remoteDiscoveryDeleted, false);
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

test("onboarding reset requires separate exact confirmations for local and Registry deletion", () => {
  assert.throws(
    () => assertOnboardingResetConfirmed(undefined),
    /RESET_TETI_ONBOARDING/
  );
  assert.doesNotThrow(
    () => assertOnboardingResetConfirmed(ONBOARDING_RESET_CONFIRMATION)
  );
  assert.throws(
    () => assertOnboardingRegistryResetConfirmed(ONBOARDING_RESET_CONFIRMATION),
    /DELETE_TETI_ONBOARDING_AND_REGISTRY/
  );
  assert.doesNotThrow(
    () => assertOnboardingRegistryResetConfirmed(
      ONBOARDING_REGISTRY_RESET_CONFIRMATION
    )
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
    assert.deepEqual(result.registry, {
      requested: false,
      deleted: false,
      method: "not_requested"
    });
    await assert.rejects(() => stat(accountDir), /ENOENT/);
    await assert.rejects(() => stat(join(home, ".teti", "connections.json")), /ENOENT/);
    await assert.rejects(() => stat(uiState), /ENOENT/);
    assert.equal(await readFile(join(chatmailDir, "accounts.toml"), "utf8"), "preserved");
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

test("optional Registry cleanup uses Cloudflare KV admin API before local removal", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-onboarding-registry-"));
  try {
    const accountDir = join(home, ".teti", "account");
    await mkdir(accountDir, { recursive: true });
    await writeFile(
      join(accountDir, "account.json"),
      JSON.stringify({ id: "teti_abc123xyz" }),
      "utf8"
    );
    const requests: Array<{ url: string; method?: string; authorization?: string }> = [];

    const result = await resetTetiOnboarding({
      home,
      confirmation: ONBOARDING_RESET_CONFIRMATION,
      registryConfirmation: ONBOARDING_REGISTRY_RESET_CONFIRMATION,
      deleteRegistry: true,
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        TETI_KV_NAMESPACE_ID: "namespace-id",
        CLOUDFLARE_API_TOKEN: "admin-token"
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          method: init?.method,
          authorization: headers.get("authorization") ?? undefined
        });
        return Response.json({ success: true, result: null });
      }
    });

    assert.deepEqual(result.registry, {
      requested: true,
      deleted: true,
      method: "cloudflare_kv_admin"
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "DELETE");
    assert.equal(requests[0].authorization, "Bearer admin-token");
    assert.match(requests[0].url, /teti%3Ateti_abc123xyz$/);
    await assert.rejects(() => stat(accountDir), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Registry cleanup failure keeps the local identity available for retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "teti-onboarding-registry-failure-"));
  try {
    const accountPath = join(home, ".teti", "account", "account.json");
    await mkdir(join(home, ".teti", "account"), { recursive: true });
    await writeFile(accountPath, JSON.stringify({ id: "teti_abc123xyz" }), "utf8");

    await assert.rejects(
      () => resetTetiOnboarding({
        home,
        confirmation: ONBOARDING_RESET_CONFIRMATION,
        registryConfirmation: ONBOARDING_REGISTRY_RESET_CONFIRMATION,
        deleteRegistry: true,
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          TETI_KV_NAMESPACE_ID: "namespace-id",
          CLOUDFLARE_API_TOKEN: "admin-token"
        },
        fetchImpl: async () => Response.json(
          { success: false },
          { status: 403 }
        )
      }),
      /Local state was not removed/
    );
    assert.equal((await stat(accountPath)).isFile(), true);
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
  assert.ok(targets.includes(join(home, "Library", "Logs", "Teti")));
});

test("connection input uses the privacy-safe nine-star community ID placeholder", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const stateSource = await readFile(new URL("../src/connections/connect-panel-state.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /input\.placeholder = CONNECT_PANEL_PLACEHOLDER/);
  assert.match(stateSource, /CONNECT_PANEL_PLACEHOLDER = "\*{9}（teti\.bot 社区9位ID）"/);
  assert.match(styles, /\.teti-connect-input::placeholder[\s\S]*opacity: 0\.48/);
});
