import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TetiProfile } from "../profile.ts";

export const TETI_RUNTIME_LOCK_FILE = "runtime.lock";
const UNKNOWN_LOCK_GRACE_MS = 30_000;

interface RuntimeLockMetadata {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

export interface TetiRuntimeProfileLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface AcquireTetiRuntimeProfileLockOptions {
  pid?: number;
  token?: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

export class TetiRuntimeAlreadyActiveError extends Error {
  readonly code = "TETI_RUNTIME_ALREADY_ACTIVE";

  constructor() {
    super("Another Teti Runtime is already active for this local profile.");
    this.name = "TetiRuntimeAlreadyActiveError";
  }
}

export async function acquireTetiRuntimeProfileLock(
  profile: Pick<TetiProfile, "lifecycleDir">,
  options: AcquireTetiRuntimeProfileLockOptions = {}
): Promise<TetiRuntimeProfileLock> {
  const path = join(profile.lifecycleDir, TETI_RUNTIME_LOCK_FILE);
  const metadata: RuntimeLockMetadata = {
    version: 1,
    pid: options.pid ?? process.pid,
    token: options.token ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString()
  };
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return createHeldLock(path, metadata.token);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await readLockMetadata(path);
      if (existing && isProcessAlive(existing.pid)) {
        throw new TetiRuntimeAlreadyActiveError();
      }
      if (!existing && await isFreshUnknownLock(path, metadata.createdAt)) {
        throw new TetiRuntimeAlreadyActiveError();
      }
      await quarantineStaleLock(path, metadata.token);
    }
  }

  throw new TetiRuntimeAlreadyActiveError();
}

function createHeldLock(path: string, token: string): TetiRuntimeProfileLock {
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      const current = await readLockMetadata(path);
      if (current?.token !== token) return;
      await unlink(path).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  };
}

async function readLockMetadata(path: string): Promise<RuntimeLockMetadata | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeLockMetadata>;
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return value as RuntimeLockMetadata;
  } catch {
    return null;
  }
}

async function isFreshUnknownLock(path: string, nowIso: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Date.parse(nowIso) - metadata.mtimeMs < UNKNOWN_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

async function quarantineStaleLock(path: string, token: string): Promise<void> {
  const stalePath = `${path}.stale-${token}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  await unlink(stalePath).catch((error) => {
    if (!isNodeError(error, "ENOENT")) throw error;
  });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
