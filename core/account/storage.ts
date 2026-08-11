import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  isCanonicalTetiRelayChatmailAddress,
  isCanonicalTetiPublicId,
  normalizeTetiRelayChatmailAddress
} from "../identity/public-id.ts";
import { getTetiId, type TetiAccount } from "./model.ts";

export interface TetiAccountStorage {
  exists(): Promise<boolean>;
  load(): Promise<TetiAccount | null>;
  save(account: TetiAccount): Promise<void>;
  remove(): Promise<void>;
}

export class FileTetiAccountStorage implements TetiAccountStorage {
  private readonly accountPath: string;

  constructor(accountPath = defaultTetiAccountPath()) {
    this.accountPath = accountPath;
  }

  async exists(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  async load(): Promise<TetiAccount | null> {
    try {
      const raw = await readFile(this.accountPath, "utf8");
      const account = JSON.parse(raw) as TetiAccount;
      account.address = normalizeTetiRelayChatmailAddress(account.address);
      account.id = getTetiId(account);
      validateStoredAccount(account);
      return account;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async save(account: TetiAccount): Promise<void> {
    validateStoredAccount(account);
    await mkdir(dirname(this.accountPath), { recursive: true });

    const tmpPath = `${this.accountPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(account, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.accountPath);
  }

  async remove(): Promise<void> {
    await rm(this.accountPath, { force: true });
  }

  get path(): string {
    return this.accountPath;
  }
}

export class MemoryTetiAccountStorage implements TetiAccountStorage {
  private account: TetiAccount | null = null;

  async exists(): Promise<boolean> {
    return this.account !== null;
  }

  async load(): Promise<TetiAccount | null> {
    return this.account ? cloneAccount(this.account) : null;
  }

  async save(account: TetiAccount): Promise<void> {
    validateStoredAccount(account);
    this.account = cloneAccount(account);
  }

  async remove(): Promise<void> {
    this.account = null;
  }
}

export function defaultTetiAccountPath(): string {
  return join(homedir(), ".teti", "store-v2", "account", "account.json");
}

function validateStoredAccount(account: TetiAccount): void {
  const record = account as TetiAccount & Record<string, unknown>;

  if (record.privateKey !== undefined) {
    throw new Error("Teti account storage must not contain privateKey.");
  }

  if (record.password !== undefined || record.chatmailPassword !== undefined) {
    throw new Error("Teti account storage must not contain chatmail credentials.");
  }

  if (record.databasePath !== undefined || record.dbPath !== undefined) {
    throw new Error("Teti account storage must not contain local database paths.");
  }

  if (account.version !== 1) {
    throw new Error("Unsupported Teti account version.");
  }

  if (!isCanonicalTetiPublicId(account.id)) {
    throw new Error("Teti account id must be a canonical lowercase public ID.");
  }

  if (!isCanonicalTetiRelayChatmailAddress(account.address)) {
    throw new Error("Teti account Chatmail address must be canonical lowercase.");
  }

  if (typeof account.chatmailAccountId !== "number") {
    throw new Error("Teti account chatmailAccountId is required.");
  }

  if (account.networkIdentity !== undefined) {
    const binding = account.networkIdentity;
    if (binding.schemaVersion !== 1
      || !["register", "adopt"].includes(binding.mode)
      || !["pending", "active", "revoked", "conflict"].includes(binding.state)
      || (binding.environment !== undefined
        && binding.environment !== "production"
        && binding.environment !== "local_development")
      || (binding.identityPublicKey !== undefined
        && !/^ed25519:[A-Za-z0-9_-]{43}$/.test(binding.identityPublicKey))
      || (binding.clientInstanceId !== undefined
        && !/^ci_[A-Za-z0-9_-]{22}$/.test(binding.clientInstanceId))
      || (binding.lastVerifiedAt !== undefined
        && !Number.isFinite(Date.parse(binding.lastVerifiedAt)))) {
      throw new Error("Teti account Network identity binding is invalid.");
    }
    if (binding.state === "active"
      && (!binding.identityPublicKey || !binding.clientInstanceId || !binding.lastVerifiedAt)) {
      throw new Error("Active Teti Network identity binding is incomplete.");
    }
  }
}

function cloneAccount(account: TetiAccount): TetiAccount {
  return JSON.parse(JSON.stringify(account)) as TetiAccount;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
