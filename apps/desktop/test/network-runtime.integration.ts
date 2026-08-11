import assert from "node:assert/strict";
import test from "node:test";
import { HttpTetiNetworkClient } from "../../../services/network/client.ts";
import {
  DEVELOPMENT_TETI_NETWORK_BASE_URL,
  resolveTetiNetworkBaseUrl
} from "../../../services/network/config.ts";
import { TetiRuntime } from "../lifecycle-sidecar/runtime/service.ts";
import { MemoryPassportSharingStore } from "../lifecycle-sidecar/runtime/passport/sharing.ts";

test("Teti Runtime reaches the local Network through NetworkClient", async () => {
  const baseUrl = resolveTetiNetworkBaseUrl({
    TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL
      ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
  });
  const networkClient = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.8",
    clientPlatform: "macos"
  });
  const directDirectory = await networkClient.listPublicNodes();
  const directStats = await networkClient.getPublicStats();
  const runtime = new TetiRuntime({
    dependencies: {
      networkClient,
      async loadTetiAccount() { return null; },
      async synchronizeNetworkIdentity() { throw new Error("no account"); },
      async getPeerConnectionService() { throw new Error("no account"); },
      passportSharingStore: new MemoryPassportSharingStore(),
      codexUsageService: {
        getCurrentState() {
          return {
            status: "unavailable" as const,
            error: { code: "NOT_STARTED", message: "not started", recoverable: true }
          };
        },
        async refreshNow() { return this.getCurrentState(); }
      }
    }
  });

  runtime.start();
  try {
    const status = await waitForNetworkContract(runtime);
    assert.equal(status.state, "compatible");
    assert.equal(status.state === "compatible" && status.protocolVersion, 1);
    assert.ok(status.state === "compatible" && status.contractRevision >= 7);
    assert.equal(status.state === "compatible" && status.serviceVersion, "0.1.8");
    assert.deepEqual(await runtime.listPublicNodes(), directDirectory);
    const runtimeStats = await runtime.getPublicStats();
    assert.deepEqual(
      {
        activeIdentityCount: runtimeStats.activeIdentityCount,
        discoverableNodeCount: runtimeStats.discoverableNodeCount
      },
      {
        activeIdentityCount: directStats.activeIdentityCount,
        discoverableNodeCount: directStats.discoverableNodeCount
      }
    );
    assert.ok(Number.isFinite(Date.parse(runtimeStats.generatedAt)));
  } finally {
    await runtime.stop();
  }
});

async function waitForNetworkContract(runtime: TetiRuntime) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = runtime.getNetworkContractStatus();
    if (status.state !== "checking") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Runtime Network contract preflight did not settle.");
}
