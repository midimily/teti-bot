import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validateAiStatusSyncPayload } from "../../../../../core/ai-status/protocol.ts";
import type { RemoteAiStatusSnapshot } from "../../../../../core/ai-status/types.ts";
import { isCanonicalTetiPublicId } from "../../../../../core/identity/public-id.ts";

export const TETI_REMOTE_PASSPORT_STORE_SCHEMA_VERSION = 1;
export const MAX_REMOTE_PASSPORTS = 512;

export interface PersistedRemotePassport {
  requestId: string;
  remoteTetiId: string;
  snapshot: RemoteAiStatusSnapshot;
}

interface RemotePassportStoreState {
  schemaVersion: 1;
  passports: PersistedRemotePassport[];
}

export interface RemotePassportStore {
  list(): Promise<PersistedRemotePassport[]>;
  upsert(passport: PersistedRemotePassport): Promise<void>;
  remove(requestId: string): Promise<void>;
}

export class FileRemotePassportStore implements RemotePassportStore {
  private readonly path: string;
  private readonly onRecovery: (input: { backupPath: string; message: string }) => void;

  constructor(
    path: string,
    onRecovery: (input: { backupPath: string; message: string }) => void = () => undefined
  ) {
    this.path = path;
    this.onRecovery = onRecovery;
  }

  async list(): Promise<PersistedRemotePassport[]> {
    return structuredClone((await this.load()).passports);
  }

  async upsert(passport: PersistedRemotePassport): Promise<void> {
    validatePersistedRemotePassport(passport);
    const state = await this.load();
    const index = state.passports.findIndex((item) => item.requestId === passport.requestId);
    if (index >= 0) state.passports[index] = structuredClone(passport);
    else {
      if (state.passports.length >= MAX_REMOTE_PASSPORTS) {
        throw new Error("Teti remote Passport store is full.");
      }
      state.passports.push(structuredClone(passport));
    }
    await this.save(state);
  }

  async remove(requestId: string): Promise<void> {
    const state = await this.load();
    const retained = state.passports.filter((item) => item.requestId !== requestId);
    if (retained.length === state.passports.length) return;
    state.passports = retained;
    await this.save(state);
  }

  private async load(): Promise<RemotePassportStoreState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      validateRemotePassportStoreState(value);
      return structuredClone(value);
    } catch (error) {
      if (isNotFound(error)) return emptyRemotePassportStoreState();
      const backupPath = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backupPath).catch(() => undefined);
      this.onRecovery({
        backupPath,
        message: error instanceof Error ? error.message : String(error)
      });
      return emptyRemotePassportStoreState();
    }
  }

  private async save(state: RemotePassportStoreState): Promise<void> {
    validateRemotePassportStoreState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryRemotePassportStore implements RemotePassportStore {
  private state: RemotePassportStoreState;

  constructor(passports: PersistedRemotePassport[] = []) {
    this.state = {
      schemaVersion: TETI_REMOTE_PASSPORT_STORE_SCHEMA_VERSION,
      passports: structuredClone(passports)
    };
    validateRemotePassportStoreState(this.state);
  }

  async list(): Promise<PersistedRemotePassport[]> {
    return structuredClone(this.state.passports);
  }

  async upsert(passport: PersistedRemotePassport): Promise<void> {
    validatePersistedRemotePassport(passport);
    const index = this.state.passports.findIndex((item) => item.requestId === passport.requestId);
    if (index >= 0) this.state.passports[index] = structuredClone(passport);
    else {
      if (this.state.passports.length >= MAX_REMOTE_PASSPORTS) {
        throw new Error("Teti remote Passport store is full.");
      }
      this.state.passports.push(structuredClone(passport));
    }
  }

  async remove(requestId: string): Promise<void> {
    this.state.passports = this.state.passports.filter((item) => item.requestId !== requestId);
  }
}

function emptyRemotePassportStoreState(): RemotePassportStoreState {
  return {
    schemaVersion: TETI_REMOTE_PASSPORT_STORE_SCHEMA_VERSION,
    passports: []
  };
}

function validateRemotePassportStoreState(value: unknown): asserts value is RemotePassportStoreState {
  if (!isRecord(value)
    || value.schemaVersion !== TETI_REMOTE_PASSPORT_STORE_SCHEMA_VERSION
    || !Array.isArray(value.passports)
    || value.passports.length > MAX_REMOTE_PASSPORTS
    || Object.keys(value).some((key) => !["schemaVersion", "passports"].includes(key))) {
    throw new Error("Unsupported Teti remote Passport store.");
  }
  const requestIds = new Set<string>();
  for (const passport of value.passports) {
    validatePersistedRemotePassport(passport);
    if (requestIds.has(passport.requestId)) {
      throw new Error("Teti remote Passport store contains a duplicate connection.");
    }
    requestIds.add(passport.requestId);
  }
}

function validatePersistedRemotePassport(value: unknown): asserts value is PersistedRemotePassport {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["requestId", "remoteTetiId", "snapshot"].includes(key))
    || typeof value.requestId !== "string"
    || !value.requestId.trim()
    || value.requestId.length > 120
    || !isCanonicalTetiPublicId(value.remoteTetiId)
    || !isRecord(value.snapshot)) {
    throw new Error("Persisted remote Passport is invalid.");
  }
  const allowedSnapshotKeys = new Set([
    "schemaVersion",
    "sharing",
    "generatedAt",
    "expiresAt",
    "tools",
    "agents",
    "capabilities",
    "bindings",
    "computeOffers",
    "receivedAt",
    "validUntil",
    "contentHash",
    "leaseCheckedAt",
    "leaseReceivedAt"
  ]);
  if (Object.keys(value.snapshot).some((key) => !allowedSnapshotKeys.has(key))) {
    throw new Error("Persisted remote Passport contains unsupported fields.");
  }
  const {
    receivedAt,
    validUntil,
    contentHash,
    leaseCheckedAt,
    leaseReceivedAt,
    ...payload
  } = value.snapshot;
  validateAiStatusSyncPayload(payload);
  requireTimestamp(receivedAt, "receivedAt");
  if (validUntil !== undefined) requireTimestamp(validUntil, "validUntil");
  if (leaseCheckedAt !== undefined) requireTimestamp(leaseCheckedAt, "leaseCheckedAt");
  if (leaseReceivedAt !== undefined) requireTimestamp(leaseReceivedAt, "leaseReceivedAt");
  if (contentHash !== undefined
    && (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/.test(contentHash))) {
    throw new Error("Persisted remote Passport content hash is invalid.");
  }
}

function requireTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Persisted remote Passport ${label} is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
