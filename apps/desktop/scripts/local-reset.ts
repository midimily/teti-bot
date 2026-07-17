import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export const TETI_DESKTOP_BUNDLE_ID = "im.midimily.teti.desktop";
export const ALPHA_LOCAL_RESET_CONFIRMATION = "DELETE_LOCAL_TETI";

export interface LocalResetOptions {
  home: string;
  dryRun?: boolean;
  allowOrphanRealAccount?: boolean;
  extraProfile?: string;
  bundleId?: string;
}

export interface LocalResetResult {
  ok: true;
  dryRun: boolean;
  localOnly: true;
  remoteChatmailDeleted: false;
  remoteDiscoveryDeleted: false;
  bundleId: string;
  note: string;
  results: Array<{ path: string; existed: boolean; removed: boolean }>;
}

export async function resetLocalTeti(options: LocalResetOptions): Promise<LocalResetResult> {
  const bundleId = options.bundleId ?? TETI_DESKTOP_BUNDLE_ID;
  const dryRun = Boolean(options.dryRun);
  await assertNoRealAccountWouldBeOrphaned(options.home, Boolean(options.allowOrphanRealAccount));
  const targets = defaultLocalResetTargets(options.home, bundleId);
  if (options.extraProfile) {
    targets.push(assertSafeExtraProfile(options.extraProfile));
  }

  const results: LocalResetResult["results"] = [];
  for (const target of unique(targets)) {
    const exists = await pathExists(target);
    if (exists && !dryRun) {
      await rm(target, { recursive: true, force: true });
    }
    results.push({ path: target, existed: exists, removed: exists && !dryRun });
  }

  return {
    ok: true,
    dryRun,
    localOnly: true,
    remoteChatmailDeleted: false,
    remoteDiscoveryDeleted: false,
    bundleId,
    note: "Quit Teti before running this command so local state is not recreated while cleanup runs.",
    results
  };
}

export function assertAlphaLocalResetConfirmed(value: string | undefined): void {
  if (value !== ALPHA_LOCAL_RESET_CONFIRMATION) {
    throw new Error(
      `Alpha local reset requires --confirm ${ALPHA_LOCAL_RESET_CONFIRMATION}. ` +
      "This permanently removes the local Teti profile while leaving remote KV and Chatmail data untouched."
    );
  }
}

export function defaultLocalResetTargets(
  home: string,
  bundleId = TETI_DESKTOP_BUNDLE_ID
): string[] {
  return [
    join(home, ".teti"),
    join(home, "Library", "WebKit", bundleId),
    join(home, "Library", "Application Support", bundleId),
    join(home, "Library", "Caches", bundleId),
    join(home, "Library", "HTTPStorages", bundleId),
    join(home, "Library", "Preferences", `${bundleId}.plist`),
    join(home, "Library", "Saved Application State", `${bundleId}.savedState`),
    join(home, "Library", "Containers", bundleId)
  ];
}

function assertSafeExtraProfile(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("--profile must be an absolute path.");
  }
  const normalized = resolve(path);
  const tempRoots = [resolve(tmpdir()), "/tmp", "/private/tmp"].map((root) => resolve(root));
  const underTempRoot = tempRoots.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`));
  const name = basename(normalized);
  const recognized = name.startsWith("teti-real-provisioning-") || name.startsWith("teti-mail-seep-real-");
  if (!underTempRoot || !recognized) {
    throw new Error(
      "--profile cleanup only accepts temp validation profiles named teti-real-provisioning-* or teti-mail-seep-real-*."
    );
  }
  return normalized;
}

async function assertNoRealAccountWouldBeOrphaned(home: string, allowed: boolean): Promise<void> {
  if (allowed) return;
  for (const accountPath of [join(home, ".teti", "account", "account.json"), join(home, ".teti", "account.json")]) {
    try {
      const account = JSON.parse(await readFile(accountPath, "utf8")) as { address?: unknown };
      if (typeof account.address === "string" && account.address.endsWith("@mail.seep.im")) {
        throw new Error(
          "Refusing to remove a real Chatmail profile because that would orphan its Relay account and TETI_REGISTRY record. " +
          "Use the Alpha local reset command only when remote cleanup is intentionally out of scope."
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError || isNotFound(error)) continue;
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
