import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TetiNetworkRelationshipReconciliationRecord {
  schemaVersion: 1;
  tetiId?: string;
  checkpoint?: string;
}

export interface TetiNetworkRelationshipReconciliationStore {
  load(): Promise<TetiNetworkRelationshipReconciliationRecord>;
  save(record: TetiNetworkRelationshipReconciliationRecord): Promise<void>;
}

export class FileTetiNetworkRelationshipReconciliationStore
implements TetiNetworkRelationshipReconciliationStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkRelationshipReconciliationRecord> {
    try {
      return validateRelationshipReconciliationRecord(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1 };
      throw error;
    }
  }

  async save(record: TetiNetworkRelationshipReconciliationRecord): Promise<void> {
    const validated = validateRelationshipReconciliationRecord(record);
    if (!validated.checkpoint) {
      await rm(this.path, { force: true });
      return;
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export class MemoryTetiNetworkRelationshipReconciliationStore
implements TetiNetworkRelationshipReconciliationStore {
  private value: TetiNetworkRelationshipReconciliationRecord = { schemaVersion: 1 };

  async load(): Promise<TetiNetworkRelationshipReconciliationRecord> {
    return structuredClone(this.value);
  }

  async save(record: TetiNetworkRelationshipReconciliationRecord): Promise<void> {
    this.value = validateRelationshipReconciliationRecord(record);
  }
}

export function validateRelationshipReconciliationRecord(
  value: unknown
): TetiNetworkRelationshipReconciliationRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || Object.keys(value).some((key) => !["schemaVersion", "tetiId", "checkpoint"].includes(key))) {
    throw new Error("Teti Network Relationship reconciliation record is invalid.");
  }
  const empty = value.tetiId === undefined && value.checkpoint === undefined;
  const populated = isTetiId(value.tetiId) && isCheckpoint(value.checkpoint);
  if (!empty && !populated) {
    throw new Error("Teti Network Relationship reconciliation binding is invalid.");
  }
  return empty
    ? { schemaVersion: 1 }
    : { schemaVersion: 1, tetiId: value.tetiId as string, checkpoint: value.checkpoint as string };
}

function isTetiId(value: unknown): value is string {
  return typeof value === "string" && /^teti_[a-z0-9]{9}$/.test(value);
}

function isCheckpoint(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 5
    && value.length <= 512
    && /^rcp_[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
