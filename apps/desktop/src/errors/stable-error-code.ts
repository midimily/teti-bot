const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Reads only explicit machine-facing error fields. Human-readable messages are
 * intentionally ignored so controllers cannot accidentally persist or expose
 * backend, filesystem, or transport details as UI copy.
 */
export function readStableErrorCode(error: unknown): string | undefined {
  if (typeof error === "string") {
    return isStableErrorCode(error) ? error : undefined;
  }
  if (typeof error !== "object" || error === null) return undefined;

  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && isStableErrorCode(code)) return code;

  const name = "name" in error ? error.name : undefined;
  return typeof name === "string" && isStableErrorCode(name) ? name : undefined;
}

export function isStableErrorCode(value: string): boolean {
  return STABLE_ERROR_CODE_PATTERN.test(value);
}
