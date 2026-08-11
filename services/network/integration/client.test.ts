import assert from "node:assert/strict";
import test from "node:test";
import { HttpTetiNetworkClient } from "../client.ts";
import { assertTetiNetworkCompatible } from "../compatibility.ts";
import {
  DEVELOPMENT_TETI_NETWORK_BASE_URL,
  resolveTetiNetworkBaseUrl
} from "../config.ts";
import { TetiNetworkClientError } from "../errors.ts";
import { BETA_038_NETWORK_REQUIREMENTS } from "../types.ts";

test("Beta 0.3.8 client consumes the running local Network Revision 8 contract", async () => {
  const baseUrl = resolveTetiNetworkBaseUrl({
    TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL
      ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
  });
  const client = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.8",
    clientPlatform: "macos"
  });

  const bootstrap = await client.getBootstrap();
  assertTetiNetworkCompatible(bootstrap, BETA_038_NETWORK_REQUIREMENTS);

  assert.equal(bootstrap.protocolVersion, 1);
  assert.ok(bootstrap.contractRevision >= 8);
  assert.equal(bootstrap.service.name, "teti-network");
  assert.equal(bootstrap.service.version, "0.1.8");
  assert.equal(bootstrap.releasePolicy.minimumSupportedVersion, "0.3.0");
  assert.deepEqual(bootstrap.capabilities, {
    publicDirectory: true,
    identity: true,
    clientAuthentication: true,
    presence: true,
    publicProfile: true,
    relationships: true,
    relayBindings: true,
    invites: false
  });
  assert.deepEqual(bootstrap.presencePolicy, {
    collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
    viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
    online: { reportEverySeconds: 15, ttlSeconds: 45 },
    background: { reportEverySeconds: 30, ttlSeconds: 90 }
  });
  assert.equal(bootstrap.relayBootstrap?.catalogPath, "/v1/relays");
  const relays = await client.listRelays();
  assert.ok(relays.relays.some((relay) => relay.id === bootstrap.relayBootstrap?.preferredRelay.id));

  const directory = await client.listPublicNodes();
  assert.equal(directory.page.returnedCount, directory.items.length);
  assert.equal(directory.sort, "updated_desc");
  const stats = await client.getPublicStats();
  assert.ok(stats.activeIdentityCount >= stats.discoverableNodeCount);
  assert.ok(Number.isFinite(Date.parse(stats.generatedAt)));
  await assert.rejects(
    () => client.getPublicNode("teti_a83kd9x2q"),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "IDENTITY_NOT_FOUND"
      && error.operation === "public_node"
  );
});
