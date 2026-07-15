import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTetiIdFromAddress, type TetiAccount } from "./model.ts";

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
      account.id ??= getTetiIdFromAddress(account.address);
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
  return join(homedir(), ".teti", "account.json");
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

  if (!account.id) {
    throw new Error("Teti account id is required.");
  }

  if (!account.address) {
    throw new Error("Teti account address is required.");
  }

  if (typeof account.chatmailAccountId !== "number") {
    throw new Error("Teti account chatmailAccountId is required.");
  }
}

function cloneAccount(account: TetiAccount): TetiAccount {
  return JSON.parse(JSON.stringify(account)) as TetiAccount;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
