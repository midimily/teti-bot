import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeChatmailRpcClient } from "./create-runtime-client.ts";
import { TETI_DELTACHAT_RPC_PATH } from "./runtime-config.ts";

const LOCAL_CORE_RPC_SERVER =
  "/Users/macstudio/Documents/AICoRun/core/target/release/deltachat-rpc-server";

const runtimePath = resolveRuntimePath();

test(
  "runtime client starts deltachat-rpc-server and performs account lifecycle RPCs",
  { skip: runtimePath ? false : "deltachat-rpc-server binary unavailable" },
  async () => {
    assert.ok(runtimePath);
    const accountsPath = await mkdtemp(join(tmpdir(), "teti-chatmail-runtime-"));
    const client = createRuntimeChatmailRpcClient({
      runtime: {
        rpcServerPath: runtimePath,
        accountsPath
      },
      transport: {
        requestTimeoutMs: 5000
      }
    });

    try {
      const accountId = await client.addAccount();
      const identity = await client.getAccountInfo(accountId);

      assert.equal(identity.accountId, accountId);
      assert.equal(identity.isConfigured, false);
      assert.equal(identity.isChatmail, true);

      await client.removeAccount(accountId);
    } finally {
      await client.close();
      await rm(accountsPath, { recursive: true, force: true });
    }
  }
);

function resolveRuntimePath(): string | undefined {
  const envPath = process.env[TETI_DELTACHAT_RPC_PATH];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  if (existsSync(LOCAL_CORE_RPC_SERVER)) {
    return LOCAL_CORE_RPC_SERVER;
  }

  return undefined;
}

