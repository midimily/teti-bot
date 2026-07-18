import type { CodexUsageSnapshot } from "../../src/codex-usage/types.ts";
import { readCodexAuth, type CodexAuthCredentials } from "./auth.ts";
import { CodexUsageError } from "./errors.ts";
import { parseCodexUsagePayload } from "./parser.ts";

export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_USAGE_TIMEOUT_MS = 8_000;

type UsageFetch = (
  input: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export interface CodexUsageProviderOptions {
  codexHome?: string;
  readAuth?: () => Promise<CodexAuthCredentials>;
  fetchImpl?: UsageFetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export class CodexUsageProvider {
  private readonly readAuth: () => Promise<CodexAuthCredentials>;
  private readonly fetchImpl: UsageFetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: CodexUsageProviderOptions = {}) {
    this.readAuth = options.readAuth ?? (() => readCodexAuth({ codexHome: options.codexHome }));
    this.fetchImpl = options.fetchImpl ?? (fetch as UsageFetch);
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
      if (error instanceof CodexUsageError) throw error;
      if (controller.signal.aborted || isAbortError(error)) {
        throw new CodexUsageError("REQUEST_TIMEOUT");
      }
      throw new CodexUsageError("NETWORK_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
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
