import type {
  DiscoveryHeartbeatPayload,
  DiscoveryRegistrationPayload
} from "../../core/account/model.ts";
import {
  isCanonicalTetiChatmailAddress,
  isCanonicalTetiPublicId,
  normalizeTetiPublicId
} from "../../core/identity/public-id.ts";

export const DEFAULT_TETI_REGISTRY_URL = "https://teti-registry.seep2026.workers.dev";
export const TETI_REGISTRY_URL_ENV = "TETI_REGISTRY_URL";

export interface DiscoveryIdentity {
  version: 1;
  id: string;
  address: string;
  displayName?: string;
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

  constructor(baseUrl = resolveTetiRegistryUrl()) {
    this.baseUrl = normalizeRegistryUrl(baseUrl);
  }

  async registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity> {
    requireCanonicalRegistrationId(payload.id);
    requireCanonicalRegistrationAddress(payload.address, payload.id);
    try {
      const identity = await this.request<DiscoveryIdentity>("/register", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return assertRegistrationConfirmed(identity, payload);
    } catch (error) {
      if (!(error instanceof RegistryClientError) || error.status !== 409 || error.code !== "IDENTITY_EXISTS") {
        throw error;
      }

      const existing = await this.getIdentity(payload.id);
      if (
        !existing ||
        existing.address !== payload.address ||
        existing.publicKey !== payload.publicKey
      ) {
        throw error;
      }

      return assertRegistrationConfirmed(existing, payload);
    }
  }

  async heartbeatIdentity(payload: DiscoveryHeartbeatPayload): Promise<DiscoveryIdentity> {
    requireCanonicalRegistrationId(payload.id);
    return this.request<DiscoveryIdentity>("/heartbeat", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    const canonicalId = normalizeTetiPublicId(id);
    try {
      return await this.request<DiscoveryIdentity>(`/profile/${encodeURIComponent(canonicalId)}`, {
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
    const canonicalId = normalizeTetiPublicId(id);
    await this.request<void>(`/profile/${encodeURIComponent(canonicalId)}`, {
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

function requireCanonicalRegistrationId(id: string): void {
  if (!isCanonicalTetiPublicId(id)) {
    throw new Error("Registry writes require a canonical lowercase 9-character Teti public ID.");
  }
}

function requireCanonicalRegistrationAddress(address: string, id: string): void {
  if (!isCanonicalTetiChatmailAddress(address, id)) {
    throw new Error("Registry writes require a matching lowercase 9-character mail.seep.im address.");
  }
}

export function resolveTetiRegistryUrl(
  env: Record<string, string | undefined> = readProcessEnvironment()
): string {
  return normalizeRegistryUrl(env[TETI_REGISTRY_URL_ENV] ?? DEFAULT_TETI_REGISTRY_URL);
}

function normalizeRegistryUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TETI_REGISTRY_URL must be a valid absolute URL.");
  }

  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("TETI_REGISTRY_URL must use HTTPS outside local development.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("TETI_REGISTRY_URL must contain only the registry origin.");
  }

  return url.origin;
}

function readProcessEnvironment(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
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

function assertRegistrationConfirmed(
  identity: DiscoveryIdentity,
  payload: DiscoveryRegistrationPayload
): DiscoveryIdentity {
  if (
    identity.id !== payload.id ||
    identity.address !== payload.address ||
    identity.publicKey !== payload.publicKey ||
    identity.displayName !== payload.displayName
  ) {
    throw new RegistryClientError(
      502,
      "REGISTRY_WRITE_NOT_CONFIRMED",
      "Teti registry did not confirm the complete public identity."
    );
  }

  return identity;
}
