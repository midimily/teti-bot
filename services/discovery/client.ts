import {
  DEFAULT_TETI_REGISTRY_URL,
  RegistryDiscoveryClient,
  type DiscoveryIdentity
} from "./registry-client.ts";
import type {
  ConnectionRequestDraft,
  DiscoverTetisInput,
  TetiIdentity,
  TetiPublicProfile
} from "./types.ts";
import {
  isCanonicalTetiChatmailAddress,
  isCanonicalTetiPublicId,
  normalizeTetiPublicId
} from "../../core/identity/public-id.ts";

export interface TetiRegistryReader {
  discover(): Promise<DiscoveryIdentity[]>;
  getIdentity(id: string): Promise<DiscoveryIdentity | null>;
}

export interface TetiDiscoveryServiceOptions {
  registry?: TetiRegistryReader;
  registryUrl?: string;
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
  private readonly registry: TetiRegistryReader;

  constructor(options: TetiDiscoveryServiceOptions = {}) {
    this.registry =
      options.registry ?? new RegistryDiscoveryClient(options.registryUrl ?? DEFAULT_TETI_REGISTRY_URL);
  }

  async discoverTetis(input: DiscoverTetisInput = {}): Promise<TetiIdentity[]> {
    const identities = (await this.registry.discover()).map(toTetiIdentity);

    if (typeof input.limit !== "number") {
      return identities;
    }

    return identities.slice(0, Math.max(0, Math.floor(input.limit)));
  }

  async getTetiProfile(id: string): Promise<TetiIdentity | null> {
    const identity = await this.registry.getIdentity(normalizeTetiPublicId(id));
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

const defaultDiscoveryService = new TetiDiscoveryService();

export function discoverTetis(input: DiscoverTetisInput = {}): Promise<TetiIdentity[]> {
  return defaultDiscoveryService.discoverTetis(input);
}

export function getTetiProfile(id: string): Promise<TetiIdentity | null> {
  return defaultDiscoveryService.getTetiProfile(id);
}

export function prepareConnectionRequest(
  input: PrepareConnectionRequestInput
): ConnectionRequestDraft {
  return defaultDiscoveryService.prepareConnectionRequest(input);
}

export function toTetiIdentity(identity: DiscoveryIdentity): TetiIdentity {
  if (!isCanonicalTetiPublicId(identity.id)) {
    throw new Error("Discovery returned a non-canonical Teti public ID.");
  }
  if (!isCanonicalTetiChatmailAddress(identity.address, identity.id)) {
    throw new Error("Discovery returned a Chatmail address that does not match its Teti public ID.");
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
