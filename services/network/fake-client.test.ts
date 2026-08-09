import assert from "node:assert/strict";
import test from "node:test";
import { FakeTetiNetworkClient } from "./fake-client.ts";

test("Fake Network client provides isolated deterministic bootstrap state", async () => {
  const source = bootstrap();
  const client = new FakeTetiNetworkClient(source);
  source.capabilities.presence = true;

  const first = await client.getBootstrap();
  first.capabilities.identity = false;
  const second = await client.getBootstrap();

  assert.equal(client.calls, 2);
  assert.equal(second.capabilities.presence, true);
  assert.equal(second.capabilities.identity, true);

  client.setPublicStats({
    activeIdentityCount: 3,
    discoverableNodeCount: 2,
    generatedAt: "2026-08-08T12:00:00.000Z"
  });
  const stats = await client.getPublicStats();
  stats.activeIdentityCount = 99;
  assert.equal((await client.getPublicStats()).activeIdentityCount, 3);
  assert.equal(client.publicStatsCalls, 2);
});

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-08T00:00:00.000Z",
    protocolSupport: { minimumSupportedVersion: 1, supportedVersions: [1] },
    releasePolicy: {
      schemaVersion: 1 as const,
      policyVersion: 1,
      channel: "beta" as const,
      minimumSupportedVersion: "0.3.0",
      effectiveAt: "2026-08-08T00:00:00.000Z"
    },
    capabilities: {
      publicDirectory: true,
      identity: true,
      clientAuthentication: true,
      presence: true,
      publicProfile: true,
      relationships: true,
      relayBindings: false,
      invites: false
    },
    presencePolicy: {
      collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
      viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
      online: { reportEverySeconds: 15, ttlSeconds: 45 },
      background: { reportEverySeconds: 30, ttlSeconds: 90 }
    }
  };
}
