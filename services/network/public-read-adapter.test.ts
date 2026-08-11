import assert from "node:assert/strict";
import test from "node:test";
import { FakeTetiNetworkClient } from "./fake-client.ts";
import { TetiNetworkPublicReadAdapter } from "./public-read-adapter.ts";
import { toTetiIdentity } from "../discovery/client.ts";

test("Public Read adapter keeps Identity and Chatmail keys separate", async () => {
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setPublicNode({
    id: "teti_c77np4w6r",
    identityPublicKey: "identity-key-c77np4w6r",
    delivery: {
      transport: "chatmail",
      address: "c77np4w6r@mail2.seep.im",
      publicKey: "chatmail-key-c77np4w6r"
    },
    profile: {
      revision: 2,
      displayName: "Casey",
      avatarUrl: null,
      summary: "Available through a draining relay.",
      capabilitySummary: {
        schemaVersion: 1,
        platform: "linux",
        category: ["research"],
        capabilityIds: ["code-analysis"],
        aiEnvironment: []
      },
      updatedAt: "2026-08-08T02:00:00.000Z"
    },
    isDiscoverable: true,
    createdAt: "2026-08-08T00:03:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z"
  });
  const adapter = new TetiNetworkPublicReadAdapter(client);

  const resolved = await adapter.getIdentity("teti_c77np4w6r");
  assert.deepEqual(resolved, {
    version: 1,
    id: "teti_c77np4w6r",
    address: "c77np4w6r@mail2.seep.im",
    displayName: "Casey",
    publicKey: "chatmail-key-c77np4w6r",
    publicProfile: {
      platform: "linux",
      category: ["research"],
      aiEnvironment: [],
      summary: "Available through a draining relay."
    },
    createdAt: "2026-08-08T00:03:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z"
  });
  assert.equal(toTetiIdentity(resolved!).address, "c77np4w6r@mail2.seep.im");
});

test("Public Read adapter maps directory summaries and treats identity 404 as missing", async () => {
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setPublicDirectory({
    items: [{
      id: "teti_a83kd9x2q",
      delivery: { address: "a83kd9x2q@mail.seep.im" },
      profile: {
        revision: 0,
        displayName: "Alex",
        avatarUrl: null,
        summary: null,
        capabilitySummary: null,
        updatedAt: null
      },
      isDiscoverable: true,
      updatedAt: "2026-08-08T03:00:00.000Z"
    }],
    page: { limit: 1, returnedCount: 1, nextCursor: null },
    sort: "updated_desc"
  });
  const adapter = new TetiNetworkPublicReadAdapter(client);

  assert.deepEqual(await adapter.discover({ limit: 1 }), [{
    version: 1,
    id: "teti_a83kd9x2q",
    address: "a83kd9x2q@mail.seep.im",
    displayName: "Alex",
    publicProfile: {},
    updatedAt: "2026-08-08T03:00:00.000Z"
  }]);
  assert.deepEqual(client.publicDirectoryCalls, [{ limit: 1 }]);
  assert.equal(await adapter.getIdentity("teti_d91hf2m5s"), null);
});

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 8,
    service: { name: "teti-network" as const, version: "0.1.8" },
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
      relayBindings: true,
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
