import assert from "node:assert/strict";
import test from "node:test";
import {
  REPO_LOCAL_RPC_EXECUTABLE,
  REPO_LOCAL_RPC_TARGET,
  repoLocalRpcServerPath,
  resolveChatmailRuntimeConfig,
  TETI_CHATMAIL_ACCOUNTS_PATH,
  TETI_DELTACHAT_RPC_PATH
} from "./runtime-config.ts";

test("runtime config honors explicit RPC env path before repo-local fallback", () => {
  const config = resolveChatmailRuntimeConfig(
    {},
    {
      [TETI_DELTACHAT_RPC_PATH]: "/tmp/custom-deltachat-rpc-server",
      [TETI_CHATMAIL_ACCOUNTS_PATH]: "/tmp/teti-accounts"
    }
  );

  assert.equal(config.rpcServerPath, "/tmp/custom-deltachat-rpc-server");
  assert.equal(config.accountsPath, "/tmp/teti-accounts");
});

test("repo-local RPC path is deterministic for the host bootstrap", () => {
  const normalized = repoLocalRpcServerPath().replaceAll("\\", "/");
  assert.equal(
    normalized.endsWith(
      `/.tools/deltachat-rpc-server/${REPO_LOCAL_RPC_TARGET}/${REPO_LOCAL_RPC_EXECUTABLE}`
    ),
    true
  );
});
