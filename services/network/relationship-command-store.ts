import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TetiNetworkRelationshipCommand,
  TetiNetworkRelationshipEtag
} from "./types.ts";

export type TetiNetworkPendingRelationshipOperation =
  | "request"
  | TetiNetworkRelationshipCommand;

export interface TetiNetworkPendingRelationshipCommand {
  tetiId: string;
  operation: TetiNetworkPendingRelationshipOperation;
  peerTetiId?: string;
  relationshipId?: string;
  expectedRevision: number;
  ifMatch: TetiNetworkRelationshipEtag;
  idempotencyKey: string;
  rawBody: string;
}

export interface TetiNetworkRelationshipCommandRecord {
  schemaVersion: 1;
  pending?: TetiNetworkPendingRelationshipCommand;
}

export interface TetiNetworkRelationshipCommandStore {
  load(): Promise<TetiNetworkRelationshipCommandRecord>;
  save(record: TetiNetworkRelationshipCommandRecord): Promise<void>;
}

export class FileTetiNetworkRelationshipCommandStore
implements TetiNetworkRelationshipCommandStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkRelationshipCommandRecord> {
    try {
      return validateRelationshipCommandRecord(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1 };
      throw error;
    }
  }

  async save(record: TetiNetworkRelationshipCommandRecord): Promise<void> {
    const validated = validateRelationshipCommandRecord(record);
    if (!validated.pending) {
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

export class MemoryTetiNetworkRelationshipCommandStore
implements TetiNetworkRelationshipCommandStore {
  private value: TetiNetworkRelationshipCommandRecord = { schemaVersion: 1 };

  async load(): Promise<TetiNetworkRelationshipCommandRecord> {
    return structuredClone(this.value);
  }

  async save(record: TetiNetworkRelationshipCommandRecord): Promise<void> {
    this.value = validateRelationshipCommandRecord(record);
  }
}

export function validateRelationshipCommandRecord(
  value: unknown
): TetiNetworkRelationshipCommandRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "pending")) {
    throw new Error("Teti Network Relationship command record is invalid.");
  }
  if (value.pending === undefined) return { schemaVersion: 1 };
  const pending = value.pending;
  if (!isRecord(pending)) throw new Error("Teti Network pending Relationship command is invalid.");
  const allowed = [
    "tetiId",
    "operation",
    "peerTetiId",
    "relationshipId",
    "expectedRevision",
    "ifMatch",
    "idempotencyKey",
    "rawBody"
  ];
  if (Object.keys(pending).some((key) => !allowed.includes(key))
    || !isTetiId(pending.tetiId)
    || !isOperation(pending.operation)
    || !Number.isSafeInteger(pending.expectedRevision)
    || (pending.expectedRevision as number) < 0
    || pending.ifMatch !== `"relationship-r${pending.expectedRevision as number}"`
    || typeof pending.idempotencyKey !== "string"
    || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)
    || typeof pending.rawBody !== "string"
    || Buffer.byteLength(pending.rawBody, "utf8") > 16_384) {
    throw new Error("Teti Network pending Relationship command is invalid.");
  }
  const requestTarget = pending.operation === "request"
    && isTetiId(pending.peerTetiId)
    && pending.relationshipId === undefined;
  const existingTarget = pending.operation !== "request"
    && isRelationshipId(pending.relationshipId)
    && pending.peerTetiId === undefined;
  if (!requestTarget && !existingTarget) {
    throw new Error("Teti Network pending Relationship target is invalid.");
  }
  try {
    const body = JSON.parse(pending.rawBody) as unknown;
    if (!isRecord(body)
      || body.schemaVersion !== 1
      || body.expectedRevision !== pending.expectedRevision
      || (pending.operation === "request" && body.peerTetiId !== pending.peerTetiId)
      || (pending.operation !== "request" && "peerTetiId" in body)) {
      throw new Error();
    }
  } catch {
    throw new Error("Teti Network pending Relationship body is invalid.");
  }
  return {
    schemaVersion: 1,
    pending: structuredClone(pending) as unknown as TetiNetworkPendingRelationshipCommand
  };
}

function isOperation(value: unknown): value is TetiNetworkPendingRelationshipOperation {
  return value === "request"
    || value === "accept"
    || value === "reject"
    || value === "block"
    || value === "revoke";
}

function isTetiId(value: unknown): value is string {
  return typeof value === "string" && /^teti_[a-z0-9]{9}$/.test(value);
}

function isRelationshipId(value: unknown): value is string {
  return typeof value === "string" && /^rel_[A-Za-z0-9_-]{21}[AQgw]$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
