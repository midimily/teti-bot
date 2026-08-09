import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TetiNetworkProfileEtag } from "./types.ts";

export interface TetiNetworkPendingProfileWrite {
  tetiId: string;
  expectedRevision: number;
  ifMatch: TetiNetworkProfileEtag;
  idempotencyKey: string;
  rawBody: string;
}

export interface TetiNetworkProfileSyncRecord {
  schemaVersion: 1;
  pending?: TetiNetworkPendingProfileWrite;
}

export interface TetiNetworkProfileSyncStore {
  load(): Promise<TetiNetworkProfileSyncRecord>;
  save(record: TetiNetworkProfileSyncRecord): Promise<void>;
}

export class FileTetiNetworkProfileSyncStore implements TetiNetworkProfileSyncStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkProfileSyncRecord> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return validateProfileSyncRecord(parsed);
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1 };
      throw error;
    }
  }

  async save(record: TetiNetworkProfileSyncRecord): Promise<void> {
    const validated = validateProfileSyncRecord(record);
    if (!validated.pending) {
      await rm(this.path, { force: true });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryTetiNetworkProfileSyncStore implements TetiNetworkProfileSyncStore {
  private value: TetiNetworkProfileSyncRecord = { schemaVersion: 1 };

  async load(): Promise<TetiNetworkProfileSyncRecord> {
    return structuredClone(this.value);
  }

  async save(record: TetiNetworkProfileSyncRecord): Promise<void> {
    this.value = validateProfileSyncRecord(record);
  }
}

export function validateProfileSyncRecord(value: unknown): TetiNetworkProfileSyncRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Teti Network Profile sync record is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "schemaVersion" && key !== "pending")) {
    throw new Error("Teti Network Profile sync record contains unsupported fields.");
  }
  if (value.pending === undefined) return { schemaVersion: 1 };
  const pending = value.pending;
  const expectedRevision = isRecord(pending) ? pending.expectedRevision : undefined;
  if (!isRecord(pending)
    || Object.keys(pending).sort().join(",") !== "expectedRevision,idempotencyKey,ifMatch,rawBody,tetiId"
    || typeof pending.tetiId !== "string"
    || !/^teti_[a-z0-9]{9}$/.test(pending.tetiId)
    || !Number.isSafeInteger(expectedRevision)
    || (expectedRevision as number) < 0
    || pending.ifMatch !== `"profile-r${expectedRevision as number}"`
    || typeof pending.idempotencyKey !== "string"
    || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)
    || typeof pending.rawBody !== "string"
    || Buffer.byteLength(pending.rawBody, "utf8") > 16_384) {
    throw new Error("Teti Network pending Profile write is invalid.");
  }
  try {
    const body = JSON.parse(pending.rawBody) as Record<string, unknown>;
    if (!isRecord(body) || body.expectedRevision !== pending.expectedRevision) throw new Error();
  } catch {
    throw new Error("Teti Network pending Profile body is invalid.");
  }
  return { schemaVersion: 1, pending: structuredClone(pending) as unknown as TetiNetworkPendingProfileWrite };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
