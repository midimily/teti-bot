import { readFile, writeFile } from "node:fs/promises";
import type { PublicTetiAccount } from "../src/lifecycle-bridge/protocol.ts";
import type { TetiProfile } from "./profile.ts";

export interface RealValidationManifest {
  version: 1;
  validationProfileName: string;
  profilePath: string;
  displayName?: string;
  publicTetiId?: string;
  publicChatmailAddress?: string;
  creationTimestamp?: string;
  discoveryRegistrationStatus?: "not_attempted" | "succeeded" | "failed" | "unknown";
  applicationBuildIdentifier?: string;
  protocolVersion: 1;
  restartVerification?: {
    completed: boolean;
    sameTetiId: boolean;
    sameAddress: boolean;
  };
  duplicateCreation?: {
    attempted: boolean;
    blocked: boolean;
    duplicateIdentityCreated: boolean;
  };
  localCleanupStatus?: "not_attempted" | "completed" | "retained";
  remoteExpiryExpectation?: string;
}

export function manifestFromAccount(profile: TetiProfile, account: PublicTetiAccount): RealValidationManifest {
  return {
    version: 1,
    validationProfileName: profile.root.split("/").pop() ?? "unknown",
    profilePath: profile.root,
    displayName: account.displayName,
    publicTetiId: account.id,
    publicChatmailAddress: account.address,
    creationTimestamp: account.createdAt,
    discoveryRegistrationStatus: "succeeded",
    protocolVersion: 1,
    duplicateCreation: {
      attempted: false,
      blocked: false,
      duplicateIdentityCreated: false
    },
    localCleanupStatus: "not_attempted",
    remoteExpiryExpectation: "No remote delete was performed; registry record is expected to expire according to registry TTL."
  };
}

export async function writeManifest(profile: TetiProfile, manifest: RealValidationManifest): Promise<void> {
  const serialized = JSON.stringify(manifest, null, 2);
  assertManifestHasNoSecrets(serialized);
  await writeFile(profile.manifestPath, `${serialized}\n`, "utf8");
}

export async function readManifest(profile: TetiProfile): Promise<RealValidationManifest | null> {
  try {
    return JSON.parse(await readFile(profile.manifestPath, "utf8")) as RealValidationManifest;
  } catch {
    return null;
  }
}

export function assertManifestHasNoSecrets(serialized: string): void {
  if (/(password|credential|token|privateKey|private_key|secret|stack)/i.test(serialized)) {
    throw new Error("Validation manifest contains secret-like data.");
  }
}
