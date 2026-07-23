import { redactSecretLikeText } from "./security.ts";

export type DiagnosticValue = string | number | boolean | null | undefined;

export function writeRuntimeDiagnostic(
  event: string,
  fields: Record<string, DiagnosticValue> = {}
): void {
  const details = Object.entries(fields)
    .filter((entry): entry is [string, Exclude<DiagnosticValue, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${safeKey(key)}=${safeValue(value)}`)
    .join(" ");
  const line = `${new Date().toISOString()} event=${safeKey(event)}${details ? ` ${details}` : ""}`;
  process.stderr.write(`${redactSecretLikeText(line)}\n`);
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
