import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { TETI_CHATMAIL_RELAY_DOMAIN } from "../../../integrations/chatmail/relay-config.ts";
import { handleLifecycleRequest } from "../lifecycle-sidecar/handler.ts";
import { isUnsafeIncompleteMarker, writeCreationMarker } from "../lifecycle-sidecar/marker.ts";
import { assertManifestHasNoSecrets, manifestFromAccount, writeManifest } from "../lifecycle-sidecar/manifest.ts";
import {
  cleanValidationProfile,
  createValidationProfile,
  resolveTetiProfile,
  TETI_ALLOW_REAL_PROVISIONING,
  TETI_DESKTOP_NATIVE_PROVISIONING,
  TETI_PROFILE_DIR,
  TETI_PROVISIONING_MODE,
  validateAuthorizedProvisioningProfile,
  validateRealProvisioningProfile
} from "../lifecycle-sidecar/profile.ts";

test("profile resolver requires absolute paths", async () => {
  await assert.rejects(
    () => resolveTetiProfile({ [TETI_PROFILE_DIR]: "relative-profile" }),
    /absolute path/
  );
});

test("real validation rejects production profile paths", async () => {
  const report = await validateRealProvisioningProfile({
    [TETI_PROVISIONING_MODE]: "real",
    [TETI_ALLOW_REAL_PROVISIONING]: "1",
    [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im",
    [TETI_PROFILE_DIR]: join(homedir(), ".teti")
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.map((error) => error.message).join(" "), /isolated validation profile/);
});

test("real validation requires explicit authorization flag", async () => {
  const profile = await createTempValidationProfile();
  try {
    const report = await validateRealProvisioningProfile({
      [TETI_PROVISIONING_MODE]: "real",
      [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im",
      [TETI_PROFILE_DIR]: profile.root
    });

    assert.equal(report.ok, false);
    assert.match(report.errors.map((error) => error.message).join(" "), /TETI_ALLOW_REAL_PROVISIONING=1/);
  } finally {
    await rm(profile.root, { recursive: true, force: true });
  }
});

test("real validation accepts an authorized isolated profile", async () => {
  const profile = await createTempValidationProfile();
  try {
    const report = await validateRealProvisioningProfile({
      [TETI_PROVISIONING_MODE]: "real",
      [TETI_ALLOW_REAL_PROVISIONING]: "1",
      [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im",
      [TETI_PROFILE_DIR]: profile.root
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
  } finally {
    await rm(profile.root, { recursive: true, force: true });
  }
});

test("native desktop authorization selects the production profile without a terminal-only flag", async () => {
  const report = await validateAuthorizedProvisioningProfile({
    [TETI_DESKTOP_NATIVE_PROVISIONING]: "1",
    [TETI_PROVISIONING_MODE]: "real",
    [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im"
  });

  assert.equal(report.ok, true);
  assert.equal(report.profile?.root, join(homedir(), ".teti"));
});

test("existing account blocks guarded real account creation", async () => {
  const profile = await createTempValidationProfile();
  const previousEnv = snapshotEnv();
  try {
    Object.assign(process.env, {
      [TETI_PROVISIONING_MODE]: "real",
      [TETI_ALLOW_REAL_PROVISIONING]: "1",
      [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im",
      [TETI_PROFILE_DIR]: profile.root
    });
    await new FileTetiAccountStorage(profile.accountPath).save(createAccount("Milo"));

    const response = await handleLifecycleRequest({
      version: 1,
      id: "create",
      method: "account.create",
      params: { name: "Nova" }
    });

    assert.equal(response.ok, false);
    assert.match(!response.ok ? response.error.message : "", /already exists/);
  } finally {
    restoreEnv(previousEnv);
    await rm(profile.root, { recursive: true, force: true });
  }
});

test("incomplete creation marker is unsafe", async () => {
  const profile = await createTempValidationProfile();
  try {
    const marker = await writeCreationMarker(profile, { stage: "provisioning" });

    assert.equal(isUnsafeIncompleteMarker(marker), true);
  } finally {
    await rm(profile.root, { recursive: true, force: true });
  }
});

test("manifest schema rejects secret-like fields", async () => {
  assert.throws(() => assertManifestHasNoSecrets('{"password":"abc"}'), /secret-like/);
});

test("manifest writes sanitized public account data", async () => {
  const profile = await createTempValidationProfile();
  try {
    await writeManifest(profile, manifestFromAccount(profile, createAccount("Milo")));
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(profile.manifestPath, "utf8"));

    assert.equal(raw.includes("teti_milo00000"), true);
    assert.equal(/password|privateKey|token|credential/i.test(raw), false);
  } finally {
    await rm(profile.root, { recursive: true, force: true });
  }
});

test("cleanup refuses unsafe non-validation profiles", async () => {
  const production = await resolveTetiProfile({ [TETI_PROFILE_DIR]: join(homedir(), ".teti") });

  await assert.rejects(() => cleanValidationProfile(production), /non-validation/);
});

async function createTempValidationProfile() {
  const root = await mkdtemp(join(tmpdir(), "teti-real-provisioning-test-"));
  return createValidationProfile(root);
}

function createAccount(displayName: string): TetiAccount {
  const publicIdCode = "milo00000";
  return {
    version: 1,
    id: `teti_${publicIdCode}`,
    address: `${publicIdCode}@mail.seep.im`,
    displayName,
    chatmailAccountId: 7,
    publicKey: "public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Teti Real Provisioning Validation Alpha"]
    },
    createdAt: new Date().toISOString()
  };
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, previous);
}
