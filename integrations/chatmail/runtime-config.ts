import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TETI_DELTACHAT_RPC_PATH = "TETI_DELTACHAT_RPC_PATH";
export const TETI_CHATMAIL_ACCOUNTS_PATH = "TETI_CHATMAIL_ACCOUNTS_PATH";
export const REPO_LOCAL_RPC_TARGET = "aarch64-apple-darwin";
export const REPO_LOCAL_RPC_RELATIVE_PATH = join(
  ".tools",
  "deltachat-rpc-server",
  REPO_LOCAL_RPC_TARGET,
  "deltachat-rpc-server"
);

export interface ChatmailRuntimeConfig {
  rpcServerPath: string;
  accountsPath: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ChatmailRuntimeConfigInput {
  rpcServerPath?: string;
  accountsPath?: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveChatmailRuntimeConfig(
  input: ChatmailRuntimeConfigInput = {},
  env: NodeJS.ProcessEnv = process.env
): ChatmailRuntimeConfig {
  return {
    rpcServerPath: input.rpcServerPath ?? resolveDefaultRpcServerPath(env),
    accountsPath:
      input.accountsPath ??
      env[TETI_CHATMAIL_ACCOUNTS_PATH] ??
      join(homedir(), ".teti", "chatmail-accounts"),
    workingDirectory: input.workingDirectory,
    env: input.env
  };
}

export function repoLocalRpcServerPath(): string {
  return join(repoRoot(), REPO_LOCAL_RPC_RELATIVE_PATH);
}

function resolveDefaultRpcServerPath(env: NodeJS.ProcessEnv): string {
  if (env[TETI_DELTACHAT_RPC_PATH]) {
    return env[TETI_DELTACHAT_RPC_PATH];
  }

  const repoLocalPath = repoLocalRpcServerPath();
  if (existsSync(repoLocalPath)) {
    return repoLocalPath;
  }

  return "deltachat-rpc-server";
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
