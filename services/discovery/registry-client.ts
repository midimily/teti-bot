import type {
  DiscoveryHeartbeatPayload,
  DiscoveryRegistrationPayload
} from "../../core/account/model.ts";

export const DEFAULT_TETI_REGISTRY_URL = "https://teti-registry.seep2026.workers.dev";

export interface DiscoveryIdentity {
  version: 1;
  id: string;
  address: string;
  publicKey?: string;
  publicProfile: Record<string, unknown>;
  lastSeen?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoveryClient {
  registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity>;
  heartbeatIdentity(payload: DiscoveryHeartbeatPayload): Promise<DiscoveryIdentity>;
  getIdentity(id: string): Promise<DiscoveryIdentity | null>;
  discover(): Promise<DiscoveryIdentity[]>;
  deleteIdentity(id: string): Promise<void>;
}

interface RegistryResponse<TData> {
  success: boolean;
  data?: TData;
  error?: string;
  message?: string;
}

export class RegistryDiscoveryClient implements DiscoveryClient {
  private readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_TETI_REGISTRY_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity> {
    const response = await this.request<DiscoveryIdentity>("/register", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    return response;
  }

  async heartbeatIdentity(payload: DiscoveryHeartbeatPayload): Promise<DiscoveryIdentity> {
    return this.request<DiscoveryIdentity>("/heartbeat", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    try {
      return await this.request<DiscoveryIdentity>(`/profile/${encodeURIComponent(id)}`, {
        method: "GET"
      });
    } catch (error) {
      if (error instanceof RegistryClientError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  async discover(): Promise<DiscoveryIdentity[]> {
    const response = await this.request<{ items: DiscoveryIdentity[] }>("/discover", {
      method: "GET"
    });

    return response.items;
  }

  async deleteIdentity(id: string): Promise<void> {
    await this.request<void>(`/profile/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }

  private async request<TData>(path: string, init: RequestInit): Promise<TData> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });

    const body = (await response.json().catch(() => null)) as RegistryResponse<TData> | null;
    if (!response.ok || !body?.success) {
      throw new RegistryClientError(
        response.status,
        body?.error ?? "REGISTRY_ERROR",
        body?.message ?? "Teti registry request failed."
      );
    }

    return body.data as TData;
  }
}

export class RegistryClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
