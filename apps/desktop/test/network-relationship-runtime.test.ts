import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { MemoryTetiConnectionStorage } from "../../../core/connection/storage.ts";
import type { ChatmailAdapter } from "../../../integrations/chatmail/types.ts";
import type { TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { DiscoveryIdentity } from "../../../services/discovery/registry-client.ts";
import { TetiNetworkClientError } from "../../../services/network/errors.ts";
import { FakeTetiNetworkClient } from "../../../services/network/fake-client.ts";
import { MemoryTetiNetworkRelationshipCommandStore } from "../../../services/network/relationship-command-store.ts";
import { TetiNetworkRelationshipService } from "../../../services/network/relationship-service.ts";
import { generateTetiNetworkSigningKey } from "../../../services/network/signing.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkMutateRelationshipRequest,
  TetiNetworkRelationshipCommand,
  TetiNetworkRelationshipDocument,
  TetiNetworkRelationshipResult,
  TetiNetworkRelationshipWriteOptions,
  TetiNetworkRequestRelationshipRequest
} from "../../../services/network/types.ts";
import { PeerConnectionRuntime } from "../lifecycle-sidecar/connections.ts";

const SELF = "teti_aaaaaaaaa";
const PEER = "teti_bbbbbbbbb";
const RELATIONSHIP_ID = "rel_AAAAAAAAAAAAAAAAAAAAAA";

test("Runtime projects Network Relationship authority while retaining archived recovery state", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    getAuthentication: async () => ({
      tetiId: SELF,
      authentication: {
        clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
        signingKey: generateTetiNetworkSigningKey()
      }
    }),
    idempotencyKeyFactory: (operation) => `relationship.${operation}:runtime-000000000000`
  });
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter: noopChatmail(),
    registry: new StaticRegistry(),
    relationshipService,
    startIo: async () => undefined
  });

  const requested = await runtime.request("bbbbbbbbb");
  assert.equal(requested.connections[0]?.requestId, RELATIONSHIP_ID);
  assert.equal(requested.connections[0]?.state, "Requested");

  client.current = relationship(2, "confirmed", "outgoing");
  assert.equal((await runtime.list()).connections[0]?.state, "Confirmed");
  assert.equal((await connectionStorage.loadAll())[0]?.networkRelationship?.etag, '"relationship-r2"');

  assert.equal((await runtime.block!(RELATIONSHIP_ID)).connections[0]?.state, "Blocked");
  const archived = await runtime.revoke!(RELATIONSHIP_ID);
  assert.deepEqual(archived.connections, []);
  const retained = await connectionStorage.loadAll();
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.networkRelationship?.state, "revoked");
});

class RuntimeRelationshipClient extends FakeTetiNetworkClient {
  current: TetiNetworkRelationshipDocument | null = null;

  constructor() {
    super(bootstrap());
  }

  override async listRelationships(): Promise<{
    items: TetiNetworkRelationshipDocument[];
    page: { limit: number; returnedCount: number; nextCursor: null };
  }> {
    return {
      items: this.current ? [structuredClone(this.current)] : [],
      page: { limit: 100, returnedCount: this.current ? 1 : 0, nextCursor: null }
    };
  }

  override async getRelationship(id: string): Promise<TetiNetworkRelationshipResult> {
    if (!this.current || this.current.id !== id) throw notFound();
    return result(this.current);
  }

  override async getRelationshipWithPeer(peer: string): Promise<TetiNetworkRelationshipResult> {
    if (!this.current || this.current.peerTetiId !== peer) throw notFound();
    return result(this.current);
  }

  override async requestRelationship(
    input: TetiNetworkRequestRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    _options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    this.current = relationship((this.current?.revision ?? 0) + 1, "requested", "outgoing");
    return result(this.current);
  }

  override async mutateRelationship(
    _id: string,
    command: TetiNetworkRelationshipCommand,
    _input: TetiNetworkMutateRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    _options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    const state = command === "accept"
      ? "confirmed"
      : command === "reject"
        ? "rejected"
        : command === "block"
          ? "blocked"
          : "revoked";
    this.current = relationship((this.current?.revision ?? 0) + 1, state, this.current?.direction ?? "outgoing");
    return result(this.current);
  }
}

class StaticRegistry implements TetiRegistryReader {
  async discover(): Promise<DiscoveryIdentity[]> {
    return [peerIdentity()];
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return id === PEER ? peerIdentity() : null;
  }
}

function noopChatmail(): ChatmailAdapter {
  return {
    createAccount: async () => ({ accountId: 1, address: account().address, isConfigured: true, isChatmail: true }),
    loadAccount: async () => ({ accountId: 1, address: account().address, isConfigured: true, isChatmail: true }),
    getIdentity: async () => ({ accountId: 1, address: account().address, isConfigured: true, isChatmail: true }),
    getPublicIdentity: async () => ({ address: account().address }),
    sendMessage: async () => ({ messageId: 1 }),
    receiveMessages: async () => [],
    deleteAccount: async () => undefined
  };
}

function account(): TetiAccount {
  return {
    version: 1,
    id: SELF,
    address: "existin01@mail.seep.im",
    chatmailAccountId: 1,
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
    createdAt: "2026-08-09T00:00:00.000Z"
  };
}

function peerIdentity(): DiscoveryIdentity {
  return {
    version: 1,
    id: PEER,
    address: "existin02@mail.seep.im",
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
  };
}

function relationship(
  revision: number,
  state: TetiNetworkRelationshipDocument["state"],
  direction: TetiNetworkRelationshipDocument["direction"]
): TetiNetworkRelationshipDocument {
  return {
    schemaVersion: 1,
    id: RELATIONSHIP_ID,
    revision,
    state,
    peerTetiId: PEER,
    requesterTetiId: direction === "outgoing" ? SELF : PEER,
    addresseeTetiId: direction === "outgoing" ? PEER : SELF,
    direction,
    blockedBy: state === "blocked" ? "self" : null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: `2026-08-09T00:0${revision}:00.000Z`,
    stateChangedAt: `2026-08-09T00:0${revision}:00.000Z`
  };
}

function result(document: TetiNetworkRelationshipDocument): TetiNetworkRelationshipResult {
  return { document: structuredClone(document), etag: `"relationship-r${document.revision}"` };
}

function notFound(): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "RELATIONSHIP_NOT_FOUND",
    operation: "relationship_get",
    message: "Not found.",
    retryable: false,
    status: 404
  });
}

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-09T00:00:00.000Z",
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
