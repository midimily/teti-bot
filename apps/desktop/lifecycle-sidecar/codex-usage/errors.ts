import type { SafeUsageError, SafeUsageErrorCode } from "../../src/codex-usage/types.ts";

const SAFE_MESSAGES: Record<SafeUsageErrorCode, string> = {
  NOT_STARTED: "Codex usage has not been refreshed yet.",
  AUTH_FILE_NOT_FOUND: "Codex authentication is not available on this Mac.",
  AUTH_FILE_PERMISSION_DENIED: "Teti cannot read the local Codex authentication file.",
  AUTH_FILE_READ_FAILED: "Teti could not read the local Codex authentication file.",
  AUTH_FILE_INVALID_JSON: "The local Codex authentication file is not valid JSON.",
  AUTH_TOKEN_MISSING: "The local Codex authentication file does not contain an access token.",
  HTTP_UNAUTHORIZED: "Codex usage authentication was rejected.",
  HTTP_FORBIDDEN: "Codex usage access was forbidden.",
  HTTP_RATE_LIMITED: "Codex usage is temporarily rate limited.",
  HTTP_SERVER_ERROR: "The Codex usage service is temporarily unavailable.",
  HTTP_ERROR: "The Codex usage service returned an unexpected response.",
  NETWORK_UNAVAILABLE: "The Codex usage service could not be reached.",
  REQUEST_TIMEOUT: "The Codex usage request timed out.",
  RESPONSE_INVALID_JSON: "The Codex usage service returned invalid JSON.",
  PAYLOAD_SCHEMA_MISMATCH: "The Codex usage response format is not supported."
};

export class CodexUsageError extends Error {
  readonly safe: SafeUsageError;

  constructor(code: SafeUsageErrorCode, options: { recoverable?: boolean; httpStatus?: number } = {}) {
    super(SAFE_MESSAGES[code]);
    this.name = "CodexUsageError";
    this.safe = {
      code,
      message: SAFE_MESSAGES[code],
      recoverable: options.recoverable ?? isRecoverable(code),
      ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus })
    };
  }
}

export function toSafeUsageError(error: unknown): SafeUsageError {
  if (error instanceof CodexUsageError) return { ...error.safe };
  return {
    code: "NETWORK_UNAVAILABLE",
    message: SAFE_MESSAGES.NETWORK_UNAVAILABLE,
    recoverable: true
  };
}

function isRecoverable(code: SafeUsageErrorCode): boolean {
  return ![
    "AUTH_FILE_INVALID_JSON",
    "AUTH_TOKEN_MISSING",
    "PAYLOAD_SCHEMA_MISMATCH"
  ].includes(code);
}
