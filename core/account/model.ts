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
  createdAt: string;
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
  registry: RegistryStatus;
  onlineStatus: "unknown" | "offline" | "online";
}

export type RegistryState =
  | "unknown"
  | "registered"
  | "not_registered"
  | "unreachable"
  | "rejected"
  | "conflict";

export interface RegistryStatus {
  state: RegistryState;
  checkedAt?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface DiscoveryRegistrationPayload {
  version: 1;
  id: string;
  address: string;
  displayName?: string;
  publicKey?: string;
  publicProfile: TetiPublicProfile;
}

export interface DiscoveryHeartbeatPayload {
  id: string;
  publicProfile?: TetiPublicProfile;
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
  return account.id ? normalizeTetiPublicId(account.id) : getTetiIdFromAddress(account.address);
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
