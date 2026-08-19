export interface CodexWeeklyUsage {
  remainingPercent: number;
  usedPercent: number;
  resetAt: string | null;
  windowSeconds: number | null;
  identification: "exact" | "inferred";
}

/**
 * A plan value observed either from the internal Codex usage endpoint or from
 * bounded, account-matched local Codex auth claims when that endpoint is not
 * reachable. Local observations never carry quota data and may be stale.
 * `membershipVerified` is intentionally always false: this is not an
 * independent billing or ChatGPT membership verification result.
 */
export interface CodexUsageSnapshot {
  source: "live" | "local_auth";
  planTypeRaw: string | null;
  planDisplayName: string | null;
  membershipVerified: false;
  weekly: CodexWeeklyUsage | null;
  observedAt: string;
  fetchedAt: string;
  stale: boolean;
}

export type SafeUsageErrorCode =
  | "NOT_STARTED"
  | "AUTH_FILE_NOT_FOUND"
  | "AUTH_FILE_PERMISSION_DENIED"
  | "AUTH_FILE_READ_FAILED"
  | "AUTH_FILE_INVALID_JSON"
  | "AUTH_TOKEN_MISSING"
  | "HTTP_UNAUTHORIZED"
  | "HTTP_FORBIDDEN"
  | "HTTP_RATE_LIMITED"
  | "HTTP_SERVER_ERROR"
  | "HTTP_ERROR"
  | "NETWORK_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "RESPONSE_INVALID_JSON"
  | "PAYLOAD_SCHEMA_MISMATCH";

export interface SafeUsageError {
  code: SafeUsageErrorCode;
  message: string;
  recoverable: boolean;
  httpStatus?: number;
}

export type CodexUsageState =
  | { status: "ready"; snapshot: CodexUsageSnapshot }
  | { status: "stale"; snapshot: CodexUsageSnapshot; error: SafeUsageError }
  | { status: "unavailable"; error: SafeUsageError };
