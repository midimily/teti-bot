import {
  normalizeTetiPublicId,
  tetiPublicIdFromAddress
} from "../identity/public-id.ts";

export const TETI_ACCOUNT_VERSION = 1;

export interface TetiPublicProfile {
  platform: string;
  category: string[];
  aiEnvironment: string[];
  lastSeen?: string;
  device?: {
    os: {
      name: string;
      version: string;
    };
    hardware: {
      vendor?: string;
      model?: string;
      architecture: string;
    };
  };
  location?: {
    country?: string;
    city?: string;
  };
}

export interface TetiAccount {
  version: 1;
  id: string;
  address: string;
  displayName?: string;
  chatmailAccountId: number;
  publicKey?: string;
  fingerprint?: string;
  publicProfile: TetiPublicProfile;
  /**
   * Public Network binding metadata only. Private Identity Root and
   * ClientInstance seeds live in the profile credentials directory.
   */
  networkIdentity?: TetiNetworkIdentityBinding;
  createdAt: string;
}

export interface TetiNetworkIdentityBinding {
  schemaVersion: 1;
  environment?: "production" | "local_development";
  mode: "register" | "adopt";
  state: "pending" | "active" | "revoked" | "conflict";
  identityPublicKey?: string;
  clientInstanceId?: string;
  lastVerifiedAt?: string;
  errorCode?: string;
}

export interface CreateTetiAccountInput {
  name?: string;
  displayName?: string;
  address?: string;
  chatmailPassword?: string;
  chatmailQr?: string;
  publicProfile?: Partial<TetiPublicProfile>;
}

export interface TetiStatus {
  exists: boolean;
  address?: string;
  networkIdentity: NetworkIdentityStatus;
  onlineStatus: "unknown" | "offline" | "online";
}

export type NetworkIdentityState =
  | "unknown"
  | "pending"
  | "active"
  | "unavailable"
  | "unauthorized"
  | "revoked"
  | "conflict";

export interface NetworkIdentityStatus {
  state: NetworkIdentityState;
  checkedAt?: string;
  errorCode?: string;
  retryable?: boolean;
}

export function createDefaultPublicProfile(
  input: Partial<TetiPublicProfile> = {}
): TetiPublicProfile {
  const profile: TetiPublicProfile = {
    platform: input.platform ?? detectPlatform(),
    category: input.category ?? ["developer"],
    aiEnvironment: input.aiEnvironment ?? ["Claude Code", "Cursor"]
  };

  if (input.lastSeen) {
    profile.lastSeen = input.lastSeen;
  }
  if (input.device) {
    profile.device = input.device;
  }
  if (input.location) {
    profile.location = input.location;
  }

  return profile;
}

export function getTetiIdFromAddress(address: string): string {
  return tetiPublicIdFromAddress(address);
}

export function getTetiId(account: Pick<TetiAccount, "id" | "address">): string {
  return normalizeTetiPublicId(account.id);
}

function detectPlatform(): string {
  if (typeof process === "undefined") {
    return "unknown";
  }

  if (process.platform === "darwin") {
    return "macOS";
  }

  if (process.platform === "win32") {
    return "Windows";
  }

  if (process.platform === "linux") {
    return "Linux";
  }

  return process.platform;
}
