import { readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const BUNDLE_ID = "im.midimily.teti.desktop";
const HOME = homedir();

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const extraProfile = stringArg(args, "profile");
const allowOrphanRealAccount = Boolean(args["allow-orphan-real-account"]);

try {
  await assertNoRealAccountWouldBeOrphaned(allowOrphanRealAccount);
  const targets = defaultResetTargets();
  if (extraProfile) {
    targets.push(assertSafeExtraProfile(extraProfile));
  }

  const results = [];
  for (const target of unique(targets)) {
    const exists = await pathExists(target);
    if (exists && !dryRun) {
      await rm(target, { recursive: true, force: true });
    }
    results.push({ path: target, existed: exists, removed: exists && !dryRun });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        localOnly: true,
        remoteChatmailDeleted: false,
        remoteDiscoveryDeleted: false,
        bundleId: BUNDLE_ID,
        note: "Quit Teti before running this command so WebView storage is not recreated while cleanup runs.",
        results
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function defaultResetTargets(): string[] {
  return [
    join(HOME, ".teti"),
    join(HOME, "Library", "WebKit", BUNDLE_ID),
    join(HOME, "Library", "Application Support", BUNDLE_ID),
    join(HOME, "Library", "Caches", BUNDLE_ID),
    join(HOME, "Library", "HTTPStorages", BUNDLE_ID),
    join(HOME, "Library", "Preferences", `${BUNDLE_ID}.plist`),
    join(HOME, "Library", "Saved Application State", `${BUNDLE_ID}.savedState`),
    join(HOME, "Library", "Containers", BUNDLE_ID)
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
  const recognized =
    name.startsWith("teti-real-provisioning-") || name.startsWith("teti-mail-seep-real-");

  if (!underTempRoot || !recognized) {
    throw new Error(
      "--profile cleanup only accepts temp validation profiles named teti-real-provisioning-* or teti-mail-seep-real-*."
    );
  }

  return normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoRealAccountWouldBeOrphaned(allowed: boolean): Promise<void> {
  if (allowed) return;
  for (const accountPath of [join(HOME, ".teti", "account", "account.json"), join(HOME, ".teti", "account.json")]) {
    try {
      const account = JSON.parse(await readFile(accountPath, "utf8")) as { address?: unknown };
      if (typeof account.address === "string" && account.address.endsWith("@mail.seep.im")) {
        throw new Error(
          "Refusing to remove a real Chatmail profile because that would orphan its Relay account and TETI_REGISTRY record. " +
            "Use the account deletion lifecycle, or pass --allow-orphan-real-account only when remote cleanup is intentionally handled separately."
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError || (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function stringArg(values: Record<string, string | boolean>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
