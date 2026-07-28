import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { FileTetiConnectionStorage } from "../../../core/connection/storage.ts";
import { TetiConnectionState } from "../../../core/connection/types.ts";

export const TETI_PROFILE_SCHEMA_VERSION = 2;
export const TETI_STORE_SCHEMA_VERSION = 2;
export const TETI_LEGACY_MULTI_IMAGE_DEFECT_ID = "KD-0.1.15-MULTI-IMAGE-DELIVERY";

interface ProfileMigrationTarget {
  root: string;
  storeDir: string;
  profileMetadataPath: string;
  legacyArchiveDir: string;
}

export interface TetiProfileV2Metadata {
  schemaVersion: 2;
  storeVersion: 2;
  collaborationProtocolEpoch: 2;
  createdAt: string;
  migratedFrom?: "0.1";
  legacyArchive: "legacy-0.1";
  knownDefects: [typeof TETI_LEGACY_MULTI_IMAGE_DEFECT_ID];
}

/**
 * Creates the incompatible 0.2 active Store without mutating the 0.1 source
 * files. Identity, the Chatmail database (including local contacts), confirmed
 * connections, sharing settings, and Agent detector preferences are copied.
 * Task/message/protocol state starts empty, while old tasks and attachments are
 * copied to a separate read-only archive and can never enter the active Store.
 */
export async function migrateTetiProfileToV2(
  profile: ProfileMigrationTarget,
  now: () => Date = () => new Date()
): Promise<TetiProfileV2Metadata> {
  const existing = await readMetadata(profile.profileMetadataPath);
  if (existing) {
    await requireDirectory(profile.storeDir, "Teti 0.2 Store");
    return existing;
  }

  const migratedFromLegacy = await hasLegacyProfileData(profile.root);
  if (!await pathExists(profile.storeDir)) {
    await buildActiveStore(profile, migratedFromLegacy);
  } else {
    await validateRecoverableActiveStore(profile.storeDir);
  }
  await buildLegacyArchive(profile, now);

  const metadata: TetiProfileV2Metadata = {
    schemaVersion: TETI_PROFILE_SCHEMA_VERSION,
    storeVersion: TETI_STORE_SCHEMA_VERSION,
    collaborationProtocolEpoch: 2,
    createdAt: now().toISOString(),
    ...(migratedFromLegacy ? { migratedFrom: "0.1" as const } : {}),
    legacyArchive: "legacy-0.1",
    knownDefects: [TETI_LEGACY_MULTI_IMAGE_DEFECT_ID]
  };
  await writePrivateJson(profile.profileMetadataPath, metadata);
  return metadata;
}

async function buildActiveStore(
  profile: ProfileMigrationTarget,
  migratedFromLegacy: boolean
): Promise<void> {
  const staging = join(profile.root, ".store-v2.migrating");
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "account"), { recursive: true, mode: 0o700 });
  await mkdir(join(staging, "credentials", "chatmail-accounts"), { recursive: true, mode: 0o700 });
  await mkdir(join(staging, "task-attachments"), { recursive: true, mode: 0o700 });
  try {
    if (migratedFromLegacy) {
      await migrateIdentity(profile.root, staging);
      await migrateConfirmedConnections(profile.root, staging);
      await copyOptionalFile(join(profile.root, "settings.json"), join(staging, "settings.json"));
      await copyOptionalFile(
        join(profile.root, "agent-detectors.override.json"),
        join(staging, "agent-detectors.override.json")
      );
      await copyPrivateTree(
        join(profile.root, "credentials", "chatmail-accounts"),
        join(staging, "credentials", "chatmail-accounts")
      );
    } else {
      await writePrivateJson(join(staging, "connections.json"), { version: 1, connections: [] });
    }

    await writePrivateJson(join(staging, "messages.json"), { version: 2, messageIds: [] });
    await writePrivateJson(join(staging, "tasks.json"), { schemaVersion: 2, records: [], peers: [] });
    await writePrivateJson(join(staging, "peer-protocol-capabilities.json"), {
      schemaVersion: 2,
      peers: []
    });
    await rename(staging, profile.storeDir);
    await chmod(profile.storeDir, 0o700);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function migrateIdentity(root: string, staging: string): Promise<void> {
  const candidates = [join(root, "account", "account.json"), join(root, "account.json")];
  for (const candidate of candidates) {
    if (!await pathExists(candidate)) continue;
    const account = await new FileTetiAccountStorage(candidate).load();
    if (!account) continue;
    await new FileTetiAccountStorage(join(staging, "account", "account.json")).save(account);
    return;
  }
}

async function migrateConfirmedConnections(root: string, staging: string): Promise<void> {
  const source = join(root, "connections.json");
  const target = new FileTetiConnectionStorage(join(staging, "connections.json"));
  if (!await pathExists(source)) {
    await target.saveAll([]);
    return;
  }
  const connections = await new FileTetiConnectionStorage(source).loadAll();
  await target.saveAll(connections.filter((connection) =>
    connection.state === TetiConnectionState.Confirmed
  ));
}

async function buildLegacyArchive(profile: ProfileMigrationTarget, now: () => Date): Promise<void> {
  if (await pathExists(profile.legacyArchiveDir)) return;
  const staging = join(profile.root, ".legacy-0.1.migrating");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const entries = [
      "tasks.json",
      "task-attachments",
      "messages.json",
      "peer-protocol-capabilities.json",
      "connections.json"
    ];
    for (const entry of entries) {
      await copyArchiveTree(join(profile.root, entry), join(staging, entry));
    }
    await writePrivateJson(join(staging, "archive.json"), {
      schemaVersion: 1,
      sourceReleaseLine: "0.1.x",
      archivedAt: now().toISOString(),
      executable: false,
      knownDefect: TETI_LEGACY_MULTI_IMAGE_DEFECT_ID
    });
    await makeTreeReadOnly(staging);
    await rename(staging, profile.legacyArchiveDir);
  } catch (error) {
    await chmod(staging, 0o700).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function validateRecoverableActiveStore(storeDir: string): Promise<void> {
  await requireDirectory(storeDir, "Teti 0.2 Store");
  for (const file of ["messages.json", "tasks.json", "peer-protocol-capabilities.json"]) {
    if (!await pathExists(join(storeDir, file))) {
      throw new Error("Incomplete Teti 0.2 profile migration; active Store control files are missing.");
    }
  }
}

async function readMetadata(path: string): Promise<TetiProfileV2Metadata | null> {
  if (!await pathExists(path)) return null;
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || value.storeVersion !== 2
    || value.collaborationProtocolEpoch !== 2
    || value.legacyArchive !== "legacy-0.1"
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || (value.migratedFrom !== undefined && value.migratedFrom !== "0.1")
    || !Array.isArray(value.knownDefects)
    || value.knownDefects.length !== 1
    || value.knownDefects[0] !== TETI_LEGACY_MULTI_IMAGE_DEFECT_ID
    || Object.keys(value).some((key) => ![
      "schemaVersion",
      "storeVersion",
      "collaborationProtocolEpoch",
      "createdAt",
      "migratedFrom",
      "legacyArchive",
      "knownDefects"
    ].includes(key))) {
    throw new Error("Unsupported or damaged Teti profile metadata.");
  }
  return structuredClone(value) as unknown as TetiProfileV2Metadata;
}

async function hasLegacyProfileData(root: string): Promise<boolean> {
  for (const candidate of [
    join(root, "account", "account.json"),
    join(root, "account.json"),
    join(root, "connections.json"),
    join(root, "credentials", "chatmail-accounts"),
    join(root, "tasks.json")
  ]) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

async function copyOptionalFile(source: string, target: string): Promise<void> {
  if (!await pathExists(source)) return;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o600);
}

async function copyPrivateTree(source: string, target: string): Promise<void> {
  await copyTree(source, target, 0o700, 0o600);
}

async function copyArchiveTree(source: string, target: string): Promise<void> {
  await copyTree(source, target, 0o700, 0o600);
}

async function copyTree(
  source: string,
  target: string,
  directoryMode: number,
  fileMode: number
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(source);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    await mkdir(dirname(target), { recursive: true, mode: directoryMode });
    await copyFile(source, target);
    await chmod(target, fileMode);
    return;
  }
  if (!metadata.isDirectory()) return;
  await mkdir(target, { recursive: true, mode: directoryMode });
  for (const entry of await readdir(source)) {
    await copyTree(join(source, entry), join(target, entry), directoryMode, fileMode);
  }
  await chmod(target, directoryMode);
}

async function makeTreeReadOnly(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    await chmod(path, 0o400);
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path)) await makeTreeReadOnly(join(path, entry));
  // Archive files are immutable to normal readers, while owner-writable
  // directories keep the explicit profile/reset cleanup path functional.
  await chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error(`${label} is missing or invalid.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
