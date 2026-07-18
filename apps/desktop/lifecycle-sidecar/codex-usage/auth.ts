import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexUsageError } from "./errors.ts";

export interface CodexAuthCredentials {
  accessToken: string;
  accountId: string | null;
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
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new CodexUsageError("AUTH_TOKEN_MISSING", { recoverable: false });
  }
  const accountId = tokens?.account_id;
  return {
    accessToken: accessToken.trim(),
    accountId: typeof accountId === "string" && accountId.trim() ? accountId.trim() : null
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
