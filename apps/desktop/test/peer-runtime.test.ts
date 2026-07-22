import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { createConnectionRequest } from "../../../core/connection/protocol.ts";
import {
  MemoryTetiConnectionStorage,
  type TetiConnectionStorage
} from "../../../core/connection/storage.ts";
import type { TetiConnectionRecord, TetiConnectionState } from "../../../core/connection/types.ts";
import type { AiToolStatusSnapshot } from "../../../core/ai-status/types.ts";
import type {
  ChatmailAdapter,
  ChatmailIdentity,
  ChatmailPublicIdentity,
  ChatmailReceivedMessage,
  ChatmailSentMessage,
  CreateChatmailAccountInput,
  DeleteChatmailAccountInput,
  LoadChatmailAccountInput,
  ReceiveChatmailMessagesInput,
  SendChatmailMessageInput
} from "../../../integrations/chatmail/types.ts";
import type { TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { DiscoveryIdentity } from "../../../services/discovery/registry-client.ts";
import { PeerConnectionRuntime } from "../lifecycle-sidecar/connections.ts";
import {
  MemoryPassportSharingStore,
  resourceSharingPolicy
} from "../lifecycle-sidecar/runtime/passport/sharing.ts";

test("two Teti runtimes confirm a Chatmail handshake and exchange alpha heartbeats", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);

  const requested = await runtimeA.request("beta00002");
  assert.equal(requested.connections[0]?.state, "Requested");

  const incoming = await runtimeB.poll();
  assert.equal(incoming.connections[0]?.state, "PendingApproval");

  const accepted = await runtimeB.accept(incoming.connections[0]!.requestId);
  assert.equal(accepted.connections[0]?.state, "Confirmed");
  assert.ok(accepted.connections[0]?.lastHeartbeatSentAt);

  const confirmed = await runtimeA.poll();
  assert.equal(confirmed.connections[0]?.state, "Confirmed");
  assert.ok(confirmed.connections[0]?.lastHeartbeatReceivedAt);
  assert.ok(confirmed.connections[0]?.lastHeartbeatSentAt);

  const heartbeatReturn = await runtimeB.poll();
  assert.ok(heartbeatReturn.connections[0]?.lastHeartbeatReceivedAt);

  const repeated = await runtimeA.request("beta00002");
  assert.equal(repeated.requestOutcome?.kind, "alreadyConfirmed");
  assert.equal(repeated.connections.length, 1);
});

test("reciprocal intent accepts a relayed request and confirms both Teti instances", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);

  const requested = await runtimeA.request("beta00002");
  assert.equal(requested.connections[0]?.state, "Requested");
  assert.equal(requested.requestOutcome?.kind, "created");

  const repeated = await runtimeA.request("beta00002");
  assert.equal(repeated.requestOutcome?.kind, "alreadyRequested");
  assert.equal(repeated.connections.length, 1);

  // Do not call the initiator again. The receiver starts later and must consume
  // the request retained by the relay without any sender-side participation.
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const incoming = await runtimeB.poll();

  assert.equal(incoming.connections[0]?.state, "PendingApproval");
  assert.equal(incoming.connections[0]?.direction, "incoming");

  const reciprocal = await runtimeB.request("alpha0001");
  assert.equal(reciprocal.requestOutcome?.kind, "mutualConfirmed");
  assert.equal(reciprocal.connections.length, 1);
  assert.equal(reciprocal.connections[0]?.state, "Confirmed");

  const confirmedAtA = await runtimeA.poll();
  assert.equal(confirmedAtA.connections.length, 1);
  assert.equal(confirmedAtA.connections[0]?.state, "Confirmed");
});

test("an echoed outgoing request cannot create a connection to the local identity", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);

  await runtimeA.request("beta00002");
  relay.copyLatest(accountB.address, accountA.address);
  const afterEcho = await runtimeA.poll();

  assert.equal(afterEcho.connections.length, 1);
  assert.equal(afterEcho.connections[0]?.remoteTetiId, accountB.id);
  assert.equal(afterEcho.connections[0]?.state, "Requested");
});

test("listing connections removes a previously persisted local-identity relationship", async () => {
  const local = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const registry = new StaticRegistry([toIdentity(local)]);
  const storage = new MemoryTetiConnectionStorage();
  await storage.saveAll([
    makeConnectionRecord(local, "Confirmed", "2026-07-17T01:00:00.000Z")
  ]);
  const runtime = await makeRuntime(
    local,
    new MemoryChatmailRelay().adapter(local.address),
    registry,
    storage
  );

  assert.deepEqual((await runtime.list()).connections, []);
  assert.deepEqual(await storage.loadAll(), []);
});

test("confirmed peers sort by confirmation time and waiting records stay last", async () => {
  const local = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const older = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const newer = makeAccount("teti_gamma0003", "gamma0003@mail.seep.im", 3);
  const rejected = makeAccount("teti_delta0004", "delta0004@mail.seep.im", 4);
  const waiting = makeAccount("teti_omega0005", "omega0005@mail.seep.im", 5);
  const registry = new StaticRegistry([local, older, newer, rejected, waiting].map(toIdentity));
  const storage = new MemoryTetiConnectionStorage();
  await storage.saveAll([
    makeConnectionRecord(waiting, "PendingApproval", "2026-07-17T05:00:00.000Z"),
    makeConnectionRecord(older, "Confirmed", "2026-07-17T01:00:00.000Z"),
    makeConnectionRecord(rejected, "Rejected", "2026-07-17T04:00:00.000Z"),
    makeConnectionRecord(newer, "Confirmed", "2026-07-17T03:00:00.000Z")
  ]);
  const runtime = await makeRuntime(
    local,
    new MemoryChatmailRelay().adapter(local.address),
    registry,
    storage
  );

  const listed = await runtime.list();
  assert.deepEqual(listed.connections.map((connection) => connection.remoteTetiId), [
    newer.id,
    older.id,
    rejected.id,
    waiting.id
  ]);
  assert.equal(listed.connections[0]?.confirmedAt, "2026-07-17T03:00:00.000Z");
});

test("AI status is opt-in, sent only to confirmed peers, and revoked independently of heartbeats", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(
    accountA,
    relay.adapter(accountA.address),
    registry,
    new MemoryTetiConnectionStorage(),
    {
      passportSharing: new MemoryPassportSharingStore(),
      getLocalAiTools: () => [localCodexStatus()]
    }
  );
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);

  await runtimeA.request("beta00002");
  const incoming = await runtimeB.poll();
  await runtimeB.accept(incoming.connections[0]!.requestId);
  const confirmed = await runtimeA.poll();
  await runtimeB.poll();
  assert.equal(confirmed.connections[0]?.remoteAiStatus, undefined);
  assert.deepEqual(await runtimeA.getPassportSharing(), resourceSharingPolicy(false));

  await runtimeA.setPassportSharing(resourceSharingPolicy(true));
  await flushBackgroundWork();
  const shared = await runtimeB.poll();
  assert.equal(shared.connections[0]?.remoteAiStatus?.sharing, "enabled");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.toolId, "openai.codex");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.plan.key, "plus");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.quotas[0]?.remainingPercent, 42);
  assert.doesNotMatch(JSON.stringify(shared.connections[0]?.remoteAiStatus), /token|account|raw|displayName/);

  await runtimeA.setPassportSharing(resourceSharingPolicy(false));
  await flushBackgroundWork();
  const revoked = await runtimeB.poll();
  assert.equal(revoked.connections[0]?.remoteAiStatus?.sharing, "disabled");
  assert.deepEqual(revoked.connections[0]?.remoteAiStatus?.tools, []);
});

test("sharing consent persistence does not wait for a blocked peer network queue", async () => {
  const account = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account);
  let releaseIo!: () => void;
  const ioBlocked = new Promise<void>((resolve) => { releaseIo = resolve; });
  const runtime = new PeerConnectionRuntime({
    accountStorage,
    connectionStorage: new MemoryTetiConnectionStorage(),
    chatmailAdapter: new MemoryChatmailRelay().adapter(account.address),
    registry: new StaticRegistry([toIdentity(account)]),
    startIo: () => ioBlocked,
    passportSharing: new MemoryPassportSharingStore()
  });

  const polling = runtime.poll();
  await flushBackgroundWork();
  const result = await Promise.race([
    runtime.setPassportSharing(resourceSharingPolicy(true)).then(() => "saved"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50))
  ]);
  releaseIo();
  await polling;

  assert.equal(result, "saved");
  assert.deepEqual(await runtime.getPassportSharing(), resourceSharingPolicy(true));
});

async function makeRuntime(
  account: TetiAccount,
  chatmailAdapter: ChatmailAdapter,
  registry: TetiRegistryReader,
  connectionStorage: TetiConnectionStorage = new MemoryTetiConnectionStorage(),
  aiStatus: {
    passportSharing?: MemoryPassportSharingStore;
    getLocalAiTools?: () => AiToolStatusSnapshot[];
  } = {}
): Promise<PeerConnectionRuntime> {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account);
  return new PeerConnectionRuntime({
    accountStorage,
    connectionStorage,
    chatmailAdapter,
    registry,
    startIo: async () => undefined,
    ...aiStatus
  });
}

function localCodexStatus(): AiToolStatusSnapshot {
  return {
    toolId: "openai.codex",
    status: "ready",
    plan: { key: "plus", membershipVerified: false },
    quotas: [{
      period: "week",
      remainingPercent: 42,
      resetAt: "2026-07-20T00:00:00.000Z",
      windowSeconds: 604_800,
      identification: "exact"
    }],
    observedAt: "2026-07-18T01:00:00.000Z"
  };
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeConnectionRecord(
  remote: TetiAccount,
  state: TetiConnectionState,
  timestamp: string
): TetiConnectionRecord {
  const request = createConnectionRequest({
    localAccount: remote,
    requestId: `request-${remote.id}`,
    nonce: `nonce-${remote.id}-1234567890`,
    createdAt: timestamp
  });
  return {
    version: 1,
    requestId: request.requestId,
    state,
    direction: "incoming",
    remoteTetiId: remote.id,
    remoteAddress: remote.address,
    request,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(state === "Confirmed" ? { confirmedAt: timestamp } : {}),
    ...(state === "Rejected" ? { rejectedAt: timestamp } : {})
  };
}

function makeAccount(id: string, address: string, chatmailAccountId: number): TetiAccount {
  return {
    version: 1,
    id,
    address,
    displayName: id === "teti_alpha0001" ? "Alpha" : "Beta",
    chatmailAccountId,
    publicKey: `${id}-public-key-material-1234567890`,
    publicProfile: { platform: "macOS", category: ["developer"], aiEnvironment: ["Teti"] },
    createdAt: "2026-07-16T00:00:00.000Z"
  };
}

function toIdentity(account: TetiAccount): DiscoveryIdentity {
  return {
    version: 1,
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    publicKey: account.publicKey,
    publicProfile: account.publicProfile
  };
}

class StaticRegistry implements TetiRegistryReader {
  private readonly identities: DiscoveryIdentity[];
  constructor(identities: DiscoveryIdentity[]) { this.identities = identities; }
  async discover(): Promise<DiscoveryIdentity[]> { return this.identities; }
  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return this.identities.find((identity) => identity.id === id) ?? null;
  }
}

class MemoryChatmailRelay {
  private readonly queues = new Map<string, ChatmailReceivedMessage[]>();
  private nextMessageId = 1;

  adapter(fromAddress: string): ChatmailAdapter {
    return new RelayAdapter(this, fromAddress);
  }

  send(fromAddress: string, input: SendChatmailMessageInput): ChatmailSentMessage {
    const messageId = this.nextMessageId++;
    const queue = this.queues.get(input.peerAddress) ?? [];
    queue.push({
      messageId,
      chatId: messageId,
      fromAddress,
      text: input.text,
      receivedAt: new Date().toISOString()
    });
    this.queues.set(input.peerAddress, queue);
    return { messageId, chatId: messageId };
  }

  receive(address: string, limit?: number): ChatmailReceivedMessage[] {
    const queue = this.queues.get(address) ?? [];
    const count = limit ?? queue.length;
    return queue.splice(0, count);
  }

  copyLatest(sourceAddress: string, targetAddress: string): void {
    const latest = this.queues.get(sourceAddress)?.at(-1);
    if (!latest) throw new Error(`No relayed message exists for ${sourceAddress}.`);
    const target = this.queues.get(targetAddress) ?? [];
    target.push({ ...latest });
    this.queues.set(targetAddress, target);
  }
}

class RelayAdapter implements ChatmailAdapter {
  private readonly relay: MemoryChatmailRelay;
  private readonly address: string;
  constructor(relay: MemoryChatmailRelay, address: string) {
    this.relay = relay;
    this.address = address;
  }
  async sendMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    return this.relay.send(this.address, input);
  }
  async receiveMessages(input: ReceiveChatmailMessagesInput): Promise<ChatmailReceivedMessage[]> {
    return this.relay.receive(this.address, input.limit);
  }
  async createAccount(_input: CreateChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async loadAccount(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async getIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async getPublicIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity> { throw new Error("unused"); }
  async deleteAccount(_input: DeleteChatmailAccountInput): Promise<void> { throw new Error("unused"); }
}
