import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { MemoryTetiConnectionStorage } from "../../../core/connection/storage.ts";
import {
  createConnectionAccept,
  createConnectionAcceptEnvelope,
  serializeConnectionEnvelope
} from "../../../core/connection/protocol.ts";
import {
  createApplicationEnvelope,
  serializeApplicationEnvelope
} from "../../../core/protocol/envelope.ts";
import type {
  ChatmailAdapter,
  SendChatmailMessageInput
} from "../../../integrations/chatmail/types.ts";
import type { TetiPublicDirectoryReader } from "../../../services/discovery/client.ts";
import type { TetiPublicDirectoryIdentity } from "../../../services/discovery/types.ts";
import { TetiNetworkClientError } from "../../../services/network/errors.ts";
import { FakeTetiNetworkClient } from "../../../services/network/fake-client.ts";
import { MemoryTetiNetworkRelationshipCommandStore } from "../../../services/network/relationship-command-store.ts";
import { TetiNetworkRelationshipService } from "../../../services/network/relationship-service.ts";
import { MemoryTetiNetworkRelationshipReconciliationStore } from "../../../services/network/relationship-reconciliation-store.ts";
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
import {
  CHATMAIL_HEARTBEAT_RETRY_DELAYS_MS,
  PeerConnectionRuntime,
  type ChatmailHeartbeatDeliveryDiagnostic
} from "../lifecycle-sidecar/connections.ts";

const SELF = "teti_aaaaaaaaa";
const PEER = "teti_bbbbbbbbb";
const RELATIONSHIP_ID = "rel_AAAAAAAAAAAAAAAAAAAAAA";

test("Beta 0.3.9 Runtime cannot start without Network Relationship authority", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  assert.throws(
    () => new PeerConnectionRuntime({
      accountStorage,
      connectionStorage: new MemoryTetiConnectionStorage(),
      chatmailAdapter: noopChatmail(),
      directory: new StaticDirectory(),
      startIo: async () => undefined
    }),
    /Network Relationship service is required/
  );
});

test("Runtime projects Network Relationship authority while retaining archived recovery state", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    reconciliationStore: new MemoryTetiNetworkRelationshipReconciliationStore(),
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
    directory: new StaticDirectory(),
    relationshipService,
    startIo: async () => undefined
  });

  const requested = await runtime.request("bbbbbbbbb");
  assert.equal(requested.connections[0]?.requestId, RELATIONSHIP_ID);
  assert.equal(requested.connections[0]?.state, "Requested");

  client.current = relationship(2, "confirmed", "outgoing");
  assert.equal((await runtime.list()).connections[0]?.state, "Confirmed");
  assert.equal((await connectionStorage.loadAll())[0]?.networkRelationship?.etag, '"relationship-r2"');
  assert.equal(
    (await connectionStorage.loadAll())[0]?.remotePublicKey,
    "peer-chatmail-public-key"
  );

  const [legacyRecovery] = await connectionStorage.loadAll();
  delete legacyRecovery!.remotePublicKey;
  await connectionStorage.saveAll([legacyRecovery!]);
  await runtime.list();
  assert.equal(
    (await connectionStorage.loadAll())[0]?.remotePublicKey,
    "peer-chatmail-public-key",
    "an existing same-revision Relationship must self-heal transport bootstrap data"
  );

  assert.equal((await runtime.block!(RELATIONSHIP_ID)).connections[0]?.state, "Blocked");
  const archived = await runtime.revoke!(RELATIONSHIP_ID);
  assert.deepEqual(archived.connections, []);
  const retained = await connectionStorage.loadAll();
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.networkRelationship?.state, "revoked");
});

test("Runtime never promotes a requested Network Relationship from a Chatmail accept", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  client.current = relationship(1, "requested", "outgoing");
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    reconciliationStore: new MemoryTetiNetworkRelationshipReconciliationStore(),
    getAuthentication: async () => ({
      tetiId: SELF,
      authentication: {
        clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
        signingKey: generateTetiNetworkSigningKey()
      }
    })
  });
  const acknowledged: number[] = [];
  const chatmail = chatmailWithMessages([{
    messageId: 91,
    fromAddress: peerIdentity().address,
    text: serializeConnectionEnvelope(createConnectionAcceptEnvelope(createConnectionAccept({
      localAccount: {
        ...account(),
        id: PEER,
        address: peerIdentity().address,
        chatmailAccountId: 2
      },
      requestId: RELATIONSHIP_ID,
      nonce: "legacy-accept",
      createdAt: "2026-08-09T00:02:00.000Z"
    })))
  }], acknowledged);
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter: chatmail,
    directory: new StaticDirectory(),
    relationshipService,
    startIo: async () => undefined
  });

  const result = await runtime.poll();

  assert.equal(result.connections[0]?.state, "Requested");
  assert.equal((await connectionStorage.loadAll())[0]?.networkRelationship?.state, "requested");
  assert.deepEqual(acknowledged, [91]);
});

test("Runtime keeps collaboration messages unacknowledged while Network authorization is unavailable", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  client.current = relationship(2, "confirmed", "outgoing");
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    reconciliationStore: new MemoryTetiNetworkRelationshipReconciliationStore(),
    getAuthentication: async () => ({
      tetiId: SELF,
      authentication: {
        clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
        signingKey: generateTetiNetworkSigningKey()
      }
    })
  });
  const acknowledged: number[] = [];
  const chatmail = chatmailWithMessages([{
    messageId: 92,
    fromAddress: peerIdentity().address,
    text: serializeApplicationEnvelope(createApplicationEnvelope({
      type: "teti.presence",
      fromTetiId: PEER,
      messageId: "network-down-message",
      createdAt: "2026-08-09T00:03:00.000Z",
      payload: {
        status: "online",
        timestamp: "2026-08-09T00:03:00.000Z",
        collaborationProtocolEpoch: 2,
        taskProtocolVersions: [7],
        passportSchemaVersions: [4]
      }
    }))
  }], acknowledged);
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter: chatmail,
    directory: new StaticDirectory(),
    relationshipService,
    startIo: async () => undefined
  });
  await runtime.list();
  client.authorizationError = new TetiNetworkClientError({
    code: "SERVER_UNAVAILABLE",
    operation: "relationship_authorization",
    message: "Network unavailable.",
    retryable: true,
    status: 503
  });

  const result = await runtime.poll();

  assert.equal(result.connections[0]?.state, "Confirmed", "stale cache remains display-only");
  assert.equal(result.receivedCount, 0);
  assert.deepEqual(acknowledged, []);
});

test("Runtime drops an in-flight collaboration message after an authoritative block", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  client.current = relationship(2, "confirmed", "outgoing");
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    reconciliationStore: new MemoryTetiNetworkRelationshipReconciliationStore(),
    getAuthentication: async () => ({
      tetiId: SELF,
      authentication: {
        clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
        signingKey: generateTetiNetworkSigningKey()
      }
    })
  });
  const acknowledged: number[] = [];
  const chatmail = chatmailWithMessages([{
    messageId: 93,
    fromAddress: peerIdentity().address,
    text: serializeApplicationEnvelope(createApplicationEnvelope({
      type: "teti.presence",
      fromTetiId: PEER,
      messageId: "blocked-in-flight-message",
      createdAt: "2026-08-09T00:04:00.000Z",
      payload: {
        status: "online",
        timestamp: "2026-08-09T00:04:00.000Z",
        collaborationProtocolEpoch: 2,
        taskProtocolVersions: [7],
        passportSchemaVersions: [4]
      }
    }))
  }], acknowledged);
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter: chatmail,
    directory: new StaticDirectory(),
    relationshipService,
    startIo: async () => undefined
  });
  await runtime.list();
  client.current = relationship(3, "blocked", "outgoing");

  const result = await runtime.poll();

  assert.equal(result.receivedCount, 0);
  assert.deepEqual(acknowledged, [93]);
});

test("Runtime imports the Network delivery key and backs off failed version Presence delivery", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const client = new RuntimeRelationshipClient();
  client.current = relationship(2, "confirmed", "outgoing");
  const relationshipService = new TetiNetworkRelationshipService({
    client,
    store: new MemoryTetiNetworkRelationshipCommandStore(),
    reconciliationStore: new MemoryTetiNetworkRelationshipReconciliationStore(),
    getAuthentication: async () => ({
      tetiId: SELF,
      authentication: {
        clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
        signingKey: generateTetiNetworkSigningKey()
      }
    })
  });
  let nowMs = Date.parse("2026-08-09T00:10:00.000Z");
  const chatmail = deliveryTrackingChatmail();
  const diagnostics: ChatmailHeartbeatDeliveryDiagnostic[] = [];
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter: chatmail.adapter,
    directory: new StaticDirectory(),
    relationshipService,
    startIo: async () => undefined,
    now: () => new Date(nowMs),
    onHeartbeatDeliveryDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  await runtime.poll();
  assert.equal(chatmail.sendCalls.length, 1);
  assert.equal(chatmail.sendCalls[0]?.peerPublicKey, "peer-chatmail-public-key");
  assert.equal(chatmail.deliveryChecks, 1);
  assert.deepEqual(diagnostics[0], {
    result: "failed",
    peerTetiId: PEER,
    attempt: 1,
    nextRetryMs: CHATMAIL_HEARTBEAT_RETRY_DELAYS_MS[0],
    message: "Relay delivery failed"
  });

  nowMs += CHATMAIL_HEARTBEAT_RETRY_DELAYS_MS[0] - 1;
  await runtime.poll();
  assert.equal(chatmail.sendCalls.length, 1, "polling inside backoff must not enqueue another heartbeat");

  chatmail.failDelivery = false;
  nowMs += 1;
  const recovered = await runtime.poll();
  assert.equal(chatmail.sendCalls.length, 2);
  assert.equal(recovered.heartbeatCount, 1);
  assert.equal(diagnostics.at(-1)?.result, "recovered");
});

class RuntimeRelationshipClient extends FakeTetiNetworkClient {
  current: TetiNetworkRelationshipDocument | null = null;
  authorizationError: unknown = null;

  constructor() {
    super(bootstrap());
  }

  override async getRelationshipSnapshot(): Promise<{
    schemaVersion: 1;
    items: TetiNetworkRelationshipDocument[];
    baseCheckpoint: string;
    page: { limit: number; returnedCount: number; nextCursor: null };
  }> {
    return {
      schemaVersion: 1,
      items: this.current ? [structuredClone(this.current)] : [],
      baseCheckpoint: "rcp_runtime",
      page: { limit: 100, returnedCount: this.current ? 1 : 0, nextCursor: null }
    };
  }

  override async getRelationshipChanges(): Promise<{
    schemaVersion: 1;
    items: [];
    checkpoint: string;
    page: { limit: number; returnedCount: 0; hasMore: false };
  }> {
    return {
      schemaVersion: 1,
      items: [],
      checkpoint: "rcp_runtime",
      page: { limit: 100, returnedCount: 0, hasMore: false }
    };
  }

  override async getRelationshipAuthorization(peerTetiId: string) {
    if (this.authorizationError) throw this.authorizationError;
    const allowed = this.current?.peerTetiId === peerTetiId && this.current.state === "confirmed";
    return {
      schemaVersion: 1 as const,
      peerTetiId,
      relationshipId: this.current?.id ?? null,
      relationshipRevision: this.current?.revision ?? null,
      decision: allowed ? "allow" as const : "deny" as const,
      reason: allowed ? "confirmed" as const : (this.current?.state ?? "not_found"),
      evaluatedAt: "2026-08-09T00:10:00.000Z"
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

class StaticDirectory implements TetiPublicDirectoryReader {
  async discover(): Promise<TetiPublicDirectoryIdentity[]> {
    return [peerIdentity()];
  }

  async getIdentity(id: string): Promise<TetiPublicDirectoryIdentity | null> {
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

function chatmailWithMessages(
  initial: Array<{ messageId: number; text: string; fromAddress: string }>,
  acknowledged: number[]
): ChatmailAdapter {
  const messages = [...initial];
  return {
    ...noopChatmail(),
    receiveMessages: async () => messages.splice(0),
    acknowledgeReceivedMessage: async (_accountId, messageId) => { acknowledged.push(messageId); }
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

function peerIdentity(): TetiPublicDirectoryIdentity {
  return {
    version: 1,
    id: PEER,
    address: "existin02@mail.seep.im",
    publicKey: "peer-chatmail-public-key",
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
  };
}

function deliveryTrackingChatmail(): {
  adapter: ChatmailAdapter;
  sendCalls: SendChatmailMessageInput[];
  deliveryChecks: number;
  failDelivery: boolean;
} {
  const state = {
    sendCalls: [] as SendChatmailMessageInput[],
    deliveryChecks: 0,
    failDelivery: true
  };
  return {
    ...state,
    get deliveryChecks() { return state.deliveryChecks; },
    get failDelivery() { return state.failDelivery; },
    set failDelivery(value: boolean) { state.failDelivery = value; },
    adapter: {
      ...noopChatmail(),
      sendMessage: async (input) => {
        state.sendCalls.push(structuredClone(input));
        return { messageId: state.sendCalls.length };
      },
      waitForDelivery: async () => {
        state.deliveryChecks += 1;
        if (state.failDelivery) throw new Error("Relay delivery failed");
        return { messageId: state.deliveryChecks, state: 26 };
      }
    }
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
    contractRevision: 8,
    service: { name: "teti-network" as const, version: "0.1.8" },
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
