import assert from "node:assert/strict";
import test from "node:test";
import { TetiDiscoveryService } from "./client.ts";
import { matchTetis } from "./matcher.ts";
import type { DiscoveryIdentity } from "./registry-client.ts";
import type { TetiRegistryReader } from "./client.ts";

test("discovers public Teti identities from the registry", async () => {
  const service = new TetiDiscoveryService({
    registry: new StaticRegistry([
      {
        version: 1,
        id: "teti_alex",
        address: "alex@mail.seep.im",
        publicKey: "public-key",
        publicProfile: {
          platform: "macOS",
          aiEnvironment: ["Claude Code"]
        }
      },
      {
        version: 1,
        id: "teti_blair",
        address: "blair@mail.seep.im",
        publicProfile: {
          platform: "Windows"
        }
      }
    ])
  });

  const identities = await service.discoverTetis({ limit: 1 });

  assert.deepEqual(identities, [
    {
      id: "teti_alex",
      address: "alex@mail.seep.im",
      publicKey: "public-key",
      publicProfile: {
        platform: "macOS",
        aiEnvironment: ["Claude Code"]
      },
      createdAt: undefined,
      updatedAt: undefined
    }
  ]);
});

test("fetches a Teti profile by id", async () => {
  const service = new TetiDiscoveryService({
    registry: new StaticRegistry([
      {
        version: 1,
        id: "teti_profile",
        address: "profile@mail.seep.im",
        publicProfile: {
          category: ["developer"]
        }
      }
    ])
  });

  assert.deepEqual(await service.getTetiProfile("teti_profile"), {
    id: "teti_profile",
    address: "profile@mail.seep.im",
    publicKey: undefined,
    publicProfile: {
      category: ["developer"]
    },
    createdAt: undefined,
    updatedAt: undefined
  });
  assert.equal(await service.getTetiProfile("missing"), null);
});

test("calculates deterministic compatibility scores", () => {
  const matches = matchTetis({
    localProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code", "Cursor"]
    },
    remoteTetis: [
      {
        id: "teti_low",
        address: "low@mail.seep.im",
        publicProfile: {
          platform: "Windows",
          aiEnvironment: ["Codex"]
        }
      },
      {
        id: "teti_high",
        address: "high@mail.seep.im",
        publicKey: "public-key",
        publicProfile: {
          platform: "macOS",
          category: ["developer"],
          aiEnvironment: ["Claude Code"]
        }
      }
    ]
  });

  assert.equal(matches[0].identity.id, "teti_high");
  assert.equal(matches[0].score, 65);
  assert.deepEqual(matches[0].reasons, [
    "same platform: macOS",
    "shared AI environment: claude code",
    "shared category: developer",
    "public key available"
  ]);
  assert.equal(matches[1].identity.id, "teti_low");
  assert.equal(matches[1].score, 0);
});

test("surfaces offline registry errors", async () => {
  const service = new TetiDiscoveryService({
    registry: new OfflineRegistry()
  });

  await assert.rejects(
    () => service.discoverTetis(),
    (error) => error instanceof Error && error.message === "registry offline"
  );
});

test("prepares a public connection request draft without sending a message", () => {
  const service = new TetiDiscoveryService({
    registry: new StaticRegistry([])
  });

  assert.deepEqual(
    service.prepareConnectionRequest({
      local: {
        id: "teti_local",
        address: "local@mail.seep.im"
      },
      remote: {
        id: "teti_remote",
        address: "remote@mail.seep.im",
        publicKey: "remote-public-key",
        publicProfile: {}
      },
      publicContext: {
        purpose: "pairing"
      }
    }),
    {
      to: {
        id: "teti_remote",
        address: "remote@mail.seep.im",
        publicKey: "remote-public-key"
      },
      from: {
        id: "teti_local",
        address: "local@mail.seep.im"
      },
      intent: "connect",
      publicContext: {
        purpose: "pairing"
      }
    }
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
    return this.identities.find((identity) => identity.id === id) ?? null;
  }
}

class OfflineRegistry implements TetiRegistryReader {
  async discover(): Promise<DiscoveryIdentity[]> {
    throw new Error("registry offline");
  }

  async getIdentity(): Promise<DiscoveryIdentity | null> {
    throw new Error("registry offline");
  }
}
