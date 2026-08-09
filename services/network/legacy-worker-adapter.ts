import type {
  DiscoveryHeartbeatPayload,
  DiscoveryRegistrationPayload
} from "../../core/account/model.ts";
import {
  RegistrySyncClient,
  type DiscoveryRegistrySyncClient,
  type DiscoveryIdentity,
  type RegistryDiscoveryClientOptions
} from "../discovery/registry-client.ts";

/**
 * Temporary Beta 0.3 adapter for the existing Worker Registry.
 *
 * Product composition uses this name so legacy transport knowledge no longer
 * appears as the official Network contract. It deliberately delegates without
 * changing requests, responses, errors, retry behavior, or persistence.
 */
export class LegacyWorkerRegistrySyncAdapter implements DiscoveryRegistrySyncClient {
  private readonly client: RegistrySyncClient;

  constructor(baseUrl?: string, options: RegistryDiscoveryClientOptions = {}) {
    this.client = new RegistrySyncClient(baseUrl, options);
  }

  registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity> {
    return this.client.registerIdentity(payload);
  }

  heartbeatIdentity(payload: DiscoveryHeartbeatPayload): Promise<DiscoveryIdentity> {
    return this.client.heartbeatIdentity(payload);
  }

  getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return this.client.getIdentity(id);
  }

  deleteIdentity(id: string): Promise<void> {
    return this.client.deleteIdentity(id);
  }
}
