import assert from "node:assert/strict";
import test from "node:test";
import { resolveIdentityQuery } from "../lifecycle-sidecar/connections.ts";
import type { TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { DiscoveryIdentity } from "../../../services/discovery/registry-client.ts";

const identity: DiscoveryIdentity = {
  version: 1,
  id: "teti_076bm9evq",
  address: "076bm9evq@mail.seep.im",
  displayName: "Remote",
  publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----remote-public-key-material-1234567890",
  publicProfile: { platform: "macOS" }
};

test("peer identity input resolves the 9-character ID shown on teti.bot", async () => {
  const registry = new StaticRegistry([identity]);

  assert.equal((await resolveIdentityQuery("076bm9evq", registry)).address, identity.address);
  assert.equal((await resolveIdentityQuery("076BM9EVQ", registry)).publicKey, identity.publicKey);
});

test("peer identity input rejects prefixed IDs, addresses, links, and public keys", async () => {
  const registry = new StaticRegistry([identity]);

  for (const query of [
    "teti_076bm9evq",
    identity.address,
    "https://teti.bot/076bm9evq",
    identity.publicKey!
  ]) {
    await assert.rejects(() => resolveIdentityQuery(query, registry), /exactly 9/);
  }
});

test("peer identity input rejects unknown public data", async () => {
  await assert.rejects(
    () => resolveIdentityQuery("000000000", new StaticRegistry([identity])),
    /No public Teti identity matched/
  );
});

class StaticRegistry implements TetiRegistryReader {
  private readonly identities: DiscoveryIdentity[];

  constructor(identities: DiscoveryIdentity[]) {
    this.identities = identities;
  }

  async discover(): Promise<DiscoveryIdentity[]> {
    return this.identities;
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return this.identities.find((item) => item.id === id) ?? null;
  }
}
