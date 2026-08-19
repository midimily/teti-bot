import type { CodexUsageSnapshot } from "../../src/codex-usage/types.ts";
import { readCodexAuth, type CodexAuthCredentials } from "./auth.ts";
import { CodexUsageError } from "./errors.ts";
import { parseCodexUsagePayload } from "./parser.ts";
import {
  createCodexUsageFetch,
  type CodexUsageFetch
} from "./windows-system-proxy.ts";

export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_USAGE_TIMEOUT_MS = 8_000;
const LOCAL_AUTH_PLAN_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface CodexUsageProviderOptions {
  codexHome?: string;
  readAuth?: () => Promise<CodexAuthCredentials>;
  fetchImpl?: CodexUsageFetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export class CodexUsageProvider {
  private readonly readAuth: () => Promise<CodexAuthCredentials>;
  private readonly fetchImpl: CodexUsageFetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: CodexUsageProviderOptions = {}) {
    this.readAuth = options.readAuth ?? (() => readCodexAuth({ codexHome: options.codexHome }));
    this.fetchImpl = options.fetchImpl ?? createCodexUsageFetch();
    this.endpoint = options.endpoint ?? CODEX_USAGE_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async fetchUsage(): Promise<CodexUsageSnapshot> {
    // Credentials are deliberately re-read for every refresh and never retained
    // as provider fields, so Codex remains responsible for token rotation.
    const credentials = await this.readAuth();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json"
    };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers,
        signal: controller.signal
      });
      assertSuccessfulStatus(response.status, response.ok);
      const observedAt = this.now();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new CodexUsageError("REQUEST_TIMEOUT");
        }
        throw new CodexUsageError("RESPONSE_INVALID_JSON");
      }
      return parseCodexUsagePayload(payload, { observedAt, fetchedAt: this.now() });
    } catch (error) {
      const failure = error instanceof CodexUsageError
        ? error
        : controller.signal.aborted || isAbortError(error)
          ? new CodexUsageError("REQUEST_TIMEOUT")
          : new CodexUsageError("NETWORK_UNAVAILABLE");
      const fallback = localAuthFallback(credentials, failure, this.now());
      if (fallback) return fallback;
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function localAuthFallback(
  credentials: CodexAuthCredentials,
  failure: CodexUsageError,
  now: Date
): CodexUsageSnapshot | null {
  const observedAt = credentials.localPlan
    ? Date.parse(credentials.localPlan.observedAt)
    : Number.NaN;
  const expiresAt = credentials.localPlan
    ? Date.parse(credentials.localPlan.expiresAt)
    : Number.NaN;
  const nowMs = now.getTime();
  if (!credentials.localPlan
    || !["REQUEST_TIMEOUT", "NETWORK_UNAVAILABLE"].includes(failure.safe.code)
    || !Number.isFinite(observedAt)
    || !Number.isFinite(expiresAt)
    || observedAt > nowMs
    || expiresAt <= observedAt
    || nowMs > expiresAt + LOCAL_AUTH_PLAN_GRACE_MS) {
    return null;
  }
  return {
    source: "local_auth",
    planTypeRaw: credentials.localPlan.planTypeRaw,
    planDisplayName: null,
    membershipVerified: false,
    weekly: null,
    observedAt: credentials.localPlan.observedAt,
    fetchedAt: now.toISOString(),
    stale: expiresAt <= nowMs
  };
}

function assertSuccessfulStatus(status: number, ok: boolean): void {
  if (ok) return;
  if (status === 401) throw new CodexUsageError("HTTP_UNAUTHORIZED", { httpStatus: status });
  if (status === 403) throw new CodexUsageError("HTTP_FORBIDDEN", { httpStatus: status });
  if (status === 429) throw new CodexUsageError("HTTP_RATE_LIMITED", { httpStatus: status });
  if (status >= 500) throw new CodexUsageError("HTTP_SERVER_ERROR", { httpStatus: status });
  throw new CodexUsageError("HTTP_ERROR", { httpStatus: status });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
