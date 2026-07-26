import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { AiToolStatusSnapshot } from "../../../core/ai-status/types.ts";
import type { CallableAgent } from "../../../core/callability/types.ts";
import { parseApplicationEnvelope } from "../../../core/protocol/envelope.ts";
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
import { MemoryTaskTransportStore } from "../lifecycle-sidecar/runtime/tasks/store.ts";
import { FileTaskAttachmentStore } from "../lifecycle-sidecar/runtime/tasks/attachments.ts";
import type { TaskExecutionBridge } from "../lifecycle-sidecar/runtime/tasks/service.ts";
import type {
  CallableAdapterTaskRequest,
  CallableAdapterTaskSnapshot
} from "../../../core/callability/adapter.ts";

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
  assert.deepEqual(await runtimeA.getPassportSharing(), resourceSharingPolicy(false));

  await runtimeA.setPassportSharing(resourceSharingPolicy(true));
  await flushBackgroundWork();
  const schemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(schemas, [1, 3], "unknown peers receive minimum legacy plus current schemas");
  const shared = await runtimeB.poll();
  assert.equal(shared.connections[0]?.remoteAiStatus?.sharing, "enabled");
  assert.equal(shared.connections[0]?.remoteAiStatus?.schemaVersion, 3);
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.toolId, "openai.codex");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.plan.key, "plus");
  assert.equal(shared.connections[0]?.remoteAiStatus?.tools[0]?.quotas[0]?.remainingPercent, 42);
  assert.equal(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 3
      ? shared.connections[0].remoteAiStatus.agents[0]?.id
      : undefined,
    "codex"
  );
  assert.equal(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 3
      ? shared.connections[0].remoteAiStatus.capabilities[0]?.id
      : undefined,
    "code-analysis"
  );
  assert.deepEqual(
    shared.connections[0]?.remoteAiStatus?.schemaVersion === 3
      ? shared.connections[0].remoteAiStatus.bindings[0]?.agentIds
      : undefined,
    ["codex"]
  );
  assert.doesNotMatch(
    JSON.stringify(shared.connections[0]?.remoteAiStatus),
    /"(?:token|accountId|raw|displayName|version|runtimeStatus|processCount|command|path|entrypoint|adapterId)"/i
  );

  // B has now observed A's schema 3. Its first enabled sync therefore sends
  // only schema 3, and teaches A that B is also current.
  await runtimeB.setPassportSharing(resourceSharingPolicy(true));
  await flushBackgroundWork();
  const responseSchemas = relay.peek(accountA.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(responseSchemas, [3], "known current peers do not receive redundant legacy payloads");
  await runtimeA.poll();

  await runtimeA.setPassportSharing(resourceSharingPolicy(false));
  await flushBackgroundWork();
  const revokeSchemas = relay.peek(accountB.address)
    .map((message) => message.text ? parseApplicationEnvelope(message.text) : null)
    .filter((envelope) => envelope?.type === "teti.ai.status.sync")
    .map((envelope) => (envelope!.payload as { schemaVersion: number }).schemaVersion);
  assert.deepEqual(revokeSchemas, [3]);
  const revoked = await runtimeB.poll();
  assert.equal(revoked.connections[0]?.remoteAiStatus?.sharing, "disabled");
  assert.deepEqual(revoked.connections[0]?.remoteAiStatus?.tools, []);
  assert.deepEqual(
    revoked.connections[0]?.remoteAiStatus?.schemaVersion === 3
      ? revoked.connections[0].remoteAiStatus.agents
      : undefined,
    []
  );
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
  assert.deepEqual(acknowledged.peers[0]?.supportedVersions, [1, 2]);
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
    schemaVersion: 1,
    records: [],
    peers: [{
      tetiId: accountB.id,
      supportedVersions: [3],
      observedAt: "2026-07-26T00:00:00.000Z"
    }]
  });
  const runtimeA = await makeRuntime(accountA, relay.adapter(accountA.address), registry, undefined, {
    taskTransportStore: taskStore
  });
  const runtimeB = await makeRuntime(accountB, relay.adapter(accountB.address), registry);
  const connection = await confirmPeers(runtimeA, runtimeB, "beta00002");
  await taskStore.save({
    schemaVersion: 1,
    records: [],
    peers: [{
      tetiId: accountB.id,
      supportedVersions: [3],
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
    assert.equal(sent.protocolVersion, 2);

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
    await rm(root, { recursive: true, force: true });
  }
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

async function makeRuntime(
  account: TetiAccount,
  chatmailAdapter: ChatmailAdapter,
  registry: TetiRegistryReader,
  connectionStorage: TetiConnectionStorage = new MemoryTetiConnectionStorage(),
  aiStatus: {
    passportSharing?: MemoryPassportSharingStore;
    getLocalAiTools?: () => AiToolStatusSnapshot[];
    getLocalCallableAgents?: () => CallableAgent[];
    taskTransportStore?: MemoryTaskTransportStore;
    taskAttachmentStore?: FileTaskAttachmentStore;
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
      ...(input.attachment ? {
        filePath: input.attachment.path,
        fileName: input.attachment.filename,
        downloadState: "Done" as const,
        viewType: "Image"
      } : {}),
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

  peek(address: string): ChatmailReceivedMessage[] {
    return structuredClone(this.queues.get(address) ?? []);
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
}

class FakeTaskExecutor implements TaskExecutionBridge {
  readonly requests: CallableAdapterTaskRequest[] = [];
  private readonly tasks = new Map<string, CallableAdapterTaskSnapshot>();

  resolveTarget(capabilityId: string, requiredInputModes: readonly ("text" | "image")[]) {
    if (capabilityId !== "code-analysis" || !requiredInputModes.includes("text")) return null;
    return { adapterId: "fake.adapter", agentId: "fake-agent", capabilityId };
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
