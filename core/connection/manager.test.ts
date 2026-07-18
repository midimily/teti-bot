import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTetiAccountStorage } from "../account/storage.ts";
import type { TetiAccount } from "../account/model.ts";
import { createConnectionRequestEnvelope, parseConnectionRequestEnvelope, serializeConnectionEnvelope } from "./protocol.ts";
import { TetiConnectionManager } from "./manager.ts";
import { MemoryTetiConnectionStorage } from "./storage.ts";
import { TetiConnectionState, type TetiConnectionRequest } from "./types.ts";
import type {
  ConnectionMessagingAdapter,
  ReceiveConnectionRequestsInput,
  ReceivedConnectionEvent,
  ReceivedConnectionRequest,
  SendConnectionAcceptInput,
  SendConnectionRequestInput,
  SendConnectionRejectInput,
  SentConnectionEvent,
  SentConnectionRequest
} from "../../integrations/chatmail/connection-messaging.ts";

const fixedNow = "2026-07-11T00:00:00.000Z";

test("creates and sends a connection request through chatmail messaging", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const messagingAdapter = new RecordingConnectionMessagingAdapter();
  const manager = new TetiConnectionManager({
    accountStorage,
    connectionStorage,
    messagingAdapter,
    requestIdFactory: () => "request-1",
    nonceFactory: () => "nonce-1",
    now: () => fixedNow
  });

  const record = await manager.createRequest({
    id: "teti_remote001",
    address: "remote001@mail.seep.im",
    publicKey: "remote-public-key",
    publicProfile: {
      platform: "Windows"
    }
  });

  assert.equal(record.requestId, "request-1");
  assert.equal(record.state, TetiConnectionState.Requested);
  assert.equal(record.direction, "outgoing");
  assert.equal(record.remoteTetiId, "teti_remote001");
  assert.equal(record.remoteAddress, "remote001@mail.seep.im");
  assert.equal(record.request.fromTetiId, "teti_local0001");
  assert.equal(record.request.publicKey, "local-public-key");
  assert.equal(record.request.nonce, "nonce-1");
  assert.deepEqual(await connectionStorage.loadAll(), [record]);
  assert.equal(messagingAdapter.sendCalls.length, 1);
  assert.equal(messagingAdapter.sendCalls[0].accountId, 9);
  assert.equal(messagingAdapter.sendCalls[0].toAddress, "remote001@mail.seep.im");
});

test("accepts an incoming request, sends accept, and persists confirmed state", async () => {
  const { manager, connectionStorage, messagingAdapter } = await createManagerWithIncomingRequest();

  const accepted = await manager.acceptRequest("request-1");

  assert.equal(accepted.state, TetiConnectionState.Confirmed);
  assert.equal(accepted.acceptedAt, fixedNow);
  assert.equal(accepted.confirmedAt, fixedNow);
  assert.equal(messagingAdapter.acceptCalls.length, 1);
  assert.deepEqual(await connectionStorage.loadAll(), [accepted]);
});

test("rejects a pending request", async () => {
  const { manager, connectionStorage, messagingAdapter } = await createManagerWithIncomingRequest();

  const rejected = await manager.rejectRequest("request-1");

  assert.equal(rejected.state, TetiConnectionState.Rejected);
  assert.equal(rejected.confirmedAt, undefined);
  assert.equal(rejected.rejectedAt, fixedNow);
  assert.equal(messagingAdapter.rejectCalls.length, 1);
  assert.deepEqual(await connectionStorage.loadAll(), [rejected]);
});

test("receives connection requests and stores incoming pending records", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const messagingAdapter = new RecordingConnectionMessagingAdapter();
  const incomingRequest: TetiConnectionRequest = {
    version: 1,
    requestId: "incoming-1",
    fromTetiId: "teti_remote001",
    fromAddress: "remote001@mail.seep.im",
    publicKey: "remote-public-key",
    profile: {
      platform: "Linux",
      category: ["developer"],
      aiEnvironment: ["Codex"]
    },
    createdAt: "2026-07-10T00:00:00.000Z",
    nonce: "remote-nonce"
  };
  messagingAdapter.received.push({
    messageId: 100,
    chatId: 200,
    fromAddress: "remote001@mail.seep.im",
    receivedAt: fixedNow,
    request: incomingRequest,
    envelope: createConnectionRequestEnvelope(incomingRequest)
  });
  const manager = new TetiConnectionManager({
    accountStorage,
    connectionStorage,
    messagingAdapter,
    now: () => fixedNow
  });

  const records = await manager.receiveRequests();

  assert.equal(records.length, 1);
  assert.equal(records[0].state, TetiConnectionState.PendingApproval);
  assert.equal(records[0].direction, "incoming");
  assert.equal(records[0].remoteTetiId, "teti_remote001");
  assert.deepEqual(await manager.listConnections(), records);
});

test("passes receive polling and diagnostic options to messaging adapter", async () => {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const messagingAdapter = new RecordingConnectionMessagingAdapter();
  const manager = new TetiConnectionManager({
    accountStorage,
    connectionStorage,
    messagingAdapter,
    now: () => fixedNow
  });
  const diagnostics: unknown[] = [];

  await manager.receiveEvents({
    limit: 7,
    pollCount: 3,
    pollIntervalMs: 25,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  assert.equal(messagingAdapter.lastReceiveEventsInput?.accountId, 9);
  assert.equal(messagingAdapter.lastReceiveEventsInput?.limit, 7);
  assert.equal(messagingAdapter.lastReceiveEventsInput?.pollCount, 3);
  assert.equal(messagingAdapter.lastReceiveEventsInput?.pollIntervalMs, 25);
  messagingAdapter.lastReceiveEventsInput?.onDiagnostic?.({
    source: "connection",
    type: "ignoredMessage",
    accountId: 9,
    messageId: 1,
    reason: "test"
  });
  assert.equal(diagnostics.length, 1);
});

test("rejects invalid connection request payloads with private material", () => {
  const invalidEnvelope = {
    type: "teti.connection.request",
    version: 1,
    payload: {
      version: 1,
      requestId: "bad-request",
      fromTetiId: "teti_bad000001",
      fromAddress: "bad@mail.seep.im",
      profile: {
        platform: "macOS"
      },
      createdAt: fixedNow,
      nonce: "bad-nonce",
      privateKey: "must-not-cross-boundary"
    }
  };

  assert.throws(
    () => parseConnectionRequestEnvelope(JSON.stringify(invalidEnvelope)),
    /must not contain privateKey/
  );
});

test("serializes the connection request protocol envelope", async () => {
  const { manager } = await createManagerWithPendingRequest();
  const [record] = await manager.listConnections();
  const serialized = serializeConnectionEnvelope(createConnectionRequestEnvelope(record.request));

  assert.deepEqual(JSON.parse(serialized), {
    type: "teti.connection.request",
    version: 1,
    payload: record.request
  });
});

async function createManagerWithPendingRequest() {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const messagingAdapter = new RecordingConnectionMessagingAdapter();
  const manager = new TetiConnectionManager({
    accountStorage,
    connectionStorage,
    messagingAdapter,
    requestIdFactory: () => "request-1",
    nonceFactory: () => "nonce-1",
    now: () => fixedNow
  });

  await manager.createRequest({
    id: "teti_remote001",
    address: "remote001@mail.seep.im",
    publicProfile: {}
  });

  return { manager, connectionStorage, messagingAdapter };
}

async function createManagerWithIncomingRequest() {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  const messagingAdapter = new RecordingConnectionMessagingAdapter();
  const manager = new TetiConnectionManager({
    accountStorage,
    connectionStorage,
    messagingAdapter,
    requestIdFactory: () => "request-1",
    nonceFactory: () => "nonce-1",
    now: () => fixedNow
  });

  await connectionStorage.upsert({
    version: 1,
    requestId: "request-1",
    state: TetiConnectionState.PendingApproval,
    direction: "incoming",
    remoteTetiId: "teti_remote001",
    remoteAddress: "remote001@mail.seep.im",
    request: {
      version: 1,
      requestId: "request-1",
      fromTetiId: "teti_remote001",
      fromAddress: "remote001@mail.seep.im",
      publicKey: "remote-public-key",
      profile: {
        platform: "Linux",
        category: ["developer"],
        aiEnvironment: ["Codex"]
      },
      createdAt: fixedNow,
      nonce: "remote-nonce"
    },
    createdAt: fixedNow,
    updatedAt: fixedNow
  });

  return { manager, connectionStorage, messagingAdapter };
}

function createLocalAccount(): TetiAccount {
  return {
    version: 1,
    id: "teti_local0001",
    address: "local0001@mail.seep.im",
    chatmailAccountId: 9,
    publicKey: "local-public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code"]
    },
    createdAt: fixedNow
  };
}

class RecordingConnectionMessagingAdapter implements ConnectionMessagingAdapter {
  readonly sendCalls: SendConnectionRequestInput[] = [];
  readonly acceptCalls: SendConnectionAcceptInput[] = [];
  readonly rejectCalls: SendConnectionRejectInput[] = [];
  readonly received: ReceivedConnectionRequest[] = [];
  readonly events: ReceivedConnectionEvent[] = [];
  lastReceiveEventsInput?: ReceiveConnectionRequestsInput;

  async sendConnectionRequest(input: SendConnectionRequestInput): Promise<SentConnectionRequest> {
    this.sendCalls.push(input);
    return {
      messageId: this.sendCalls.length,
      chatId: input.accountId
    };
  }

  async receiveConnectionRequests(
    _input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionRequest[]> {
    return this.received;
  }

  async sendConnectionAccept(input: SendConnectionAcceptInput): Promise<SentConnectionEvent> {
    this.acceptCalls.push(input);
    return {
      messageId: this.acceptCalls.length,
      chatId: input.accountId
    };
  }

  async sendConnectionReject(input: SendConnectionRejectInput): Promise<SentConnectionEvent> {
    this.rejectCalls.push(input);
    return {
      messageId: this.rejectCalls.length,
      chatId: input.accountId
    };
  }

  async receiveConnectionEvents(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionEvent[]> {
    this.lastReceiveEventsInput = input;
    return this.events;
  }
}
