import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { createConnectionRequest } from "../../../core/connection/protocol.ts";
import {
  MemoryTetiConnectionStorage,
  type TetiConnectionStorage
} from "../../../core/connection/storage.ts";
import type { TetiConnectionRecord, TetiConnectionState } from "../../../core/connection/types.ts";
import type {
  AiStatusSyncPayload,
  AiToolStatusSnapshot
} from "../../../core/ai-status/types.ts";
import type { CallableAgent } from "../../../core/callability/types.ts";
import {
  createApplicationEnvelope,
  parseApplicationEnvelope,
  serializeApplicationEnvelope
} from "../../../core/protocol/envelope.ts";
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
import {
  MemoryPeerProtocolCapabilityStore,
  type PeerProtocolCapabilityStore
} from "../lifecycle-sidecar/runtime/passport/peer-capabilities.ts";
import { MemoryTaskTransportStore } from "../lifecycle-sidecar/runtime/tasks/store.ts";
import { FileTaskAttachmentStore } from "../lifecycle-sidecar/runtime/tasks/attachments.ts";
import type { TaskExecutionBridge } from "../lifecycle-sidecar/runtime/tasks/service.ts";
import type {
  CallableAdapterTaskRequest,
  CallableAdapterTaskSnapshot
} from "../../../core/callability/adapter.ts";
import type { TetiTaskTransportStoreState } from "../../../core/task/transport.ts";
import type { TaskImagePart } from "../../../core/task/types.ts";
import type { ExecutionHandle, PrepareExecutionHandleInput } from "../../../core/callability/execution.ts";
import type { ExecutionAuthority } from "../../../core/callability/agent-core.ts";
import { FileCollaborationWorkspaceStore } from "../lifecycle-sidecar/runtime/workspaces/store.ts";

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

test("a due heartbeat is sent before polling a peer backlog", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  let nowMs = Date.now() + 1_000;
  const now = () => new Date(nowMs);
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, { now });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, { now });
  await confirmPeers(runtimeA, runtimeB, "beta00002");

  relay.clearEvents(accountA.address);
  nowMs += 5_000;
  await runtimeA.poll();

  assert.deepEqual(relay.eventsFor(accountA.address).slice(0, 2), ["send", "receive"]);
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

test("peer profile refresh recovers a nickname after Registry connectivity returns and stays outside Chatmail poll", async () => {
  const local = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const remote = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new RecoveringRegistry([toIdentity(local), toIdentity(remote)]);
  const storage = new MemoryTetiConnectionStorage();
  await storage.saveAll([
    makeConnectionRecord(remote, "Confirmed", "2026-07-17T01:00:00.000Z")
  ]);
  const runtime = await makeRuntime(
    local,
    new MemoryChatmailRelay().adapter(local.address),
    registry,
    storage
  );

  assert.equal((await runtime.list()).connections[0]?.remoteDisplayName, undefined);
  assert.equal((await runtime.refreshPeerProfiles()).failedPeerCount, 1);
  registry.online = true;
  assert.equal((await runtime.refreshPeerProfiles()).failedPeerCount, 0);
  assert.equal((await runtime.list()).connections[0]?.remoteDisplayName, "Beta");

  const profileCalls = registry.profileCalls;
  await runtime.poll();
  assert.equal(registry.profileCalls, profileCalls, "Chatmail polling must not perform Registry Profile I/O");
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
      getLocalAiTools: () => [localCodexStatus()],
      getLocalCallableAgents: () => [localCodexAgent()]
    }
  );
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);

  await runtimeA.request("beta00002");
  const incoming = await runtimeB.poll();
  await runtimeB.accept(incoming.connections[0]!.requestId);
  const confirmed = await runtimeA.poll();
  await runtimeB.poll();
  assert.equal(confirmed.connections[0]?.remoteAiStatus, undefined);
  assert.deepEqual(
    confirmed.connections[0]?.remoteProtocolCapabilities?.passportSchemaVersions,
    [4]
  );
  assert.deepEqual(
    confirmed.connections[0]?.remoteProtocolCapabilities?.taskProtocolVersions,
    [6]
  );
  assert.deepEqual(await runtimeA.getPassportSharing(), resourceSharingPolicy(false));

  await runtimeA.setPassportSharing(resourceSharingPolicy(true));
  await flushBackgroundWork();
  const schemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(schemas, [4], "current peers receive one Compute Passport payload");
  const shared = await runtimeB.poll();
  assert.equal(shared.connections[0]?.remoteAiStatus?.sharing, "enabled");
  assert.equal(shared.connections[0]?.remoteAiStatus?.schemaVersion, 4);
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.toolId, "openai.codex");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.plan.key, "plus");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.quotas[0]?.remainingPercent, 42);
  assert.equal(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 4
      ? shared.connections[0].remoteAiStatus.agents[0]?.id
      : undefined,
    "codex"
  );
  assert.equal(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 4
      ? shared.connections[0].remoteAiStatus.capabilities[0]?.id
      : undefined,
    "code-analysis"
  );
  assert.deepEqual(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 4
      ? shared.connections[0].remoteAiStatus.bindings[0]?.agentIds
      : undefined,
    ["codex"]
  );
  assert.doesNotMatch(
    JSON.stringify(shared.connections[0]?.remoteAiStatus),
    /"(?:token|accountId|raw|displayName|version|runtimeStatus|processCount|command|path|entrypoint|adapterId)"/i
  );

  // Explicit Presence capability exchange keeps the response on one current
  // schema without inferring protocol support from Passport content.
  await runtimeB.setPassportSharing(resourceSharingPolicy(true));
  await flushBackgroundWork();
  const responseSchemas = relay.peek(accountA.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(responseSchemas, [4], "known current peers receive one negotiated payload");
  await runtimeA.poll();

  await runtimeA.setPassportSharing(resourceSharingPolicy(false));
  await flushBackgroundWork();
  const revokeSchemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(revokeSchemas, [4]);
  const revoked = await runtimeB.poll();
  assert.equal(revoked.connections[0]?.remoteAiStatus?.sharing, "disabled");
  assert.deepEqual(revoked.connections[0]?.remoteAiStatus?.tools, []);
  assert.deepEqual(
    revoked.connections[0]?.remoteAiStatus?.schemaVersion === 4
      ? revoked.connections[0].remoteAiStatus.agents
      : undefined,
    []
  );
});

test("a delayed legacy Passport is rejected without downgrading an established schema 4 snapshot", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    passportSharing: new MemoryPassportSharingStore(resourceSharingPolicy(true)),
    getLocalAiTools: () => [localCodexStatus()],
    getLocalCallableAgents: () => [localCodexAgent()]
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  await confirmPeers(runtimeA, runtimeB, "beta00002");
  assert.equal((await runtimeB.list()).connections[0]?.remoteAiStatus?.schemaVersion, 4);

  const delayedLegacy = {
    version: 2,
    type: "teti.ai.status.sync",
    messageId: "delayed-legacy-passport",
    fromTetiId: accountA.id,
    createdAt: "2099-01-01T00:00:00.000Z",
    payload: {
      schemaVersion: 1,
      sharing: "disabled",
      generatedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:30:00.000Z",
      tools: []
    } satisfies AiStatusSyncPayload
  };
  relay.pushRaw(accountB.address, accountA.address, JSON.stringify(delayedLegacy));

  const afterLegacy = await runtimeB.poll();
  assert.equal(afterLegacy.connections[0]?.remoteAiStatus?.schemaVersion, 4);
  assert.equal(afterLegacy.connections[0]?.remoteAiStatus?.sharing, "enabled");
});

test("out-of-order schema 4 Passport snapshots keep the newest generation", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  await confirmPeers(runtimeA, runtimeB, "beta00002");

  for (const generatedAt of ["2026-07-27T04:00:00.000Z", "2026-07-27T03:00:00.000Z"]) {
    const envelope = createApplicationEnvelope({
      type: "teti.ai.status.sync",
      messageId: `passport-${generatedAt}`,
      fromTetiId: accountA.id,
      createdAt: generatedAt,
      payload: emptyCallablePassport(generatedAt)
    });
    relay.pushRaw(accountB.address, accountA.address, serializeApplicationEnvelope(envelope));
  }

  const result = await runtimeB.poll();
  assert.equal(result.connections[0]?.remoteAiStatus?.schemaVersion, 4);
  assert.equal(result.connections[0]?.remoteAiStatus?.generatedAt, "2026-07-27T04:00:00.000Z");
});

test("a dropped schema 4 Passport is retried without legacy fallback", async () => {
  let nowMs = Date.parse("2026-07-27T05:00:00.000Z");
  const now = () => new Date(nowMs);
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    now,
    passportSharing: new MemoryPassportSharingStore(resourceSharingPolicy(true)),
    getLocalCallableAgents: () => [localCodexAgent()]
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, { now });

  await runtimeA.request("beta00002");
  const incoming = await runtimeB.poll();
  await runtimeB.accept(incoming.connections[0]!.requestId);
  await runtimeA.poll();
  assert.equal(relay.dropFirstApplicationMessage(accountB.address, "teti.ai.status.sync"), true);
  assert.equal((await runtimeB.poll()).connections[0]?.remoteAiStatus, undefined);

  nowMs += 10 * 60 * 1_000 + 1;
  await runtimeA.poll();
  const retrySchemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(retrySchemas, [4]);
  assert.equal((await runtimeB.poll()).connections[0]?.remoteAiStatus?.schemaVersion, 4);
});

test("Runtime restart retains explicit Peer capability and immediately resends schema 4", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const connectionsA = new MemoryTetiConnectionStorage();
  const sharingA = new MemoryPassportSharingStore(resourceSharingPolicy(true));
  const protocolsA = new MemoryPeerProtocolCapabilityStore();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, connectionsA, {
    passportSharing: sharingA,
    peerProtocolCapabilities: protocolsA,
    getLocalCallableAgents: () => [localCodexAgent()]
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  await confirmPeers(runtimeA, runtimeB, "beta00002");
  assert.deepEqual((await protocolsA.get(accountB.id))?.passportSchemaVersions, [4]);

  const restarted = await makeRuntime(accountA, relay.adapter(accountA.address), registry, connectionsA, {
    passportSharing: sharingA,
    peerProtocolCapabilities: protocolsA,
    getLocalCallableAgents: () => [localCodexAgent()]
  });
  await restarted.poll();
  const schemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(schemas, [4]);
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

test("Chatmail keeps a Task offline, receiver stores it once, and returns a receipt offline", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const taskStoreA = new MemoryTaskTransportStore();
  const taskStoreB = new MemoryTaskTransportStore();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    taskTransportStore: taskStoreA,
    taskIdFactory: () => "task-offline-001"
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskTransportStore: taskStoreB
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");

  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "code-analysis",
    text: "Analyze this explicitly shared text.",
    ttlMs: 60_000
  });
  assert.equal(sent.delivery, "sent");
  assert.equal(relay.peek(accountB.address).filter(isTaskRequestMessage).length, 1);

  // B has not polled since the send. The relay is the offline queue.
  relay.copyLatest(accountB.address, accountB.address);
  await runtimeB.poll();
  const received = await runtimeB.listTasks();
  assert.equal(received.records.length, 1, "duplicate envelopes create one Task record");
  assert.equal(received.records[0]?.direction, "incoming");
  assert.equal(received.records[0]?.approval, "pending");
  assert.equal(received.records[0]?.state, "submitted");

  // A is offline while B emits receipts; A later consumes the queued receipts.
  await runtimeA.poll();
  const acknowledged = await runtimeA.listTasks();
  assert.equal(acknowledged.records.length, 1);
  assert.equal(acknowledged.records[0]?.delivery, "acknowledged");
  assert.deepEqual(acknowledged.peers[0]?.supportedVersions, [6]);
});

test("Task ID retry is idempotent and conflicting immutable content is rejected", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const input = {
    connectionRequestId: connection.requestId,
    taskId: "task-stable-001",
    capabilityId: "code-analysis",
    text: "Same immutable content.",
    ttlMs: 60_000
  };

  const first = await runtimeA.sendTask(input);
  const repeated = await runtimeA.sendTask(input);
  assert.equal(first.envelopeMessageId, repeated.envelopeMessageId);
  assert.equal(relay.peek(accountB.address).filter(isTaskRequestMessage).length, 1);
  await assert.rejects(
    () => runtimeA.sendTask({ ...input, text: "Different content." }),
    /already bound/
  );
});

test("expired offline Task never enters pending approval", async () => {
  let nowMs = Date.parse("2026-07-26T02:00:00.000Z");
  const now = () => new Date(nowMs);
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, { now });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, { now });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-expiring-001",
    capabilityId: "code-analysis",
    text: "This request will expire offline.",
    ttlMs: 1_000
  });
  nowMs += 2_000;

  await runtimeB.poll();
  const received = await runtimeB.listTasks();
  assert.equal(received.records[0]?.delivery, "expired");
  assert.equal(received.records[0]?.approval, "expired");
  assert.equal(received.records[0]?.state, "rejected");
});

test("known incompatible Task protocol prevents speculative transport", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const taskStore = new MemoryTaskTransportStore({
    schemaVersion: 2,
    records: [],
    peers: [{
      tetiId: accountB.id,
      supportedVersions: [4],
      observedAt: "2026-07-26T00:00:00.000Z"
    }]
  });
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    taskTransportStore: taskStore
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  await taskStore.save({
    schemaVersion: 2,
    records: [],
    peers: [{
      tetiId: accountB.id,
      supportedVersions: [4],
      observedAt: "2026-07-26T03:00:00.000Z"
    }]
  });

  await assert.rejects(() => runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "code-analysis",
    text: "Do not send this.",
    ttlMs: 60_000
  }), /compatible Task version/);
  assert.equal(relay.peek(accountB.address).filter(isTaskRequestMessage).length, 0);
});

test("a confirmed 0.1 peer is reachable but explicitly requires upgrade and cannot receive Tasks", async () => {
  const timestamp = "2026-07-28T08:00:00.000Z";
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const connections = new MemoryTetiConnectionStorage();
  await connections.saveAll([makeConnectionRecord(accountB, "Confirmed", timestamp)]);
  const runtimeA = await makeRuntime(
    accountA,
    relay.adapter(accountA.address),
    registry,
    connections
  );
  relay.pushRaw(accountA.address, accountB.address, JSON.stringify({
    version: 1,
    type: "teti.presence",
    messageId: "legacy-heartbeat",
    fromTetiId: accountB.id,
    createdAt: timestamp,
    payload: { status: "alpha-heartbeat", timestamp }
  }));

  const result = await runtimeA.poll();
  assert.equal(result.connections[0]?.remoteProtocolCapabilities?.collaborationProtocolEpoch, 1);
  assert.ok(result.connections[0]?.lastHeartbeatReceivedAt, "legacy traffic still proves reachability");
  await assert.rejects(() => runtimeA.sendTask({
    connectionRequestId: result.connections[0]!.requestId,
    capabilityId: "code-analysis",
    text: "Do not deliver this to 0.1."
  }), /must upgrade to Beta 0.2/);
  assert.equal(relay.peek(accountB.address).filter(isTaskRequestMessage).length, 0);
});

test("two peers execute an abstract receiver-local Compute Offer without sharing Runtime bindings", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new FakeLocalComputeTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    offerId: "local.compute.general-text-assistance.v1",
    capabilityId: "general-text-assistance",
    text: "Summarize this with receiver-local compute."
  });
  assert.equal(sent.request.offerId, "local.compute.general-text-assistance.v1");
  assert.doesNotMatch(
    JSON.stringify(sent.request),
    /"(?:endpoint|port|model|path|hardware|credential|token|agentId|adapterId|config)"/i
  );

  await runtimeB.poll();
  const working = await runtimeB.approveTask(sent.request.taskId);
  assert.equal(working.approval, "consumed");
  assert.equal(working.workspaceBinding?.workspaceId, `workspace:none.${sent.request.taskId}`);
  assert.deepEqual(working.workspaceBinding?.access, ["read"]);
  assert.equal(executor.resolvedOfferId, sent.request.offerId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  await runtimeA.poll();
  const result = (await runtimeA.listTasks()).records[0];
  assert.equal(result?.state, "completed");
  assert.match(JSON.stringify(result?.artifacts), /receiver-local answer/);
});

test("long-horizon collaboration survives Host restart, accepts input, and switches Child only explicitly", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const connectionsA = new MemoryTetiConnectionStorage();
  const connectionsB = new MemoryTetiConnectionStorage();
  const tasksA = new MemoryTaskTransportStore();
  const tasksB = new MemoryTaskTransportStore();
  const firstExecutor = new LongHorizonTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, connectionsA, {
    taskTransportStore: tasksA
  });
  let runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, connectionsB, {
    taskTransportStore: tasksB,
    taskExecutor: firstExecutor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "long-horizon-restart-001",
    capabilityId: "code-analysis",
    text: "分阶段分析并等待我的下一步指令。",
    ttlMs: 60_000,
    executionMode: "long_horizon"
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  let host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(host.state, "input_required");
  assert.equal(host.longHorizon?.stages.length, 1);
  assert.equal(host.longHorizon?.checkpoints.length, 1);
  assert.equal(host.longHorizon?.artifacts[0]?.role, "intermediate");
  const originalExpiry = host.longHorizon!.continuationExpiresAt;
  host = await runtimeB.pauseTask(sent.request.taskId);
  assert.equal(host.longHorizon?.phase, "paused");
  host = await runtimeB.renewTask(sent.request.taskId, 2 * 60 * 60 * 1_000);
  assert.ok(Date.parse(host.longHorizon!.continuationExpiresAt) > Date.parse(originalExpiry));
  assert.ok(host.longHorizon?.audit.some((event) => event.action === "paused"));
  assert.ok(host.longHorizon?.audit.some((event) => event.action === "renewed"));

  // Recreate the receiver Runtime at a stage boundary. The persisted Host
  // session, Workspace revision and audit are the recovery source of truth.
  const restartedExecutor = new LongHorizonTaskExecutor();
  runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, connectionsB, {
    taskTransportStore: tasksB,
    taskExecutor: restartedExecutor
  });
  await runtimeA.poll();
  const requester = await runtimeA.getTask(sent.request.taskId);
  assert.equal(requester.peerLongHorizon?.phase, "paused");
  assert.equal(requester.artifacts?.length, 1);
  assert.deepEqual(requester.peerArtifactMetadata?.map((entry) => entry.stageIndex), [1]);
  await runtimeA.submitTaskInput(sent.request.taskId, "第二阶段改用备用 Child，综合第一阶段结果。 ");
  await runtimeB.poll();
  host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(host.longHorizon?.pendingInput?.source, "remote_requester");
  assert.equal(restartedExecutor.requests.length, 0, "input delivery must not auto-run or auto-switch");

  restartedExecutor.availableSuffixes = ["b"];
  await assert.rejects(
    () => runtimeB.continueTask(sent.request.taskId),
    /explicitly select another Child Agent/,
    "an unavailable previous Child must never fall through to the first ready alternative"
  );
  await runtimeB.continueTask(sent.request.taskId, "fake-agent-b");
  await flushBackgroundWork();
  host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(host.longHorizon?.stages.length, 2);
  assert.equal(host.longHorizon?.stages[1]?.childAgentId, "fake-agent-b");
  assert.equal(host.artifacts?.length, 2);
  assert.equal(host.longHorizon?.checkpoints.length, 2);
  assert.ok(host.longHorizon?.audit.some((event) =>
    event.action === "child_selected" && event.childAgentId === "fake-agent-b"
  ));
  await runtimeB.completeTask(sent.request.taskId);
  await runtimeA.poll();
  const completed = await runtimeA.getTask(sent.request.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.artifacts?.length, 2, "final status must not overwrite intermediate Artifacts");
  assert.deepEqual(completed.peerArtifactMetadata?.map((entry) => entry.stageIndex), [1, 2]);
  assert.equal(completed.peerLongHorizon?.finalArtifactId, completed.artifacts?.[1]?.artifactId);
});

test("Teti Host executes an explicit depth-one Delegation Plan and deterministically aggregates provenance", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new DelegationTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "delegation-plan-001",
    capabilityId: "code-analysis",
    text: "先做低成本分析，再执行最终处理。",
    executionMode: "long_horizon"
  });

  await runtimeB.poll();
  const targets = await runtimeB.listTaskDelegationTargets(sent.request.taskId);
  assert.deepEqual(targets.map((target) => target.childAgentId), ["osaurus-runtime", "codex"]);
  await runtimeB.approveTaskDelegation(sent.request.taskId, targets.map((target) => ({
    childAgentId: target.childAgentId,
    connectorId: target.connectorId,
    capabilityId: target.capabilityId
  })));
  await flushBackgroundWork();
  await flushBackgroundWork();
  await flushBackgroundWork();

  const host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(host.state, "completed");
  assert.equal(host.delegationPlan?.phase, "completed");
  assert.equal(host.delegationPlan?.delegationDepth, 1);
  assert.equal(host.delegationPlan?.plannerMode, "disabled");
  assert.deepEqual(executor.requests.map((request) => [request.agentId, request.capabilityId]), [
    ["osaurus-runtime", "general-text-assistance"],
    ["codex", "image-editing"]
  ]);
  assert.match(executor.requests[1]?.input.text ?? "", /safe:osaurus-runtime:1/);
  assert.deepEqual(executor.authorities.map((authority) => authority.workspaceAccess), [
    ["read"],
    ["read", "write", "create_artifact"]
  ]);
  assert.deepEqual(executor.authorities.map((authority) => authority.capabilityId), [
    "general-text-assistance",
    "image-editing"
  ]);
  const childSteps = host.delegationPlan?.steps.filter((step) => step.kind === "child_execution") ?? [];
  assert.equal(childSteps.length, 2);
  assert.ok(childSteps.every((step) => step.state === "completed" && step.remoteAgentAccess === "deny"));
  assert.ok(childSteps.every((step) => step.budget.timeoutMs <= 15 * 60 * 1_000));
  assert.equal(host.artifacts?.length, 3);
  assert.deepEqual(host.delegationPlan?.artifacts.map((entry) => entry.producer.kind), [
    "child_agent",
    "child_agent",
    "teti_host"
  ]);
  const final = host.artifacts?.at(-1);
  assert.match(JSON.stringify(final), /Teti Host 已按冻结顺序完成 2 个 Child Agent 步骤/);
  assert.match(JSON.stringify(final), /safe:osaurus-runtime:1/);
  assert.match(JSON.stringify(final), /safe:codex:2/);

  await runtimeA.poll();
  const requester = await runtimeA.getTask(sent.request.taskId);
  assert.equal(requester.state, "completed");
  assert.equal(requester.delegationPlan, undefined, "receiver-local Delegation Plan must never enter the peer record");
  assert.equal(requester.artifacts?.length, 3);
});

test("a failed Delegation step stops the frozen plan and never auto-switches to the next Child", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new FailingDelegationTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "delegation-plan-failure-001",
    capabilityId: "code-analysis",
    text: "按两个步骤处理。",
    executionMode: "long_horizon"
  });
  await runtimeB.poll();
  const targets = await runtimeB.listTaskDelegationTargets(sent.request.taskId);
  await runtimeB.approveTaskDelegation(sent.request.taskId, targets.map((target) => ({
    childAgentId: target.childAgentId,
    connectorId: target.connectorId,
    capabilityId: target.capabilityId
  })));
  await flushBackgroundWork();
  await flushBackgroundWork();

  const host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(executor.requests.length, 1);
  assert.equal(host.delegationPlan?.phase, "failed");
  assert.deepEqual(host.delegationPlan?.steps.slice(0, 2).map((step) => step.state), ["failed", "pending"]);
  assert.equal(host.artifacts?.length ?? 0, 0);
  assert.ok(host.delegationPlan?.audit.some((event) => event.action === "step_failed"));
});

test("a Delegation target change between steps preserves prior Artifact and fails closed", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new ChangingDelegationTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "delegation-plan-target-change-001",
    capabilityId: "code-analysis",
    text: "冻结两步后执行。",
    executionMode: "long_horizon"
  });
  await runtimeB.poll();
  const targets = await runtimeB.listTaskDelegationTargets(sent.request.taskId);
  await runtimeB.approveTaskDelegation(sent.request.taskId, targets.map((target) => ({
    childAgentId: target.childAgentId,
    connectorId: target.connectorId,
    capabilityId: target.capabilityId
  })));
  await flushBackgroundWork();
  await flushBackgroundWork();

  const host = await runtimeB.getTask(sent.request.taskId);
  assert.equal(executor.requests.length, 1);
  assert.equal(host.state, "failed");
  assert.equal(host.safeErrorCode, "TASK_DELEGATION_TARGET_CHANGED");
  assert.equal(host.artifacts?.length, 1);
  assert.deepEqual(host.delegationPlan?.steps.slice(0, 2).map((step) => step.state), ["completed", "failed"]);
  assert.deepEqual(host.delegationPlan?.artifacts.map((entry) => entry.role), ["intermediate"]);
});

test("long-horizon stage rejects a changed Workspace revision and publishes no stale Artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-long-horizon-conflict-"));
  try {
    const workspaceStore = new FileCollaborationWorkspaceStore(join(root, "workspaces"));
    await workspaceStore.initialize();
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay();
    const executor = new DeferredLongHorizonTaskExecutor();
    const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
    const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
      taskExecutor: executor,
      workspaceStore
    });
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      taskId: "long-horizon-conflict-001",
      capabilityId: "code-analysis",
      text: "在固定 revision 上执行。",
      executionMode: "long_horizon"
    });
    await runtimeB.poll();
    await runtimeB.approveTask(sent.request.taskId);
    const working = await runtimeB.getTask(sent.request.taskId);
    const binding = working.workspaceBinding!;
    const foreignSnapshot = await workspaceStore.createSnapshot({
      workspaceId: binding.workspaceId,
      workspaceRevision: binding.workspaceRevision,
      access: ["read", "write"]
    });
    await workspaceStore.commitSnapshot(foreignSnapshot);
    executor.finish("stale result");
    await flushBackgroundWork();
    const conflicted = await runtimeB.getTask(sent.request.taskId);
    assert.equal(conflicted.state, "input_required");
    assert.equal(conflicted.safeErrorCode, "TASK_WORKSPACE_REVISION_CONFLICT");
    assert.equal(conflicted.artifacts?.length ?? 0, 0);
    assert.equal(conflicted.longHorizon?.checkpoints.length, 0);
    assert.ok(conflicted.longHorizon?.audit.some((event) =>
      event.safeErrorCode === "TASK_WORKSPACE_REVISION_CONFLICT"
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired long-horizon stage cannot publish an Artifact after its lease", async () => {
  let nowMs = Date.now();
  const now = () => new Date(nowMs);
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new DeferredLongHorizonTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, { now });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    now,
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "long-horizon-expiry-001",
    capabilityId: "code-analysis",
    text: "过期后不得回写。",
    ttlMs: 60_000,
    executionMode: "long_horizon"
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  nowMs += 61_000;
  executor.finish("late result");
  await flushBackgroundWork();
  const expired = await runtimeB.getTask(sent.request.taskId);
  assert.equal(expired.longHorizon?.phase, "expired");
  assert.equal(expired.artifacts?.length ?? 0, 0);
  assert.equal(expired.safeErrorCode, "TASK_EXPIRED");
});

test("two peers deliver a verified image Task, approve once, execute, and return an Artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-e2e-"));
  try {
    const source = join(root, "source.png");
    await writeFile(source, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+pkJZ5QAAAABJRU5ErkJggg==",
      "base64"
    ));
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay();
    const executor = new FakeTaskExecutor();
    const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
      taskAttachmentStore: new FileTaskAttachmentStore(join(root, "a"))
    });
    const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
      taskAttachmentStore: new FileTaskAttachmentStore(join(root, "b")),
      taskExecutor: executor
    });
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const staged = await runtimeA.stageTaskImage(source);
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      capabilityId: "code-analysis",
      text: "Read the attached pixel.",
      attachments: [staged.part]
    });
    assert.equal(sent.protocolVersion, 6);

    await runtimeB.poll();
    const inbox = await runtimeB.listTasks();
    assert.equal(inbox.records[0]?.attachmentsReady, true);
    assert.equal(inbox.records[0]?.approval, "pending");
    const working = await runtimeB.approveTask(sent.request.taskId);
    assert.equal(working.state, "working");
    assert.equal(working.approval, "consumed");
    await flushBackgroundWork();
    await flushBackgroundWork();
    await runtimeA.poll();
    const completed = await runtimeA.listTasks();
    assert.equal(completed.records[0]?.state, "completed");
    assert.equal(completed.records[0]?.artifacts?.[0]?.schemaVersion, 2);
    assert.match(JSON.stringify(completed.records[0]?.artifacts), /safe:image-result/);
    assert.equal(executor.requests[0]?.input.images?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test("two-image editing returns a verified image Artifact after completed status arrives first", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-image-artifact-e2e-"));
  try {
    const source = join(root, "source.png");
    const sourceBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+pkJZ5QAAAABJRU5ErkJggg==",
      "base64"
    );
    await writeFile(source, sourceBytes);
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay();
    const storeA = new FileTaskAttachmentStore(join(root, "a"));
    const storeB = new FileTaskAttachmentStore(join(root, "b"));
    const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
      taskAttachmentStore: storeA
    });
    const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
      taskAttachmentStore: storeB,
      taskExecutor: new FakeImageTaskExecutor(storeB, source)
    });
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const first = await runtimeA.stageTaskImage(source);
    const second = await runtimeA.stageTaskImage(source);
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      taskId: "task-two-image-result-001",
      capabilityId: "image-editing",
      text: "Merge these two reference images and return the edited image.",
      attachments: [first.part, second.part]
    });
    assert.equal(sent.protocolVersion, 6);

    await runtimeB.poll();
    await runtimeB.approveTask(sent.request.taskId);
    await waitUntil(() => relay.peek(accountA.address).some((message) => {
      if (applicationType(message) !== "teti.task.status" || !message.text) return false;
      const envelope = parseApplicationEnvelope(message.text);
      return (envelope.payload as { state?: string }).state === "completed";
    }));
    const held = relay.takeApplicationMessages(accountA.address, [
      "teti.task.attachment",
      "teti.task.artifact"
    ]);
    assert.equal(held.length, 2);

    await runtimeA.poll();
    const waiting = await runtimeA.getTask(sent.request.taskId);
    assert.equal(waiting.state, "completed");
    assert.equal(waiting.artifacts?.length ?? 0, 0);

    relay.restore(accountA.address, held);
    await runtimeA.poll();
    const completed = await runtimeA.getTask(sent.request.taskId);
    assert.equal(completed.artifactAttachmentsReady, true);
    const artifact = completed.artifacts?.[0];
    assert.equal(artifact?.schemaVersion, 2);
    const image = artifact && artifact.schemaVersion === 2
      ? artifact.parts.find((part) => part.kind === "image")
      : undefined;
    assert.ok(image && image.kind === "image");
    const resultPath = await runtimeA.resolveTaskImage(sent.request.taskId, image.attachmentId);
    assert.deepEqual(await readFile(resultPath), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test("Task v6 resends only missing images until a four-image request is complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-task-v4-image-retry-"));
  try {
    const source = join(root, "source.png");
    const sourceBytes = onePixelPng();
    await writeFile(source, sourceBytes);
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay();
    let clock = new Date();
    const now = () => new Date(clock);
    const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
      taskAttachmentStore: new FileTaskAttachmentStore(join(root, "a")),
      now
    });
    const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
      taskAttachmentStore: new FileTaskAttachmentStore(join(root, "b")),
      now
    });
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const attachments: TaskImagePart[] = [];
    for (let index = 0; index < 4; index += 1) {
      attachments.push((await runtimeA.stageTaskImage(source)).part);
    }
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      taskId: "task-v6-four-image-retry",
      capabilityId: "image-editing",
      text: "Use all four reference images.",
      attachments
    });
    assert.equal(sent.protocolVersion, 6);
    assert.equal(relay.dropFirstApplicationMessage(accountB.address, "teti.task.attachment"), true);
    assert.equal(relay.dropFirstApplicationMessage(accountB.address, "teti.task.attachment"), true);

    await runtimeB.poll();
    const partialReceiver = await runtimeB.getTask(sent.request.taskId);
    assert.equal(partialReceiver.attachmentsReady, false);
    assert.equal(
      partialReceiver.attachmentDiagnostics?.filter((item) =>
        item.purpose === "input" && item.state === "stored"
      ).length,
      2
    );
    await assert.rejects(
      () => runtimeB.approveTask(sent.request.taskId),
      /not finished downloading/
    );
    await runtimeA.poll();
    const partiallyAcknowledged = await runtimeA.getTask(sent.request.taskId);
    assert.equal(partiallyAcknowledged.acknowledgedAttachmentIds?.length, 2);
    assert.equal(
      partiallyAcknowledged.attachmentDiagnostics?.filter((item) => item.state === "acknowledged").length,
      2
    );

    clock = new Date(clock.getTime() + 16_000);
    await runtimeA.poll();
    await runtimeB.poll();
    const received = await runtimeB.getTask(sent.request.taskId);
    assert.equal(received.attachmentsReady, true);
    assert.equal(received.attachmentDiagnostics?.every((item) => item.state === "stored"), true);
    for (const part of attachments) {
      const storedPath = await runtimeB.resolveTaskImage(sent.request.taskId, part.attachmentId);
      assert.deepEqual(await readFile(storedPath), sourceBytes);
    }

    await runtimeA.poll();
    const fullyAcknowledged = await runtimeA.getTask(sent.request.taskId);
    assert.equal(fullyAcknowledged.acknowledgedAttachmentIds?.length, 4);
    assert.equal(fullyAcknowledged.attachmentDiagnostics?.every((item) =>
      item.state === "acknowledged" && item.attempts >= 1
    ), true);
    assert.equal(fullyAcknowledged.attachmentDeliveryAttempts, undefined);
    assert.equal(relay.pendingAttachmentCount(accountB.address), 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

for (const imageCount of [1, 2, 4] as const) {
  test(`${imageCount} deferred Task image attachment${imageCount === 1 ? "" : "s"} stay fresh until persisted`, async () => {
    const root = await mkdtemp(join(tmpdir(), `teti-deferred-${imageCount}-image-`));
    try {
      const source = join(root, "source.png");
      const sourceBytes = onePixelPng();
      await writeFile(source, sourceBytes);
      const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
      const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
      const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
      const relay = new MemoryChatmailRelay({
        deferredAttachments: true,
        hideAttachmentTextUntilDone: true,
        initialAttachmentDownloadState: imageCount === 2 ? "Failure" : "Available"
      });
      const storeA = new FileTaskAttachmentStore(join(root, "a"));
      const storeB = new FileTaskAttachmentStore(join(root, "b"));
      const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
        taskAttachmentStore: storeA
      });
      const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
        taskAttachmentStore: storeB
      });
      const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
      const attachments: TaskImagePart[] = [];
      for (let index = 0; index < imageCount; index += 1) {
        attachments.push((await runtimeA.stageTaskImage(source)).part);
      }
      const sent = await runtimeA.sendTask({
        connectionRequestId: connection.requestId,
        taskId: `task-deferred-${imageCount}-images`,
        capabilityId: "image-editing",
        text: "Use every supplied reference image.",
        attachments
      });

      await runtimeB.poll();
      assert.equal((await runtimeB.getTask(sent.request.taskId)).attachmentsReady, false);
      assert.equal(relay.attachmentDownloadRequestCount(accountB.address), imageCount);

      // More than the old five-attempt isolation threshold must neither
      // request the download again nor acknowledge/drop the attachment.
      for (let attempt = 0; attempt < 6; attempt += 1) await runtimeB.poll();
      assert.equal(relay.attachmentDownloadRequestCount(accountB.address), imageCount);
      assert.equal((await runtimeB.getTask(sent.request.taskId)).attachmentsReady, false);
      assert.equal(relay.pendingAttachmentCount(accountB.address), imageCount);

      relay.completeAttachmentDownloads(accountB.address);
      await runtimeB.poll();
      const received = await runtimeB.getTask(sent.request.taskId);
      assert.equal(received.attachmentsReady, true);
      for (const part of attachments) {
        const storedPath = await runtimeB.resolveTaskImage(sent.request.taskId, part.attachmentId);
        assert.deepEqual(await readFile(storedPath), sourceBytes);
      }
      assert.equal(
        relay.peek(accountB.address).some((message) =>
          applicationType(message) === "teti.task.attachment"
        ),
        false
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
}

test("a deferred generated image Artifact reaches the requester after slow download", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-deferred-image-artifact-"));
  try {
    const source = join(root, "result.png");
    const sourceBytes = onePixelPng();
    await writeFile(source, sourceBytes);
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay({
      deferredAttachments: true,
      hideAttachmentTextUntilDone: true
    });
    const storeA = new FileTaskAttachmentStore(join(root, "a"));
    const storeB = new FileTaskAttachmentStore(join(root, "b"));
    const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
      taskAttachmentStore: storeA
    });
    const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
      taskAttachmentStore: storeB,
      taskExecutor: new FakeImageTaskExecutor(storeB, source)
    });
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      taskId: "task-deferred-generated-image",
      capabilityId: "image-editing",
      text: "Generate and return an image."
    });

    await runtimeB.poll();
    await runtimeB.approveTask(sent.request.taskId);
    await waitUntil(() => relay.pendingAttachmentCount(accountA.address) > 0);
    await runtimeA.poll();
    const waiting = await runtimeA.getTask(sent.request.taskId);
    assert.equal(waiting.state, "completed");
    assert.equal(waiting.artifactAttachmentsReady, false);
    assert.equal(relay.attachmentDownloadRequestCount(accountA.address), 1);

    for (let attempt = 0; attempt < 6; attempt += 1) await runtimeA.poll();
    assert.equal(relay.attachmentDownloadRequestCount(accountA.address), 1);
    relay.completeAttachmentDownloads(accountA.address);
    await runtimeA.poll();

    const completed = await runtimeA.getTask(sent.request.taskId);
    assert.equal(completed.artifactAttachmentsReady, true);
    const artifact = completed.artifacts?.[0];
    const image = artifact?.schemaVersion === 2
      ? artifact.parts.find((part) => part.kind === "image")
      : undefined;
    assert.ok(image && image.kind === "image");
    const resultPath = await runtimeA.resolveTaskImage(sent.request.taskId, image.attachmentId);
    assert.deepEqual(await readFile(resultPath), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test("an in-progress Task attachment survives a Runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-attachment-restart-"));
  try {
    const source = join(root, "source.png");
    const sourceBytes = onePixelPng();
    await writeFile(source, sourceBytes);
    const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
    const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
    const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
    const relay = new MemoryChatmailRelay({
      deferredAttachments: true,
      hideAttachmentTextUntilDone: true
    });
    const connectionStoreA = new MemoryTetiConnectionStorage();
    const connectionStoreB = new MemoryTetiConnectionStorage();
    const taskStoreB = new MemoryTaskTransportStore();
    const attachmentStoreA = new FileTaskAttachmentStore(join(root, "a"));
    const attachmentStoreB = new FileTaskAttachmentStore(join(root, "b"));
    const runtimeA = await makeRuntime(
      accountA,
      relay.adapter(accountA.address),
      registry,
      connectionStoreA,
      { taskAttachmentStore: attachmentStoreA }
    );
    const runtimeB = await makeRuntime(
      accountB,
      relay.adapter(accountB.address),
      registry,
      connectionStoreB,
      { taskTransportStore: taskStoreB, taskAttachmentStore: attachmentStoreB }
    );
    const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
    const staged = await runtimeA.stageTaskImage(source);
    const sent = await runtimeA.sendTask({
      connectionRequestId: connection.requestId,
      taskId: "task-attachment-runtime-restart",
      capabilityId: "image-editing",
      text: "Keep this image pending across restart.",
      attachments: [staged.part]
    });
    await runtimeB.poll();
    assert.equal(relay.attachmentDownloadRequestCount(accountB.address), 1);

    const restartedRuntimeB = await makeRuntime(
      accountB,
      relay.adapter(accountB.address),
      registry,
      connectionStoreB,
      { taskTransportStore: taskStoreB, taskAttachmentStore: attachmentStoreB }
    );
    await restartedRuntimeB.poll();
    assert.equal(relay.attachmentDownloadRequestCount(accountB.address), 1);
    relay.completeAttachmentDownloads(accountB.address);
    await restartedRuntimeB.poll();

    const recovered = await restartedRuntimeB.getTask(sent.request.taskId);
    assert.equal(recovered.attachmentsReady, true);
    const storedPath = await restartedRuntimeB.resolveTaskImage(
      sent.request.taskId,
      staged.part.attachmentId
    );
    assert.deepEqual(await readFile(storedPath), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

test("image editing fails closed when an Adapter returns text without an image", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: new MissingImageTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "image-editing",
    text: "Return an actual image."
  });

  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await waitUntil(() => relay.peek(accountA.address).some((message) => {
    if (applicationType(message) !== "teti.task.status" || !message.text) return false;
    const envelope = parseApplicationEnvelope(message.text);
    return (envelope.payload as { state?: string }).state === "failed";
  }));
  await runtimeA.poll();

  const failed = await runtimeA.getTask(sent.request.taskId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.safeErrorCode, "TASK_IMAGE_RESULT_MISSING");
  assert.equal(failed.artifacts?.length ?? 0, 0);
});

test("rejection and requester cancellation converge on both peers without execution", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");

  const rejectedTask = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "code-analysis",
    text: "Reject this task explicitly."
  });
  await runtimeB.poll();
  const rejectedAtB = await runtimeB.rejectTask(rejectedTask.request.taskId);
  assert.equal(rejectedAtB.state, "rejected");
  assert.equal(rejectedAtB.approval, "rejected");
  await runtimeA.poll();
  const rejectedAtA = await runtimeA.getTask(rejectedTask.request.taskId);
  assert.equal(rejectedAtA.state, "rejected");
  assert.equal(rejectedAtA.approval, "rejected");

  const canceledTask = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "code-analysis",
    text: "Cancel this task before approval."
  });
  await runtimeB.poll();
  const cancellationRequested = await runtimeA.cancelTask(canceledTask.request.taskId);
  assert.equal(cancellationRequested.cancelPending, true);
  assert.equal(cancellationRequested.state, "submitted");
  await runtimeB.poll();
  const canceledAtB = await runtimeB.getTask(canceledTask.request.taskId);
  assert.equal(canceledAtB.state, "canceled");
  await runtimeA.poll();
  const canceledAtA = await runtimeA.getTask(canceledTask.request.taskId);
  assert.equal(canceledAtA.state, "canceled");
  assert.equal(canceledAtA.cancelPending, false);
});

test("a completed status may safely skip a missing working update", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: new FakeTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    capabilityId: "code-analysis",
    text: "Complete even if the working update is lost."
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  assert.equal(relay.dropFirstApplicationMessage(accountA.address, "teti.task.status", "working"), true);

  await runtimeA.poll();
  const completed = await runtimeA.getTask(sent.request.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.approval, "approved_once");
  assert.equal(completed.artifacts?.length, 1);
});

test("Artifact persistence failure leaves Chatmail fresh and succeeds on the next poll", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const storeA = new FailOnceArtifactStore();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    taskTransportStore: storeA
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: new FakeTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-artifact-retry-001",
    capabilityId: "code-analysis",
    text: "Retry the Artifact after a local persistence failure."
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();

  await runtimeA.poll();
  assert.equal((await runtimeA.getTask(sent.request.taskId)).artifacts?.length ?? 0, 0);
  assert.equal(relay.peek(accountA.address).some((message) =>
    applicationType(message) === "teti.task.artifact"
  ), true);

  await runtimeA.poll();
  const retried = await runtimeA.getTask(sent.request.taskId);
  assert.equal(retried.state, "completed");
  assert.equal(retried.artifacts?.length, 1);
  assert.equal(relay.peek(accountA.address).some((message) =>
    applicationType(message) === "teti.task.artifact"
  ), false);
});

test("Artifact arriving before its Task record stays pending and is applied later", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const createdAt = new Date().toISOString();
  const artifactEnvelope = createApplicationEnvelope({
    type: "teti.task.artifact",
    messageId: "artifact-before-task-record",
    fromTetiId: accountB.id,
    createdAt,
    payload: {
      schemaVersion: 1,
      taskId: "task-artifact-before-record-001",
      requesterTetiId: accountA.id,
      targetTetiId: accountB.id,
      artifact: {
        schemaVersion: 2,
        taskId: "task-artifact-before-record-001",
        artifactId: "artifact-early-001",
        parts: [{ kind: "text", text: "early but valid" }],
        createdAt
      },
      createdAt
    }
  });
  relay.pushRaw(accountA.address, accountB.address, serializeApplicationEnvelope(artifactEnvelope));

  await runtimeA.poll();
  assert.equal(relay.peek(accountA.address).some((message) =>
    applicationType(message) === "teti.task.artifact"
  ), true);

  await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-artifact-before-record-001",
    capabilityId: "code-analysis",
    text: "The record now exists."
  });
  await runtimeA.poll();
  const record = await runtimeA.getTask("task-artifact-before-record-001");
  assert.equal(record.artifacts?.length, 1);
  assert.match(JSON.stringify(record.artifacts), /early but valid/);
});

test("out-of-order Task status and receipt messages cannot roll back newer state", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: new FakeTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-reordered-001",
    capabilityId: "code-analysis",
    text: "Keep the highest status revision."
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  relay.reverseApplicationMessages(accountA.address, "teti.task.status");
  await runtimeA.poll();
  assert.equal((await runtimeA.getTask(sent.request.taskId)).state, "completed");

  const receiptTask = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-receipt-reordered-001",
    capabilityId: "code-analysis",
    text: "Keep the newest receipt."
  });
  await runtimeB.poll();
  const conflict = createApplicationEnvelope({
    type: "teti.task.request",
    messageId: "conflicting-retry-message",
    fromTetiId: accountA.id,
    createdAt: new Date().toISOString(),
    payload: {
      ...receiptTask.request,
      input: receiptTask.request.schemaVersion === 1
        ? { kind: "text" as const, text: "Conflicting immutable content." }
        : {
            kind: "parts" as const,
            parts: [{ kind: "text" as const, text: "Conflicting immutable content." }]
          }
    }
  });
  relay.pushRaw(accountB.address, accountA.address, serializeApplicationEnvelope(conflict));
  await runtimeB.poll();
  relay.reverseApplicationMessages(accountA.address, "teti.task.receipt");
  await runtimeA.poll();
  const afterReceipts = await runtimeA.getTask(receiptTask.request.taskId);
  assert.equal(afterReceipts.state, "failed");
  assert.equal(afterReceipts.safeErrorCode, "TASK_ID_CONFLICT");

  const futureReceipt = createApplicationEnvelope({
    type: "teti.task.receipt",
    messageId: "future-receipt-message",
    fromTetiId: accountB.id,
    createdAt: new Date().toISOString(),
    payload: {
      schemaVersion: 1,
      taskId: receiptTask.request.taskId,
      requesterTetiId: accountA.id,
      targetTetiId: accountB.id,
      status: "received",
      receivedAt: "2099-01-01T00:00:00.000Z",
      supportedTaskVersions: [1, 2]
    }
  });
  relay.pushRaw(accountA.address, accountB.address, serializeApplicationEnvelope(futureReceipt));
  await runtimeA.poll();
  const afterFutureReceipt = await runtimeA.getTask(receiptTask.request.taskId);
  assert.equal(afterFutureReceipt.state, "failed");
  assert.equal(afterFutureReceipt.safeErrorCode, "TASK_ID_CONFLICT");
});

test("Runtime restart durably fails interrupted work and reports recovery to the requester", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const storeB = new MemoryTaskTransportStore();
  const connectionsA = new MemoryTetiConnectionStorage();
  const connectionsB = new MemoryTetiConnectionStorage();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, connectionsA);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, connectionsB, {
    taskTransportStore: storeB,
    taskExecutor: new HangingTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-runtime-crash-001",
    capabilityId: "code-analysis",
    text: "This task is interrupted by a Runtime crash."
  });
  await runtimeB.poll();
  assert.equal((await runtimeB.approveTask(sent.request.taskId)).state, "working");

  const restartedB = await makeRuntime(
    accountB,
    relay.adapter(accountB.address),
    registry,
    connectionsB,
    { taskTransportStore: storeB }
  );
  const recovered = await restartedB.getTask(sent.request.taskId);
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.safeErrorCode, "TASK_EXECUTION_INTERRUPTED");
  await restartedB.poll();
  await runtimeA.poll();
  const reported = await runtimeA.getTask(sent.request.taskId);
  assert.equal(reported.state, "failed");
  assert.equal(reported.safeErrorCode, "TASK_EXECUTION_INTERRUPTED");
});

test("expired Agent authentication returns to explicit allow-once after local login", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const executor = new RecoveringAuthTaskExecutor();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: executor
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-auth-recovery-001",
    capabilityId: "code-analysis",
    text: "Retry only after local login."
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  const authRequired = await runtimeB.getTask(sent.request.taskId);
  assert.equal(authRequired.state, "auth_required");
  assert.equal(authRequired.approval, "pending");
  assert.equal(authRequired.safeErrorCode, "ADAPTER_AUTH_REQUIRED");
  await runtimeA.poll();
  assert.equal((await runtimeA.getTask(sent.request.taskId)).state, "auth_required");

  executor.authenticated = true;
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  await runtimeA.poll();
  const completed = await runtimeA.getTask(sent.request.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.artifacts?.length, 1);
  assert.equal(executor.requests.length, 2);
});

test("an auth-required Task still expires instead of remaining actionable forever", async () => {
  let nowMs = Date.parse("2026-07-26T04:00:00.000Z");
  const now = () => new Date(nowMs);
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, { now });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    now,
    taskExecutor: new RecoveringAuthTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  const sent = await runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-auth-expiry-001",
    capabilityId: "code-analysis",
    text: "Do not keep this authorization prompt forever.",
    ttlMs: 1_000
  });
  await runtimeB.poll();
  await runtimeB.approveTask(sent.request.taskId);
  await flushBackgroundWork();
  await flushBackgroundWork();
  assert.equal((await runtimeB.getTask(sent.request.taskId)).state, "auth_required");

  nowMs += 2_000;
  const expired = await runtimeB.getTask(sent.request.taskId);
  assert.equal(expired.state, "rejected");
  assert.equal(expired.approval, "expired");
  assert.equal(expired.safeErrorCode, "TASK_EXPIRED");
});

test("Beta 0.2 refuses Task delivery to a peer advertising only v1", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const storeA = new MemoryTaskTransportStore();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    taskTransportStore: storeA
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry, undefined, {
    taskExecutor: new FakeTaskExecutor()
  });
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  await storeA.save({
    schemaVersion: 2,
    records: [],
    peers: [{
      tetiId: accountB.id,
      supportedVersions: [1],
      observedAt: "2099-01-01T00:00:00.000Z"
    }]
  });
  await assert.rejects(() => runtimeA.sendTask({
    connectionRequestId: connection.requestId,
    taskId: "task-v1-peer-001",
    capabilityId: "code-analysis",
    text: "This must not be downgraded."
  }), /compatible Task version/);
  assert.equal(relay.peek(accountB.address).filter(isTaskRequestMessage).length, 0);
});

test("an oversized malicious envelope is isolated without blocking the next valid peer message", async () => {
  const accountA = makeAccount("teti_alpha0001", "alpha0001@mail.seep.im", 1);
  const accountB = makeAccount("teti_beta00002", "beta00002@mail.seep.im", 2);
  const registry = new StaticRegistry([toIdentity(accountA), toIdentity(accountB)]);
  const relay = new MemoryChatmailRelay();
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry);
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  await confirmPeers(runtimeA, runtimeB, "beta00002");
  relay.pushRaw(accountB.address, accountA.address, JSON.stringify({
    version: 1,
    type: "teti.task.request",
    messageId: "malicious",
    fromTetiId: accountA.id,
    createdAt: new Date().toISOString(),
    payload: { padding: "x".repeat(160 * 1024) }
  }));
  const presence = createApplicationEnvelope({
    type: "teti.presence",
    messageId: "valid-after-malicious",
    fromTetiId: accountA.id,
    payload: {
      status: "alpha-heartbeat",
      timestamp: new Date().toISOString(),
      collaborationProtocolEpoch: 2,
      taskProtocolVersions: [6],
      passportSchemaVersions: [4]
    }
  });
  relay.pushRaw(accountB.address, accountA.address, serializeApplicationEnvelope(presence));

  const result = await runtimeB.poll();
  assert.ok(result.connections[0]?.lastHeartbeatReceivedAt);
  assert.equal((await runtimeB.listTasks()).records.length, 0);
});

async function makeRuntime(
  account: TetiAccount,
  chatmailAdapter: ChatmailAdapter,
  registry: TetiRegistryReader,
  connectionStorage: TetiConnectionStorage = new MemoryTetiConnectionStorage(),
  aiStatus: {
    passportSharing?: MemoryPassportSharingStore;
    getLocalAiTools?: () => AiToolStatusSnapshot[];
    getLocalCallableAgents?: () => CallableAgent[];
    peerProtocolCapabilities?: PeerProtocolCapabilityStore;
    taskTransportStore?: MemoryTaskTransportStore;
    taskAttachmentStore?: FileTaskAttachmentStore;
    workspaceStore?: FileCollaborationWorkspaceStore;
    taskExecutor?: TaskExecutionBridge;
    taskIdFactory?: () => string;
    now?: () => Date;
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

async function confirmPeers(
  runtimeA: PeerConnectionRuntime,
  runtimeB: PeerConnectionRuntime,
  remoteCode: string
) {
  await runtimeA.request(remoteCode);
  const incoming = await runtimeB.poll();
  await runtimeB.accept(incoming.connections[0]!.requestId);
  const confirmed = await runtimeA.poll();
  await runtimeB.poll();
  return confirmed.connections[0]!;
}

function isTaskRequestMessage(message: ChatmailReceivedMessage): boolean {
  if (!message.text) return false;
  try {
    return parseApplicationEnvelope(message.text).type === "teti.task.request";
  } catch {
    return false;
  }
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

function localCodexAgent(): CallableAgent {
  return {
    schemaVersion: 1,
    agentId: "codex",
    adapterId: "codex.local",
    adapterRevision: 1,
    capabilityIds: ["code-analysis"],
    inputModes: ["text"],
    outputModes: ["text"],
    readyAt: "2026-07-18T00:59:00.000Z"
  };
}

function emptyCallablePassport(generatedAt: string): AiStatusSyncPayload {
  return {
    schemaVersion: 4,
    sharing: "enabled",
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 30 * 60 * 1_000).toISOString(),
    tools: [],
    agents: [],
    capabilities: [],
    bindings: [],
    computeOffers: []
  };
}

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+pkJZ5QAAAABJRU5ErkJggg==",
    "base64"
  );
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(read: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for relayed Task state.");
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

class RecoveringRegistry implements TetiRegistryReader {
  online = false;
  profileCalls = 0;
  private readonly identities: DiscoveryIdentity[];

  constructor(identities: DiscoveryIdentity[]) {
    this.identities = identities;
  }

  async discover(): Promise<DiscoveryIdentity[]> {
    return this.identities;
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    this.profileCalls += 1;
    if (!this.online) throw new Error("registry offline");
    return this.identities.find((identity) => identity.id === id) ?? null;
  }
}

class FailOnceArtifactStore extends MemoryTaskTransportStore {
  private shouldFail = true;

  override async save(state: TetiTaskTransportStoreState): Promise<void> {
    if (this.shouldFail && state.records.some((record) => (record.artifacts?.length ?? 0) > 0)) {
      this.shouldFail = false;
      throw new Error("simulated artifact persistence failure");
    }
    await super.save(state);
  }
}

class MemoryChatmailRelay {
  private readonly queues = new Map<string, ChatmailReceivedMessage[]>();
  private readonly events = new Map<string, string[]>();
  private readonly attachmentSources = new Map<number, string>();
  private readonly attachmentCaptions = new Map<number, string>();
  private readonly attachmentDownloadRequests = new Map<number, number>();
  private nextMessageId = 1;
  private lastReceivedAtMs = Date.now();
  private readonly deferredAttachments: boolean;
  private readonly hideAttachmentTextUntilDone: boolean;
  private readonly initialAttachmentDownloadState: "Available" | "Failure";

  constructor(options: {
    deferredAttachments?: boolean;
    hideAttachmentTextUntilDone?: boolean;
    initialAttachmentDownloadState?: "Available" | "Failure";
  } = {}) {
    this.deferredAttachments = options.deferredAttachments ?? false;
    this.hideAttachmentTextUntilDone = options.hideAttachmentTextUntilDone ?? false;
    this.initialAttachmentDownloadState = options.initialAttachmentDownloadState ?? "Available";
  }

  adapter(fromAddress: string): ChatmailAdapter {
    return new RelayAdapter(this, fromAddress);
  }

  send(fromAddress: string, input: SendChatmailMessageInput): ChatmailSentMessage {
    this.recordEvent(fromAddress, "send");
    const messageId = this.nextMessageId++;
    const queue = this.queues.get(input.peerAddress) ?? [];
    if (input.attachment) {
      this.attachmentSources.set(messageId, input.attachment.path);
      this.attachmentCaptions.set(messageId, input.text);
    }
    queue.push({
      messageId,
      chatId: messageId,
      fromAddress,
      text: input.attachment && this.deferredAttachments && this.hideAttachmentTextUntilDone
        ? undefined
        : input.text,
      ...(input.attachment ? {
        ...(this.deferredAttachments ? {} : { filePath: input.attachment.path }),
        fileName: input.attachment.filename,
        downloadState: this.deferredAttachments ? this.initialAttachmentDownloadState : "Done" as const,
        viewType: "Image"
      } : {}),
      receivedAt: this.nextReceivedAt()
    });
    this.queues.set(input.peerAddress, queue);
    return { messageId, chatId: messageId };
  }

  receive(address: string, limit?: number): ChatmailReceivedMessage[] {
    this.recordEvent(address, "receive");
    const queue = this.queues.get(address) ?? [];
    const count = limit ?? queue.length;
    return queue.slice(0, count);
  }

  acknowledge(address: string, messageId: number): void {
    const queue = this.queues.get(address) ?? [];
    const index = queue.findIndex((message) => message.messageId === messageId);
    if (index >= 0) queue.splice(index, 1);
  }

  requestAttachmentDownload(address: string, messageId: number): ChatmailReceivedMessage {
    const message = (this.queues.get(address) ?? []).find((candidate) =>
      candidate.messageId === messageId
    );
    if (!message) throw new Error("Relayed attachment message was not found.");
    if (message.filePath) return structuredClone(message);
    if (!this.attachmentSources.has(messageId)) throw new Error("Relayed attachment source was not found.");
    if (message.downloadState === "InProgress") {
      throw new Error("Download already in progress.");
    }
    if (message.downloadState !== "Available" && message.downloadState !== "Failure") {
      throw new Error(`Attachment cannot be downloaded from ${message.downloadState ?? "unknown"}.`);
    }
    this.attachmentDownloadRequests.set(
      messageId,
      (this.attachmentDownloadRequests.get(messageId) ?? 0) + 1
    );
    message.downloadState = "InProgress";
    return structuredClone(message);
  }

  completeAttachmentDownloads(address: string): void {
    for (const message of this.queues.get(address) ?? []) {
      if (message.downloadState !== "InProgress") continue;
      const sourcePath = this.attachmentSources.get(message.messageId);
      if (!sourcePath) throw new Error("Relayed attachment source was not found.");
      message.filePath = sourcePath;
      message.downloadState = "Done";
      message.text = this.attachmentCaptions.get(message.messageId) ?? message.text;
    }
  }

  attachmentDownloadRequestCount(address: string): number {
    return (this.queues.get(address) ?? []).reduce(
      (total, message) => total + (this.attachmentDownloadRequests.get(message.messageId) ?? 0),
      0
    );
  }

  pendingAttachmentCount(address: string): number {
    return (this.queues.get(address) ?? []).filter((message) =>
      this.attachmentSources.has(message.messageId)
    ).length;
  }

  peek(address: string): ChatmailReceivedMessage[] {
    return structuredClone(this.queues.get(address) ?? []);
  }

  clearEvents(address: string): void {
    this.events.delete(address);
  }

  eventsFor(address: string): string[] {
    return [...(this.events.get(address) ?? [])];
  }

  copyLatest(sourceAddress: string, targetAddress: string): void {
    const latest = this.queues.get(sourceAddress)?.at(-1);
    if (!latest) throw new Error(`No relayed message exists for ${sourceAddress}.`);
    const target = this.queues.get(targetAddress) ?? [];
    target.push({ ...latest });
    this.queues.set(targetAddress, target);
  }

  dropFirstApplicationMessage(
    address: string,
    type: string,
    state?: string
  ): boolean {
    const queue = this.queues.get(address) ?? [];
    const index = queue.findIndex((message) => {
      if (!message.text) return false;
      try {
        const envelope = parseApplicationEnvelope(message.text);
        return envelope.type === type
          && (state === undefined
            || (envelope.payload as { state?: string }).state === state);
      } catch {
        return false;
      }
    });
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  pushRaw(targetAddress: string, fromAddress: string, text: string): void {
    const messageId = this.nextMessageId++;
    const queue = this.queues.get(targetAddress) ?? [];
    queue.push({
      messageId,
      chatId: messageId,
      fromAddress,
      text,
      receivedAt: this.nextReceivedAt()
    });
    this.queues.set(targetAddress, queue);
  }

  reverseApplicationMessages(address: string, type: string): void {
    const queue = this.queues.get(address) ?? [];
    const matching = queue.filter((message) => applicationType(message) === type).reverse();
    let index = 0;
    this.queues.set(address, queue.map((message) =>
      applicationType(message) === type ? matching[index++]! : message
    ));
  }

  takeApplicationMessages(address: string, types: readonly string[]): ChatmailReceivedMessage[] {
    const queue = this.queues.get(address) ?? [];
    const taken = queue.filter((message) => types.includes(applicationType(message) ?? ""));
    this.queues.set(address, queue.filter((message) => !taken.includes(message)));
    return taken;
  }

  restore(address: string, messages: readonly ChatmailReceivedMessage[]): void {
    this.queues.set(address, [...messages, ...(this.queues.get(address) ?? [])]);
  }

  private nextReceivedAt(): string {
    this.lastReceivedAtMs = Math.max(Date.now(), this.lastReceivedAtMs + 1);
    return new Date(this.lastReceivedAtMs).toISOString();
  }

  private recordEvent(address: string, event: string): void {
    const events = this.events.get(address) ?? [];
    events.push(event);
    this.events.set(address, events);
  }
}

class FakeTaskExecutor implements TaskExecutionBridge {
  readonly requests: CallableAdapterTaskRequest[] = [];
  private readonly tasks = new Map<string, CallableAdapterTaskSnapshot>();

  resolveTarget(_offerId: string, capabilityId: string, requiredInputModes: readonly ("text" | "image")[]) {
    if (capabilityId !== "code-analysis" || !requiredInputModes.includes("text")) return null;
    return { connectorId: "fake.adapter", childAgentId: "fake-agent", capabilityId };
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.requests.push(structuredClone(request));
    const working: CallableAdapterTaskSnapshot = {
      schemaVersion: 2,
      taskId: request.taskId,
      adapterId: request.adapterId,
      agentId: request.agentId,
      capabilityId: request.capabilityId,
      state: "working",
      submittedAt: request.createdAt,
      startedAt: request.createdAt,
      updatedAt: request.createdAt
    };
    this.tasks.set(request.taskId, working);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed: CallableAdapterTaskSnapshot = {
      ...working,
      state: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifact: { kind: "text", text: "safe:image-result" }
    };
    this.tasks.set(request.taskId, completed);
    return completed;
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return structuredClone(this.tasks.get(taskId) ?? null);
  }

  cancel(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }
}

class LongHorizonTaskExecutor implements TaskExecutionBridge {
  readonly requests: CallableAdapterTaskRequest[] = [];
  availableSuffixes: Array<"a" | "b"> = ["a", "b"];
  private readonly tasks = new Map<string, CallableAdapterTaskSnapshot>();
  private readonly handles = new Map<string, ExecutionHandle>();

  resolveTarget(_offerId: string, capabilityId: string) {
    return this.listTargets("", capabilityId, ["text"])[0] ?? null;
  }

  listTargets(_offerId: string, capabilityId: string, requiredInputModes: readonly ("text" | "image")[]) {
    if (capabilityId !== "code-analysis" || requiredInputModes.some((mode) => mode !== "text")) return [];
    return this.availableSuffixes.map((suffix) => ({
      connectorId: `fake.connector-${suffix}`,
      childAgentId: `fake-agent-${suffix}`,
      capabilityId,
      workspacePolicy: "none" as const
    }));
  }

  async prepareExecution(input: PrepareExecutionHandleInput): Promise<ExecutionHandle> {
    const handle: ExecutionHandle = {
      schemaVersion: 1,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      childAgentId: input.childAgentId,
      connectorId: input.connectorId,
      executionEpoch: (this.handles.get(input.taskId)?.executionEpoch ?? 0) + 1,
      providerExecutionId: null,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      progress: {
        state: "queued",
        completedUnits: 0,
        totalUnits: 1,
        message: "queued",
        updatedAt: new Date().toISOString()
      },
      checkpointRef: null,
      resumeCapability: "none"
    };
    this.handles.set(input.taskId, handle);
    return structuredClone(handle);
  }

  async getExecutionHandle(taskId: string): Promise<ExecutionHandle | null> {
    return structuredClone(this.handles.get(taskId) ?? null);
  }

  async reconcileExecutionHandles(): Promise<ExecutionHandle[]> {
    return [...this.handles.values()].map((handle) => structuredClone(handle));
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.requests.push(structuredClone(request));
    const completed: CallableAdapterTaskSnapshot = {
      ...workingSnapshot(request),
      state: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifact: { kind: "text", text: `safe:${request.agentId}:${this.requests.length}` }
    };
    this.tasks.set(request.taskId, completed);
    const handle = this.handles.get(request.taskId);
    if (handle) {
      handle.progress = {
        state: "completed",
        completedUnits: 1,
        totalUnits: 1,
        message: "completed",
        updatedAt: completed.updatedAt
      };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    return structuredClone(completed);
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return structuredClone(this.tasks.get(taskId) ?? null);
  }

  cancel(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }
}

class DelegationTaskExecutor extends LongHorizonTaskExecutor {
  readonly authorities: ExecutionAuthority[] = [];
  private readonly delegationTargets = [
    {
      childAgentId: "osaurus-runtime",
      connectorId: "osaurus.runtime.bonsai-chat",
      capabilityId: "general-text-assistance",
      resourceBindingId: "binding:osaurus.runtime.bonsai-chat",
      workspacePolicy: "none" as const,
      inputModes: ["text"] as Array<"text" | "image">,
      outputModes: ["text"] as Array<"text" | "image">,
      timeoutMs: 60_000,
      maxOutputBytes: 24 * 1_024
    },
    {
      childAgentId: "codex",
      connectorId: "codex.image-editing",
      capabilityId: "image-editing",
      resourceBindingId: "binding:codex.image-editing",
      workspacePolicy: "snapshot" as const,
      inputModes: ["text", "image"] as Array<"text" | "image">,
      outputModes: ["text", "image"] as Array<"text" | "image">,
      timeoutMs: 120_000,
      maxOutputBytes: 56 * 1_024
    }
  ];

  listDelegationTargets() {
    return structuredClone(this.delegationTargets);
  }

  resolveDelegationTarget(selection: {
    childAgentId: string;
    connectorId: string;
    capabilityId: string;
  }) {
    return structuredClone(this.delegationTargets.find((target) =>
      target.childAgentId === selection.childAgentId
      && target.connectorId === selection.connectorId
      && target.capabilityId === selection.capabilityId
    ) ?? null);
  }

  override execute(
    request: CallableAdapterTaskRequest,
    authority: ExecutionAuthority
  ): Promise<CallableAdapterTaskSnapshot> {
    this.authorities.push(structuredClone(authority));
    return super.execute(request);
  }
}

class FailingDelegationTaskExecutor extends DelegationTaskExecutor {
  override async execute(
    request: CallableAdapterTaskRequest,
    authority: ExecutionAuthority
  ): Promise<CallableAdapterTaskSnapshot> {
    this.requests.push(structuredClone(request));
    this.authorities.push(structuredClone(authority));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      ...workingSnapshot(request),
      state: "failed",
      safeErrorCode: "ADAPTER_INTERNAL_ERROR",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }
}

class ChangingDelegationTaskExecutor extends DelegationTaskExecutor {
  override resolveDelegationTarget(selection: {
    childAgentId: string;
    connectorId: string;
    capabilityId: string;
  }) {
    if (this.requests.length > 0 && selection.childAgentId === "codex") return null;
    return super.resolveDelegationTarget(selection);
  }
}

class DeferredLongHorizonTaskExecutor extends LongHorizonTaskExecutor {
  private active: CallableAdapterTaskSnapshot | null = null;
  private resolveExecution?: (snapshot: CallableAdapterTaskSnapshot) => void;

  override execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.requests.push(structuredClone(request));
    this.active = workingSnapshot(request);
    return new Promise<CallableAdapterTaskSnapshot>((resolve) => {
      this.resolveExecution = resolve;
    });
  }

  override getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return this.active?.taskId === taskId ? structuredClone(this.active) : null;
  }

  finish(text: string): void {
    if (!this.active || !this.resolveExecution) throw new Error("No deferred long-horizon stage is active.");
    const completed: CallableAdapterTaskSnapshot = {
      ...this.active,
      state: "completed",
      artifact: { kind: "text", text },
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    this.active = completed;
    const resolve = this.resolveExecution;
    this.resolveExecution = undefined;
    resolve(structuredClone(completed));
  }
}

class FakeLocalComputeTaskExecutor implements TaskExecutionBridge {
  resolvedOfferId = "";
  private task: CallableAdapterTaskSnapshot | null = null;

  resolveTarget(offerId: string, capabilityId: string, requiredInputModes: readonly ("text" | "image")[]) {
    this.resolvedOfferId = offerId;
    return offerId === "local.compute.general-text-assistance.v1"
      && capabilityId === "general-text-assistance"
      && requiredInputModes.length === 1
      && requiredInputModes[0] === "text"
      ? { connectorId: "osaurus.runtime.bonsai-chat", childAgentId: "osaurus-runtime", capabilityId }
      : null;
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.task = {
      ...workingSnapshot(request),
      state: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifact: { kind: "text", text: "receiver-local answer" }
    };
    return structuredClone(this.task);
  }

  getTask(): CallableAdapterTaskSnapshot | null { return structuredClone(this.task); }
  cancel(): boolean { return false; }
}

class FakeImageTaskExecutor implements TaskExecutionBridge {
  private readonly store: FileTaskAttachmentStore;
  private readonly resultSource: string;

  constructor(store: FileTaskAttachmentStore, resultSource: string) {
    this.store = store;
    this.resultSource = resultSource;
  }

  resolveTarget(_offerId: string, capabilityId: string) {
    return capabilityId === "image-editing"
      ? { connectorId: "fake.image", childAgentId: "fake-image", capabilityId }
      : null;
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    const generated = await this.store.ingestGeneratedImage(request.taskId, this.resultSource);
    return {
      ...workingSnapshot(request),
      state: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifact: {
        kind: "parts",
        text: "safe:image-generated",
        images: [generated.part]
      }
    };
  }

  getTask(): CallableAdapterTaskSnapshot | null { return null; }
  cancel(): boolean { return false; }
}

class MissingImageTaskExecutor implements TaskExecutionBridge {
  resolveTarget(_offerId: string, capabilityId: string) {
    return capabilityId === "image-editing"
      ? { connectorId: "fake.missing-image", childAgentId: "fake-image", capabilityId }
      : null;
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    return {
      ...workingSnapshot(request),
      state: "completed",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      artifact: { kind: "text", text: "I edited it." }
    };
  }

  getTask(): CallableAdapterTaskSnapshot | null { return null; }
  cancel(): boolean { return false; }
}

class HangingTaskExecutor implements TaskExecutionBridge {
  private readonly tasks = new Map<string, CallableAdapterTaskSnapshot>();

  resolveTarget(_offerId: string, capabilityId: string) {
    return { connectorId: "fake.adapter", childAgentId: "fake-agent", capabilityId };
  }

  execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.tasks.set(request.taskId, workingSnapshot(request));
    return new Promise<CallableAdapterTaskSnapshot>(() => undefined);
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return structuredClone(this.tasks.get(taskId) ?? null);
  }

  cancel(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }
}

class RecoveringAuthTaskExecutor implements TaskExecutionBridge {
  readonly requests: CallableAdapterTaskRequest[] = [];
  readonly tasks = new Map<string, CallableAdapterTaskSnapshot>();
  authenticated = false;

  resolveTarget(_offerId: string, capabilityId: string) {
    return { connectorId: "fake.adapter", childAgentId: "fake-agent", capabilityId };
  }

  async execute(request: CallableAdapterTaskRequest): Promise<CallableAdapterTaskSnapshot> {
    this.requests.push(structuredClone(request));
    const working = workingSnapshot(request);
    const result: CallableAdapterTaskSnapshot = this.authenticated
      ? {
          ...working,
          state: "completed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          artifact: { kind: "text", text: "safe:authenticated-result" }
        }
      : {
          ...working,
          state: "failed",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          safeErrorCode: "ADAPTER_AUTH_REQUIRED"
        };
    this.tasks.set(request.taskId, result);
    return result;
  }

  getTask(taskId: string): CallableAdapterTaskSnapshot | null {
    return structuredClone(this.tasks.get(taskId) ?? null);
  }

  cancel(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }
}

function workingSnapshot(request: CallableAdapterTaskRequest): CallableAdapterTaskSnapshot {
  return {
    schemaVersion: 2,
    taskId: request.taskId,
    adapterId: request.adapterId,
    agentId: request.agentId,
    capabilityId: request.capabilityId,
    state: "working",
    submittedAt: request.createdAt,
    startedAt: request.createdAt,
    updatedAt: request.createdAt
  };
}

function applicationType(message: ChatmailReceivedMessage): string | undefined {
  if (!message.text) return undefined;
  try {
    return parseApplicationEnvelope(message.text).type;
  } catch {
    return undefined;
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
  async acknowledgeReceivedMessage(_accountId: number, messageId: number): Promise<void> {
    this.relay.acknowledge(this.address, messageId);
  }
  async downloadMessageAttachment(
    _accountId: number,
    messageId: number
  ): Promise<ChatmailReceivedMessage> {
    return this.relay.requestAttachmentDownload(this.address, messageId);
  }
  async createAccount(_input: CreateChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async loadAccount(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async getIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> { throw new Error("unused"); }
  async getPublicIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity> { throw new Error("unused"); }
  async deleteAccount(_input: DeleteChatmailAccountInput): Promise<void> { throw new Error("unused"); }
}
