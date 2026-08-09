import type { DiscoverTetisInput, TetiPublicProfile } from "../discovery/types.ts";
import type {
  DiscoveryIdentity
} from "../discovery/registry-client.ts";
import type { TetiRegistryReader } from "../discovery/client.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type {
  TetiNetworkClient,
  TetiNetworkPublicNode,
  TetiNetworkPublicNodeSummary,
  TetiNetworkPublicProfile
} from "./types.ts";

/** Normalizes the official Network v1 Public Read contract for existing App domain services. */
export class TetiNetworkPublicReadAdapter implements TetiRegistryReader {
  private readonly client: TetiNetworkClient;

  constructor(client: TetiNetworkClient) {
    this.client = client;
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    try {
      return fullNodeToDiscoveryIdentity(await this.client.getPublicNode(id));
    } catch (error) {
      if (error instanceof TetiNetworkClientError && error.code === "IDENTITY_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async discover(input: DiscoverTetisInput = {}): Promise<DiscoveryIdentity[]> {
    const page = await this.client.listPublicNodes({
      ...(input.limit === undefined ? {} : { limit: normalizedLimit(input.limit) })
    });
    return page.items.map(summaryToDiscoveryIdentity);
  }
}

export function fullNodeToDiscoveryIdentity(node: TetiNetworkPublicNode): DiscoveryIdentity {
  return {
    version: 1,
    id: node.id,
    address: node.delivery.address,
    ...(node.profile.displayName === null ? {} : { displayName: node.profile.displayName }),
    ...(node.delivery.publicKey === null ? {} : { publicKey: node.delivery.publicKey }),
    publicProfile: publicProfile(node.profile),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
}

export function summaryToDiscoveryIdentity(node: TetiNetworkPublicNodeSummary): DiscoveryIdentity {
  return {
    version: 1,
    id: node.id,
    address: node.delivery.address,
    ...(node.profile.displayName === null ? {} : { displayName: node.profile.displayName }),
    publicProfile: publicProfile(node.profile),
    updatedAt: node.updatedAt
  };
}

function publicProfile(profile: TetiNetworkPublicProfile): TetiPublicProfile {
  return {
    ...(profile.capabilitySummary?.platform === null || profile.capabilitySummary === null
      ? {}
      : { platform: profile.capabilitySummary.platform }),
    ...(profile.capabilitySummary ? {
      category: [...profile.capabilitySummary.category],
      aiEnvironment: [...profile.capabilitySummary.aiEnvironment]
    } : {}),
    ...(profile.avatarUrl === null ? {} : { avatarUrl: profile.avatarUrl }),
    ...(profile.summary === null ? {} : { summary: profile.summary })
  };
}

function normalizedLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, Math.floor(value)));
}
