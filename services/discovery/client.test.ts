import assert from "node:assert/strict";
import test from "node:test";
import { TetiDiscoveryService } from "./client.ts";
import { matchTetis } from "./matcher.ts";
import type { TetiPublicDirectoryIdentity } from "./types.ts";
import type { TetiPublicDirectoryReader } from "./client.ts";

test("discovers public Teti identities from the Network directory", async () => {
  const service = new TetiDiscoveryService({
    directory: new StaticDirectory([
      {
        version: 1,
        id: "teti_alex00001",
        address: "alex00001@mail.seep.im",
        displayName: "Alex",
        publicKey: "public-key",
        publicProfile: {
          platform: "macOS",
          aiEnvironment: ["Claude Code"]
        }
      },
      {
        version: 1,
        id: "teti_blair0001",
        address: "blair0001@mail.seep.im",
        publicProfile: {
          platform: "Windows"
        }
      }
    ])
  });

  const identities = await service.discoverTetis({ limit: 1 });

  assert.deepEqual(identities, [
    {
      id: "teti_alex00001",
      address: "alex00001@mail.seep.im",
      displayName: "Alex",
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
    directory: new StaticDirectory([
      {
        version: 1,
        id: "teti_profile01",
        address: "profile01@mail.seep.im",
        publicProfile: {
          category: ["developer"]
        }
      }
    ])
  });

  assert.deepEqual(await service.getTetiProfile("teti_profile01"), {
    id: "teti_profile01",
    address: "profile01@mail.seep.im",
    displayName: undefined,
    publicKey: undefined,
    publicProfile: {
      category: ["developer"]
    },
    createdAt: undefined,
    updatedAt: undefined
  });
  assert.equal(await service.getTetiProfile("teti_missing00"), null);
});

test("keeps Network Identity independent from its Chatmail delivery mailbox", async () => {
  const service = new TetiDiscoveryService({
    directory: new StaticDirectory([{
      version: 1,
      id: "teti_network01",
      address: "existing01@mail.seep.im",
      publicProfile: {}
    }])
  });

  const identity = await service.getTetiProfile("teti_network01");
  assert.equal(identity?.id, "teti_network01");
  assert.equal(identity?.address, "existing01@mail.seep.im");
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
        id: "teti_low000001",
        address: "low000001@mail.seep.im",
        publicProfile: {
          platform: "Windows",
          aiEnvironment: ["Codex"]
        }
      },
      {
        id: "teti_high00001",
        address: "high00001@mail.seep.im",
        publicKey: "public-key",
        publicProfile: {
          platform: "macOS",
          category: ["developer"],
          aiEnvironment: ["Claude Code"]
        }
      }
    ]
  });

  assert.equal(matches[0].identity.id, "teti_high00001");
  assert.equal(matches[0].score, 65);
  assert.deepEqual(matches[0].reasons, [
    "same platform: macOS",
    "shared AI environment: claude code",
    "shared category: developer",
    "public key available"
  ]);
  assert.equal(matches[1].identity.id, "teti_low000001");
  assert.equal(matches[1].score, 0);
});

test("surfaces offline Network directory errors", async () => {
  const service = new TetiDiscoveryService({
    directory: new OfflineDirectory()
  });

  await assert.rejects(
    () => service.discoverTetis(),
    (error) => error instanceof Error && error.message === "Network directory offline"
  );
});

test("prepares a public connection request draft without sending a message", () => {
  const service = new TetiDiscoveryService({
    directory: new StaticDirectory([])
  });

  assert.deepEqual(
    service.prepareConnectionRequest({
      local: {
        id: "teti_local0001",
        address: "local0001@mail.seep.im"
      },
      remote: {
        id: "teti_remote001",
        address: "remote001@mail.seep.im",
        publicKey: "remote-public-key",
        publicProfile: {}
      },
      publicContext: {
        purpose: "pairing"
      }
    }),
    {
      to: {
        id: "teti_remote001",
        address: "remote001@mail.seep.im",
        publicKey: "remote-public-key"
      },
      from: {
        id: "teti_local0001",
        address: "local0001@mail.seep.im"
      },
      intent: "connect",
      publicContext: {
        purpose: "pairing"
      }
    }
  );
});

class StaticDirectory implements TetiPublicDirectoryReader {
  private readonly identities: TetiPublicDirectoryIdentity[];

  constructor(identities: TetiPublicDirectoryIdentity[]) {
    this.identities = identities;
  }

  async discover(): Promise<TetiPublicDirectoryIdentity[]> {
    return this.identities;
  }

  async getIdentity(id: string): Promise<TetiPublicDirectoryIdentity | null> {
    return this.identities.find((identity) => identity.id === id) ?? null;
  }
}

class OfflineDirectory implements TetiPublicDirectoryReader {
  async discover(): Promise<TetiPublicDirectoryIdentity[]> {
    throw new Error("Network directory offline");
  }

  async getIdentity(): Promise<TetiPublicDirectoryIdentity | null> {
    throw new Error("Network directory offline");
  }
}
