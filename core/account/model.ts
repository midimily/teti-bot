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
  registered: boolean;
  onlineStatus: "unknown" | "offline" | "online";
}

export interface DiscoveryRegistrationPayload {
  version: 1;
  id: string;
  address: string;
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
  const [localPart] = address.split("@");
  if (!localPart) {
    throw new Error("Cannot derive Teti id from empty address.");
  }

  if (localPart.startsWith("teti_")) {
    return normalizeTetiId(localPart);
  }

  return normalizeTetiId(`teti_${localPart}`);
}

export function getTetiId(account: Pick<TetiAccount, "id" | "address">): string {
  return account.id || getTetiIdFromAddress(account.address);
}

function normalizeTetiId(id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  if (!/^teti_[A-Za-z0-9_-]{3,59}$/.test(safeId)) {
    throw new Error("Cannot derive valid Teti id from address.");
  }

  return safeId;
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
