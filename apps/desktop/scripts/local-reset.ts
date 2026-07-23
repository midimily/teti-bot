import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export const TETI_DESKTOP_BUNDLE_ID = "bot.teti.app";
export const LEGACY_TETI_DESKTOP_BUNDLE_ID = "im.midimily.teti.desktop";
export const ALPHA_LOCAL_RESET_CONFIRMATION = "DELETE_LOCAL_TETI";
export const ONBOARDING_RESET_CONFIRMATION = "RESET_TETI_ONBOARDING";
export const ONBOARDING_REGISTRY_RESET_CONFIRMATION =
  "DELETE_TETI_ONBOARDING_AND_REGISTRY";

const TETI_ID_PATTERN = /^teti_[a-z0-9]{9}$/;
const UNKNOWN_RUNTIME_LOCK_GRACE_MS = 30_000;

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

export interface OnboardingResetOptions {
  home: string;
  confirmation?: string;
  registryConfirmation?: string;
  deleteRegistry?: boolean;
  dryRun?: boolean;
  bundleId?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export interface OnboardingResetResult {
  ok: true;
  dryRun: boolean;
  mode: "onboarding_regression";
  preservedChatmail: true;
  localTetiId?: string;
  registry: {
    requested: boolean;
    deleted: boolean;
    method: "not_requested" | "dry_run" | "cloudflare_kv_admin";
  };
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

export async function resetTetiOnboarding(
  options: OnboardingResetOptions
): Promise<OnboardingResetResult> {
  assertOnboardingResetConfirmed(options.confirmation);
  const dryRun = Boolean(options.dryRun);
  const bundleId = options.bundleId ?? TETI_DESKTOP_BUNDLE_ID;
  await assertTetiRuntimeStopped(
    options.home,
    options.isProcessAlive ?? defaultIsProcessAlive,
    options.now ?? (() => new Date())
  );
  const identity = await readLocalTetiIdentity(options.home);

  let registry: OnboardingResetResult["registry"] = {
    requested: false,
    deleted: false,
    method: "not_requested"
  };
  if (options.deleteRegistry) {
    assertOnboardingRegistryResetConfirmed(options.registryConfirmation);
    if (!identity) {
      throw new Error(
        "Cannot delete the Registry record because no canonical local Teti identity was found."
      );
    }
    if (dryRun) {
      registry = {
        requested: true,
        deleted: false,
        method: "dry_run"
      };
    } else {
      await deleteRegistryKvRecord({
        tetiId: identity.id,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis)
      });
      registry = {
        requested: true,
        deleted: true,
        method: "cloudflare_kv_admin"
      };
    }
  }

  const results: OnboardingResetResult["results"] = [];
  for (const target of onboardingResetTargets(options.home, bundleId)) {
    const exists = await pathExists(target);
    if (exists && !dryRun) {
      await rm(target, { recursive: true, force: true });
    }
    results.push({ path: target, existed: exists, removed: exists && !dryRun });
  }

  return {
    ok: true,
    dryRun,
    mode: "onboarding_regression",
    preservedChatmail: true,
    ...(identity ? { localTetiId: identity.id } : {}),
    registry,
    note: dryRun
      ? "Dry run only. Teti onboarding state would be reset while Chatmail account storage remains preserved."
      : "Teti onboarding state was reset. Chatmail account storage was preserved; old relay identities may remain locally.",
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

export function assertOnboardingResetConfirmed(value: string | undefined): void {
  if (value !== ONBOARDING_RESET_CONFIRMATION) {
    throw new Error(
      `Onboarding reset requires --confirm ${ONBOARDING_RESET_CONFIRMATION}. ` +
      "Quit Teti first. This removes the active local Teti identity and first-launch state."
    );
  }
}

export function assertOnboardingRegistryResetConfirmed(value: string | undefined): void {
  if (value !== ONBOARDING_REGISTRY_RESET_CONFIRMATION) {
    throw new Error(
      "Registry cleanup requires " +
      `--registry-confirm ${ONBOARDING_REGISTRY_RESET_CONFIRMATION}. ` +
      "It permanently deletes the current public Teti Registry KV record."
    );
  }
}

export function defaultLocalResetTargets(
  home: string,
  bundleId = TETI_DESKTOP_BUNDLE_ID
): string[] {
  const bundleIds = bundleId === TETI_DESKTOP_BUNDLE_ID
    ? [TETI_DESKTOP_BUNDLE_ID, LEGACY_TETI_DESKTOP_BUNDLE_ID]
    : [bundleId];
  return [
    join(home, ".teti"),
    ...bundleIds.flatMap((candidate) => [
      join(home, "Library", "WebKit", candidate),
      join(home, "Library", "Application Support", candidate),
      join(home, "Library", "Caches", candidate),
      join(home, "Library", "HTTPStorages", candidate),
      join(home, "Library", "Preferences", `${candidate}.plist`),
      join(home, "Library", "Saved Application State", `${candidate}.savedState`),
      join(home, "Library", "Containers", candidate)
    ])
  ];
}

export function onboardingResetTargets(
  home: string,
  bundleId = TETI_DESKTOP_BUNDLE_ID
): string[] {
  const profileRoot = join(home, ".teti");
  return unique([
    join(profileRoot, "account"),
    join(profileRoot, "account.json"),
    join(profileRoot, "connections.json"),
    join(profileRoot, "settings.json"),
    join(profileRoot, "test-manifest.json"),
    join(profileRoot, "lifecycle"),
    join(profileRoot, "logs"),
    join(profileRoot, "diagnostics"),
    join(home, "Library", "Logs", "Teti"),
    ...defaultLocalResetTargets(home, bundleId).filter(
      (target) => target !== profileRoot
    )
  ]);
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

async function readLocalTetiIdentity(
  home: string
): Promise<{ id: string; address?: string } | null> {
  const accountPaths = [
    join(home, ".teti", "account", "account.json"),
    join(home, ".teti", "account.json")
  ];
  for (const accountPath of accountPaths) {
    try {
      const value = JSON.parse(await readFile(accountPath, "utf8")) as {
        id?: unknown;
        address?: unknown;
      };
      if (typeof value.id !== "string" || !TETI_ID_PATTERN.test(value.id)) {
        throw new Error(`Local Teti account at ${accountPath} has a non-canonical public ID.`);
      }
      return {
        id: value.id,
        ...(typeof value.address === "string" ? { address: value.address } : {})
      };
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return null;
}

async function assertTetiRuntimeStopped(
  home: string,
  isProcessAlive: (pid: number) => boolean,
  now: () => Date
): Promise<void> {
  const lockPath = join(home, ".teti", "lifecycle", "runtime.lock");
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (Number.isInteger(lock.pid) && (lock.pid as number) > 0) {
      if (isProcessAlive(lock.pid as number)) {
        throw new Error("Teti is still running. Quit Teti before resetting onboarding state.");
      }
      return;
    }
  } catch (error) {
    if (isNotFound(error)) return;
    if (error instanceof SyntaxError) {
      const metadata = await stat(lockPath);
      if (now().getTime() - metadata.mtimeMs >= UNKNOWN_RUNTIME_LOCK_GRACE_MS) return;
      throw new Error("Teti Runtime lock is recent but unreadable. Quit Teti and try again shortly.");
    }
    throw error;
  }

  const metadata = await stat(lockPath);
  if (now().getTime() - metadata.mtimeMs < UNKNOWN_RUNTIME_LOCK_GRACE_MS) {
    throw new Error("Teti Runtime lock is recent. Quit Teti and try again shortly.");
  }
}

async function deleteRegistryKvRecord(options: {
  tetiId: string;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const accountId = requiredRegistryAdminEnv(options.env, "CLOUDFLARE_ACCOUNT_ID");
  const namespaceId = requiredRegistryAdminEnv(options.env, "TETI_KV_NAMESPACE_ID");
  const apiToken = requiredRegistryAdminEnv(options.env, "CLOUDFLARE_API_TOKEN");
  const registryKey = `teti:${options.tetiId}`;
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(namespaceId)}` +
    `/values/${encodeURIComponent(registryKey)}`;
  const response = await options.fetchImpl(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${apiToken}`
    }
  });
  const body = await response.json().catch(() => null) as {
    success?: unknown;
  } | null;
  if (!response.ok || body?.success !== true) {
    throw new Error(
      `Cloudflare Registry KV cleanup failed with HTTP ${response.status}. Local state was not removed.`
    );
  }
}

function requiredRegistryAdminEnv(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required for --delete-registry. ` +
      "Use a Cloudflare token with Workers KV Storage Edit permission."
    );
  }
  return value;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EPERM";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
