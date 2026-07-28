import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { FileTetiConnectionStorage } from "../../../core/connection/storage.ts";
import { TetiConnectionState, type TetiConnectionRecord } from "../../../core/connection/types.ts";
import {
  TETI_PROFILE_DIR,
  ensureProfileDirectories,
  resolveTetiProfile
} from "../lifecycle-sidecar/profile.ts";
import { TETI_LEGACY_MULTI_IMAGE_DEFECT_ID } from "../lifecycle-sidecar/profile-migration.ts";

const NOW = "2026-07-28T08:00:00.000Z";

test("0.2 profile migration preserves identity, Chatmail contacts, and confirmed connections only", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-profile-v2-"));
  try {
    await new FileTetiAccountStorage(join(root, "account", "account.json")).save(account());
    await new FileTetiConnectionStorage(join(root, "connections.json")).saveAll([
      connection("confirmed", TetiConnectionState.Confirmed),
      connection("pending", TetiConnectionState.Requested)
    ]);
    await mkdir(join(root, "credentials", "chatmail-accounts"), { recursive: true });
    await writeFile(join(root, "credentials", "chatmail-accounts", "accounts.toml"), "contact-state", "utf8");
    await writeFile(join(root, "settings.json"), '{"version":4,"passportSharing":{}}\n', "utf8");
    await writeFile(join(root, "tasks.json"), '{"schemaVersion":1,"records":[],"peers":[]}\n', "utf8");
    await mkdir(join(root, "task-attachments", "input", "legacy-task"), { recursive: true });
    await writeFile(join(root, "task-attachments", "input", "legacy-task", "image.png"), "legacy", "utf8");

    const profile = await resolveTetiProfile({ [TETI_PROFILE_DIR]: root });
    await ensureProfileDirectories(profile);

    assert.equal((await new FileTetiAccountStorage(profile.accountPath).load())?.id, "teti_local0001");
    assert.equal(
      await readFile(join(profile.chatmailAccountsPath, "accounts.toml"), "utf8"),
      "contact-state"
    );
    assert.deepEqual(
      (await new FileTetiConnectionStorage(join(profile.storeDir, "connections.json")).loadAll())
        .map((item) => item.requestId),
      ["confirmed"]
    );
    assert.deepEqual(JSON.parse(await readFile(join(profile.storeDir, "tasks.json"), "utf8")), {
      schemaVersion: 2,
      records: [],
      peers: []
    });
    const archivedTaskStore = join(profile.legacyArchiveDir, "tasks.json");
    assert.match(await readFile(archivedTaskStore, "utf8"), /"schemaVersion":1/);
    assert.equal((await stat(archivedTaskStore)).mode & 0o777, 0o400);
    assert.equal(
      await readFile(join(profile.legacyArchiveDir, "task-attachments", "input", "legacy-task", "image.png"), "utf8"),
      "legacy"
    );
    const metadata = JSON.parse(await readFile(profile.profileMetadataPath, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.storeVersion, 2);
    assert.equal(metadata.collaborationProtocolEpoch, 2);
    assert.equal(metadata.migratedFrom, "0.1");
    assert.deepEqual(metadata.knownDefects, [TETI_LEGACY_MULTI_IMAGE_DEFECT_ID]);

    const metadataBeforeRestart = await readFile(profile.profileMetadataPath, "utf8");
    await ensureProfileDirectories(profile);
    assert.equal(await readFile(profile.profileMetadataPath, "utf8"), metadataBeforeRestart);
  } finally {
    await chmodArchiveForCleanup(join(root, "legacy-0.1"));
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh 0.2 profile starts with empty non-executable collaboration stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-profile-v2-fresh-"));
  try {
    const profile = await resolveTetiProfile({ [TETI_PROFILE_DIR]: root });
    await ensureProfileDirectories(profile);
    const metadata = JSON.parse(await readFile(profile.profileMetadataPath, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.migratedFrom, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(profile.storeDir, "messages.json"), "utf8")), {
      version: 2,
      messageIds: []
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(profile.storeDir, "peer-protocol-capabilities.json"), "utf8")),
      { schemaVersion: 2, peers: [] }
    );
  } finally {
    await chmodArchiveForCleanup(join(root, "legacy-0.1"));
    await rm(root, { recursive: true, force: true });
  }
});

function account(): TetiAccount {
  return {
    version: 1,
    id: "teti_local0001",
    address: "local0001@mail.seep.im",
    displayName: "Local",
    chatmailAccountId: 1,
    publicProfile: { platform: "macOS", category: ["developer"], aiEnvironment: ["Codex"] },
    createdAt: NOW
  };
}

function connection(requestId: string, state: TetiConnectionState): TetiConnectionRecord {
  return {
    version: 1,
    requestId,
    state,
    direction: "outgoing",
    remoteTetiId: "teti_remote001",
    remoteAddress: "remote001@mail.seep.im",
    request: {
      version: 1,
      requestId,
      fromTetiId: "teti_local0001",
      fromAddress: "local0001@mail.seep.im",
      profile: { platform: "macOS", category: [], aiEnvironment: [] },
      createdAt: NOW,
      nonce: `nonce-${requestId}`
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...(state === TetiConnectionState.Confirmed ? { confirmedAt: NOW } : {})
  };
}

async function chmodArchiveForCleanup(path: string): Promise<void> {
  const { chmod, lstat, readdir } = await import("node:fs/promises");
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await chmodArchiveForCleanup(join(path, entry));
  } else {
    await chmod(path, 0o600);
  }
}
