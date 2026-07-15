import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { FileTetiAccountStorage } from "../../../core/account/storage.ts";
import { TetiAccountManager } from "../../../core/account/manager.ts";
import { RuntimeChatmailProvisioner } from "../../../integrations/chatmail/provisioner.ts";
import {
  resolveChatmailRelayConfig,
  validateRealValidationRelayConfig
} from "../../../integrations/chatmail/relay-config.ts";
import type { LifecycleErrorDto } from "../src/lifecycle-bridge/protocol.ts";
import { createLifecycleError } from "./security.ts";

export const TETI_PROFILE_DIR = "TETI_PROFILE_DIR";
export const TETI_ALLOW_REAL_PROVISIONING = "TETI_ALLOW_REAL_PROVISIONING";
export const TETI_PROVISIONING_MODE = "TETI_PROVISIONING_MODE";

export interface TetiProfile {
  root: string;
  accountDir: string;
  accountPath: string;
  credentialsDir: string;
  chatmailAccountsPath: string;
  lifecycleDir: string;
  markerPath: string;
  logsDir: string;
  diagnosticsDir: string;
  manifestPath: string;
  productionRoot: string;
  isValidationProfile: boolean;
}

export interface ProfileValidationReport {
  ok: boolean;
  profile?: TetiProfile;
  errors: LifecycleErrorDto[];
  warnings: string[];
}

export async function resolveTetiProfile(env: NodeJS.ProcessEnv = process.env): Promise<TetiProfile> {
  const explicitRoot = env[TETI_PROFILE_DIR];
  const root = normalizeProfileRoot(explicitRoot ?? defaultProductionProfileRoot());
  const productionRoot = normalizeProfileRoot(defaultProductionProfileRoot());
  const profile: TetiProfile = {
    root,
    accountDir: join(root, "account"),
    accountPath: join(root, "account", "account.json"),
    credentialsDir: join(root, "credentials"),
    chatmailAccountsPath: join(root, "credentials", "chatmail-accounts"),
    lifecycleDir: join(root, "lifecycle"),
    markerPath: join(root, "lifecycle", "creation-marker.json"),
    logsDir: join(root, "logs"),
    diagnosticsDir: join(root, "diagnostics"),
    manifestPath: join(root, "test-manifest.json"),
    productionRoot,
    isValidationProfile: isRecognizedValidationRoot(root, productionRoot)
  };

  return profile;
}

export async function ensureProfileDirectories(profile: TetiProfile): Promise<void> {
  await mkdir(profile.accountDir, { recursive: true });
  await mkdir(profile.credentialsDir, { recursive: true });
  await mkdir(profile.chatmailAccountsPath, { recursive: true });
  await mkdir(profile.lifecycleDir, { recursive: true });
  await mkdir(profile.logsDir, { recursive: true });
  await mkdir(profile.diagnosticsDir, { recursive: true });
}

export function createProfiledAccountManager(profile: TetiProfile): TetiAccountManager {
  const relay = resolveChatmailRelayConfig();
  return new TetiAccountManager({
    storage: new FileTetiAccountStorage(profile.accountPath),
    chatmailProvisioner: new RuntimeChatmailProvisioner({
      runtime: {
        accountsPath: profile.chatmailAccountsPath,
        workingDirectory: profile.root,
        env: {
          ...process.env,
          DC_ACCOUNTS_PATH: profile.chatmailAccountsPath
        }
      }
    }, {
      accountQr: relay.accountQr
    }),
    expectedAddressSuffix: relay.expectedAddressSuffix
  });
}

export async function validateRealProvisioningProfile(
  env: NodeJS.ProcessEnv = process.env
): Promise<ProfileValidationReport> {
  const errors: LifecycleErrorDto[] = [];
  const warnings: string[] = [];
  let profile: TetiProfile | undefined;

  try {
    profile = await resolveTetiProfile(env);
  } catch (error) {
    errors.push(
      createLifecycleError("MALFORMED_REQUEST", error instanceof Error ? error.message : String(error), {
        recoverable: false
      })
    );
    return { ok: false, errors, warnings };
  }

  if (env[TETI_PROVISIONING_MODE] !== "real") {
    errors.push(createLifecycleError("ACCOUNT_CREATE_FAILED", "Real provisioning mode is required.", { recoverable: false }));
  }

  if (env[TETI_ALLOW_REAL_PROVISIONING] !== "1") {
    errors.push(
      createLifecycleError(
        "ACCOUNT_CREATE_FAILED",
        "Set TETI_ALLOW_REAL_PROVISIONING=1 to authorize real identity creation.",
        { recoverable: false }
      )
    );
  }

  if (!env[TETI_PROFILE_DIR]) {
    errors.push(createLifecycleError("ACCOUNT_CREATE_FAILED", "TETI_PROFILE_DIR is required.", { recoverable: false }));
  }

  if (!profile.isValidationProfile) {
    errors.push(
      createLifecycleError(
        "ACCOUNT_CREATE_FAILED",
        "TETI_PROFILE_DIR must be a recognized isolated validation profile outside the production profile.",
        { recoverable: false }
      )
    );
  }

  const relay = validateRealValidationRelayConfig(env);
  for (const error of relay.errors) {
    errors.push(createLifecycleError("ACCOUNT_CREATE_FAILED", error, { recoverable: false }));
  }

  return {
    ok: errors.length === 0,
    profile,
    errors,
    warnings
  };
}

export async function writeProfileStatus(profile: TetiProfile): Promise<Record<string, unknown>> {
  const accountExists = await fileExists(profile.accountPath);
  const markerRaw = await readOptionalJson(profile.markerPath);
  return {
    profileRoot: profile.root,
    accountPath: profile.accountPath,
    chatmailAccountsPath: profile.chatmailAccountsPath,
    markerPath: profile.markerPath,
    manifestPath: profile.manifestPath,
    isValidationProfile: profile.isValidationProfile,
    accountExists,
    marker: markerRaw
  };
}

export async function cleanValidationProfile(profile: TetiProfile): Promise<void> {
  if (!profile.isValidationProfile) {
    throw new Error("Refusing to clean a non-validation profile.");
  }
  if (profile.root === "/" || profile.root === "/private" || profile.root === "/tmp" || profile.root === "/private/tmp") {
    throw new Error("Refusing to clean an unsafe root-level path.");
  }

  await rm(profile.root, { recursive: true, force: true });
}

export async function createValidationProfile(root: string): Promise<TetiProfile> {
  const env = { ...process.env, [TETI_PROFILE_DIR]: root };
  const profile = await resolveTetiProfile(env);
  if (!profile.isValidationProfile) {
    throw new Error("Profile name must start with teti-real-provisioning- or teti-mail-seep-real- and live under a temp validation root.");
  }
  await ensureProfileDirectories(profile);
  await writeFile(
    join(profile.diagnosticsDir, "README.txt"),
    "This profile is for Teti real provisioning validation. It may contain local Chatmail state.\n",
    "utf8"
  );
  return profile;
}

function normalizeProfileRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error("TETI_PROFILE_DIR must be an absolute path.");
  }
  const normalized = resolve(root);
  if (normalized.includes(`..${sep}`)) {
    throw new Error("TETI_PROFILE_DIR must not contain path traversal.");
  }
  return normalized;
}

function defaultProductionProfileRoot(): string {
  return join(homedir(), ".teti");
}

function isRecognizedValidationRoot(root: string, productionRoot: string): boolean {
  if (root === productionRoot || root.startsWith(`${productionRoot}${sep}`)) {
    return false;
  }
  const name = basename(root);
  if (!name.startsWith("teti-real-provisioning-") && !name.startsWith("teti-mail-seep-real-")) {
    return false;
  }
  const tempRoots = [resolve(tmpdir()), "/tmp", "/private/tmp"].map((path) => resolve(path));
  return tempRoots.some((tempRoot) => root === tempRoot || root.startsWith(`${tempRoot}${sep}`));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}
