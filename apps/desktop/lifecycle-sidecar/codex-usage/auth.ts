import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexUsageError } from "./errors.ts";

export interface CodexAuthCredentials {
  accessToken: string;
  accountId: string | null;
  localPlan?: CodexLocalPlanObservation;
}

export interface CodexLocalPlanObservation {
  planTypeRaw: string;
  observedAt: string;
  expiresAt: string;
}

export interface CodexAuthReaderOptions {
  codexHome?: string;
  readText?: (path: string) => Promise<string>;
}

export function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}

export async function readCodexAuth(options: CodexAuthReaderOptions = {}): Promise<CodexAuthCredentials> {
  const authPath = join(options.codexHome ?? defaultCodexHome(), "auth.json");
  let text: string;
  try {
    text = await (options.readText ?? readUtf8)(authPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new CodexUsageError("AUTH_FILE_NOT_FOUND");
    if (code === "EACCES" || code === "EPERM") throw new CodexUsageError("AUTH_FILE_PERMISSION_DENIED");
    throw new CodexUsageError("AUTH_FILE_READ_FAILED");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodexUsageError("AUTH_FILE_INVALID_JSON", { recoverable: false });
  }

  const tokens = readRecord(readRecord(value)?.tokens);
  const accessToken = tokens?.access_token;
  if (!tokens || typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new CodexUsageError("AUTH_TOKEN_MISSING", { recoverable: false });
  }
  const accountId = tokens?.account_id;
  const normalizedAccountId = typeof accountId === "string" && accountId.trim()
    ? accountId.trim()
    : null;
  const localPlan = readLocalPlanObservation(tokens, normalizedAccountId);
  return {
    accessToken: accessToken.trim(),
    accountId: normalizedAccountId,
    ...(localPlan ? { localPlan } : {})
  };
}

async function readUtf8(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readLocalPlanObservation(
  tokens: Record<string, unknown>,
  accountId: string | null
): CodexLocalPlanObservation | undefined {
  if (!accountId) return undefined;
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (typeof token !== "string") continue;
    const payload = decodeJwtPayload(token);
    const claims = readRecord(payload?.["https://api.openai.com/auth"]);
    if (!claims || claims.chatgpt_account_id !== accountId) continue;
    const planTypeRaw = claims.chatgpt_plan_type;
    const issuedAt = payload?.iat;
    const expiresAt = payload?.exp;
    if (typeof planTypeRaw !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(planTypeRaw)
      || typeof issuedAt !== "number"
      || typeof expiresAt !== "number"
      || !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt) {
      continue;
    }
    const observedAt = epochSecondsToIso(issuedAt);
    const validUntil = epochSecondsToIso(expiresAt);
    if (!observedAt || !validUntil) continue;
    return { planTypeRaw, observedAt, expiresAt: validUntil };
  }
  return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload || payload.length > 16 * 1024) return null;
  try {
    return readRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function epochSecondsToIso(value: number): string | null {
  const milliseconds = value * 1_000;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
