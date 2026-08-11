import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createTetiNetworkSigningKey,
  requireEd25519PrivateSeed,
  requireEd25519PublicKey,
  type TetiNetworkStoredSigningKey
} from "./signing.ts";
import type { TetiNetworkEnvironment } from "./config.ts";

export interface TetiNetworkPendingIdentityWrite {
  operation: "register" | "adopt";
  idempotencyKey: string;
  rawBody: string;
}

export interface TetiNetworkCredentialScope {
  environment: TetiNetworkEnvironment;
  deliveryAddress: string;
  transportPublicKey: string | null;
}

export interface TetiNetworkCredentialRecord {
  schemaVersion: 1;
  scope?: TetiNetworkCredentialScope;
  identityRoot: TetiNetworkStoredSigningKey;
  clientInstance: TetiNetworkStoredSigningKey & {
    id?: string;
    platform?: string;
    appVersion?: string;
  };
  tetiId?: string;
  pending?: TetiNetworkPendingIdentityWrite;
}

export interface TetiNetworkCredentialStore {
  load(): Promise<TetiNetworkCredentialRecord | null>;
  save(record: TetiNetworkCredentialRecord): Promise<void>;
  remove(): Promise<void>;
}

export class FileTetiNetworkCredentialStore implements TetiNetworkCredentialStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<TetiNetworkCredentialRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.path, "utf8")) as TetiNetworkCredentialRecord;
      validateCredentialRecord(record);
      return clone(record);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async save(record: TetiNetworkCredentialRecord): Promise<void> {
    validateCredentialRecord(record);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export class MemoryTetiNetworkCredentialStore implements TetiNetworkCredentialStore {
  private value: TetiNetworkCredentialRecord | null = null;

  async load(): Promise<TetiNetworkCredentialRecord | null> {
    return this.value ? clone(this.value) : null;
  }

  async save(record: TetiNetworkCredentialRecord): Promise<void> {
    validateCredentialRecord(record);
    this.value = clone(record);
  }

  async remove(): Promise<void> {
    this.value = null;
  }
}

export function validateCredentialRecord(record: TetiNetworkCredentialRecord): void {
  if (!record || record.schemaVersion !== 1) {
    throw new Error("Teti Network credential schema is invalid.");
  }
  validateStoredKey(record.identityRoot, "Identity Root");
  validateStoredKey(record.clientInstance, "ClientInstance");
  if (record.identityRoot.publicKey === record.clientInstance.publicKey) {
    throw new Error("Teti Network Identity Root and ClientInstance keys must be distinct.");
  }
  if (record.scope !== undefined) validateCredentialScope(record.scope);
  const hasBinding = record.tetiId !== undefined;
  if (hasBinding !== (record.clientInstance.id !== undefined)
    || hasBinding !== (record.clientInstance.platform !== undefined)
    || hasBinding !== (record.clientInstance.appVersion !== undefined)) {
    throw new Error("Teti Network credential binding is incomplete.");
  }
  if (record.tetiId !== undefined && !/^teti_[a-z0-9]{9}$/.test(record.tetiId)) {
    throw new Error("Teti Network credential Teti ID is invalid.");
  }
  if (record.clientInstance.id !== undefined
    && !/^ci_[A-Za-z0-9_-]{22}$/.test(record.clientInstance.id)) {
    throw new Error("Teti Network credential ClientInstance ID is invalid.");
  }
  if (record.clientInstance.platform !== undefined
    && !/^[A-Za-z0-9._+-]{1,32}$/.test(record.clientInstance.platform)) {
    throw new Error("Teti Network credential ClientInstance platform is invalid.");
  }
  if (record.clientInstance.appVersion !== undefined
    && !/^[A-Za-z0-9._+-]{1,64}$/.test(record.clientInstance.appVersion)) {
    throw new Error("Teti Network credential ClientInstance app version is invalid.");
  }
  if (record.pending !== undefined) {
    if (record.pending.operation !== "register" && record.pending.operation !== "adopt") {
      throw new Error("Teti Network pending operation is invalid.");
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(record.pending.idempotencyKey)) {
      throw new Error("Teti Network pending idempotency key is invalid.");
    }
    if (!record.pending.rawBody || Buffer.byteLength(record.pending.rawBody, "utf8") > 16_384) {
      throw new Error("Teti Network pending write body is invalid.");
    }
    try {
      const body = JSON.parse(record.pending.rawBody);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not object");
    } catch {
      throw new Error("Teti Network pending write body is invalid JSON.");
    }
  }
  if (record.tetiId !== undefined && record.pending !== undefined) {
    throw new Error("Bound Teti Network credentials must not retain a pending identity write.");
  }
}

function validateCredentialScope(scope: TetiNetworkCredentialScope): void {
  if (!scope
    || Object.keys(scope).sort().join(",") !== "deliveryAddress,environment,transportPublicKey"
    || (scope.environment !== "production" && scope.environment !== "local_development")
    || typeof scope.deliveryAddress !== "string"
    || !scope.deliveryAddress
    || scope.deliveryAddress.length > 320
    || (scope.transportPublicKey !== null
      && (typeof scope.transportPublicKey !== "string"
        || !scope.transportPublicKey
        || scope.transportPublicKey.length > 16_384))) {
    throw new Error("Teti Network credential scope is invalid.");
  }
}

function validateStoredKey(value: TetiNetworkStoredSigningKey, label: string): void {
  if (!value || typeof value !== "object") throw new Error(`${label} credential is missing.`);
  requireEd25519PublicKey(value.publicKey);
  requireEd25519PrivateSeed(value.privateSeed);
  createTetiNetworkSigningKey(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
