import type {
  ConnectionRequestDraft,
  DiscoverTetisInput,
  TetiIdentity,
  TetiPublicDirectoryIdentity,
  TetiPublicProfile
} from "./types.ts";
import {
  isCanonicalTetiPublicId,
  isTetiRelayChatmailAddress,
  normalizeTetiPublicId
} from "../../core/identity/public-id.ts";

export interface TetiPublicDirectoryReader {
  discover(input?: DiscoverTetisInput): Promise<TetiPublicDirectoryIdentity[]>;
  getIdentity(id: string): Promise<TetiPublicDirectoryIdentity | null>;
}

export interface TetiDiscoveryServiceOptions {
  directory: TetiPublicDirectoryReader;
}

export interface PrepareConnectionRequestInput {
  local: {
    id: string;
    address: string;
  };
  remote: TetiIdentity;
  publicContext?: Record<string, unknown>;
}

export class TetiDiscoveryService {
  private readonly directory: TetiPublicDirectoryReader;

  constructor(options: TetiDiscoveryServiceOptions) {
    this.directory = options.directory;
  }

  async discoverTetis(input: DiscoverTetisInput = {}): Promise<TetiIdentity[]> {
    const identities = (await this.directory.discover(input)).map(toTetiIdentity);

    if (typeof input.limit !== "number") {
      return identities;
    }

    return identities.slice(0, Math.max(0, Math.floor(input.limit)));
  }

  async getTetiProfile(id: string): Promise<TetiIdentity | null> {
    const identity = await this.directory.getIdentity(normalizeTetiPublicId(id));
    return identity ? toTetiIdentity(identity) : null;
  }

  prepareConnectionRequest(input: PrepareConnectionRequestInput): ConnectionRequestDraft {
    return {
      to: {
        id: input.remote.id,
        address: input.remote.address,
        publicKey: input.remote.publicKey
      },
      from: {
        id: input.local.id,
        address: input.local.address
      },
      intent: "connect",
      publicContext: input.publicContext
    };
  }
}

export function toTetiIdentity(identity: TetiPublicDirectoryIdentity): TetiIdentity {
  if (!isCanonicalTetiPublicId(identity.id)) {
    throw new Error("Discovery returned a non-canonical Teti public ID.");
  }
  if (!isTetiRelayChatmailAddress(identity.address, identity.id)) {
    throw new Error("Discovery returned an invalid Network delivery address.");
  }
  return {
    id: identity.id,
    address: identity.address,
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    publicProfile: toPublicProfile(identity.publicProfile),
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt
  };
}

function toPublicProfile(profile: Record<string, unknown> | undefined): TetiPublicProfile {
  return {
    ...(profile ?? {})
  };
}

export { matchTetis, scoreCompatibility } from "./matcher.ts";
export type {
  ConnectionRequestDraft,
  DiscoverTetisInput,
  TetiCompatibilityMatch,
  TetiIdentity,
  TetiPublicProfile
} from "./types.ts";
