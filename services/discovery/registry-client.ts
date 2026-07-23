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
export const DEFAULT_TETI_REGISTRY_TIMEOUT_MS = 10_000;

export type RegistryFailureKind =
  | "unreachable"
  | "rejected"
  | "conflict"
  | "invalid_response";

export interface RegistryDiscoveryClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = resolveTetiRegistryUrl(),
    options: RegistryDiscoveryClientOptions = {}
  ) {
    this.baseUrl = normalizeRegistryUrl(baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TETI_REGISTRY_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Registry timeout must be positive.");
    }
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {})
        },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RegistryClientError(
          0,
          "REG_TIMEOUT",
          "Teti registry request timed out.",
          "unreachable",
          true
        );
      }
      const code = registryTransportCode(error);
      throw new RegistryClientError(
        0,
        code,
        "Teti registry is temporarily unreachable.",
        "unreachable",
        true
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => null)) as RegistryResponse<TData> | null;
    if (!response.ok || !body?.success) {
      const code = body?.error ?? (
        response.status >= 500
          ? "REG_HTTP_5XX"
          : response.ok
            ? "REG_INVALID_RESPONSE"
            : "REG_HTTP_REJECTED"
      );
      const temporarilyUnavailable = response.status >= 500
        || response.status === 408
        || response.status === 429;
      const kind: RegistryFailureKind = temporarilyUnavailable
        ? "unreachable"
        : response.status === 409
          ? "conflict"
          : response.ok
            ? "invalid_response"
            : "rejected";
      throw new RegistryClientError(
        response.status,
        code,
        body?.message ?? "Teti registry request failed.",
        kind,
        temporarilyUnavailable || response.ok
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
  readonly kind: RegistryFailureKind;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    kind: RegistryFailureKind = status >= 500 ? "unreachable" : "rejected",
    retryable = status >= 500 || status === 429
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
    this.retryable = retryable;
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
      "Teti registry did not confirm the complete public identity.",
      "invalid_response",
      true
    );
  }

  return identity;
}

function registryTransportCode(error: unknown): string {
  const code = readErrorCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "REG_DNS";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "REG_TLS";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "REG_TIMEOUT";
  return "REG_NETWORK";
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return null;
  const nested = (cause as { code?: unknown }).code;
  return typeof nested === "string" ? nested : null;
}
