import { redactSecretLikeText } from "./security.ts";

export type DiagnosticValue = string | number | boolean | null | undefined;
export type RuntimeDiagnosticSink = (
  event: string,
  fields: Record<string, DiagnosticValue>
) => void;

export function writeRuntimeDiagnostic(
  event: string,
  fields: Record<string, DiagnosticValue> = {}
): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, Exclude<DiagnosticValue, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${safeKey(key)}=${safeValue(value)}`)
    .join(" ");
  const line = `${new Date().toISOString()} event=${safeKey(event)}${details ? ` ${details}` : ""}`;
  process.stderr.write(`${redactSecretLikeText(line, 1_024)}\n`);
}

/**
 * Keeps only a compact process-error tail and removes credentials, account
 * identifiers, and user-home path segments before it reaches the app log.
 */
export function sanitizeAdapterStderrTail(value: string): string {
  return redactSecretLikeText(value, 2_048)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, "C:\\Users\\[user]")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "/Users/[user]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g, "[credential]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[opaque-id]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-512);
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

function safeValue(value: Exclude<DiagnosticValue, undefined>): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(
    value
      .replace(/[\r\n]/g, " ")
      .replace(/\b[a-z0-9]{9}@mail\.seep\.im\b/gi, "[teti-address]")
      .replace(/\bteti_[a-z0-9]{9}\b/gi, "[teti-id]")
      .slice(0, 160)
  );
}
