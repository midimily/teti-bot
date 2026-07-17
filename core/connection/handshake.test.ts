import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../account/model.ts";
import { MemoryTetiAccountStorage } from "../account/storage.ts";
import {
  createConnectionAcceptEnvelope,
  createConnectionRequestEnvelope,
  createConnectionRejectEnvelope
} from "./protocol.ts";
import { TetiConnectionManager } from "./manager.ts";
import { reconcileConfirmedPeerConnections } from "./handshake.ts";
import { MemoryTetiConnectionStorage } from "./storage.ts";
import { TetiConnectionState } from "./types.ts";
import type {
  ConnectionMessagingAdapter,
  ReceiveConnectionRequestsInput,
  ReceivedConnectionEvent,
  ReceivedConnectionRequest,
  SendConnectionAcceptInput,
  SendConnectionRejectInput,
  SendConnectionRequestInput,
  SentConnectionEvent,
  SentConnectionRequest
} from "../../integrations/chatmail/connection-messaging.ts";

const fixedNow = "2026-07-11T00:00:00.000Z";

test("A sends request, B accepts, A receives accept, and both become confirmed", async () => {
  const pair = await createHandshakePair();

  const requested = await pair.a.manager.createRequest(pair.b.identity);
  assert.equal(requested.state, TetiConnectionState.Requested);

  const [pendingApproval] = await pair.b.manager.receiveEvents();
  assert.equal(pendingApproval.state, TetiConnectionState.PendingApproval);

  const bConfirmed = await pair.b.manager.acceptRequest(requested.requestId);
  assert.equal(bConfirmed.state, TetiConnectionState.Confirmed);
  assert.equal(bConfirmed.confirmedAt, fixedNow);

  const [aConfirmed] = await pair.a.manager.receiveEvents();
  assert.equal(aConfirmed.state, TetiConnectionState.Confirmed);
  assert.equal(aConfirmed.confirmedAt, fixedNow);

  assert.equal((await pair.a.manager.listConnections())[0].state, TetiConnectionState.Confirmed);
  assert.equal((await pair.b.manager.listConnections())[0].state, TetiConnectionState.Confirmed);
});

test("reject flow marks both sides rejected", async () => {
  const pair = await createHandshakePair();

  const requested = await pair.a.manager.createRequest(pair.b.identity);
  await pair.b.manager.receiveEvents();

  const bRejected = await pair.b.manager.rejectRequest(requested.requestId);
  assert.equal(bRejected.state, TetiConnectionState.Rejected);

  const [aRejected] = await pair.a.manager.receiveEvents();
  assert.equal(aRejected.state, TetiConnectionState.Rejected);

  assert.equal((await pair.a.manager.listConnections())[0].state, TetiConnectionState.Rejected);
  assert.equal((await pair.b.manager.listConnections())[0].state, TetiConnectionState.Rejected);
});

test("duplicate incoming requests do not create duplicate connection records", async () => {
  const pair = await createHandshakePair();

  await pair.a.manager.createRequest(pair.b.identity);
  pair.b.messaging.duplicateInbox();
  await pair.b.manager.receiveEvents();

  assert.equal((await pair.b.manager.listConnections()).length, 1);
});

test("crossed requests collapse to one confirmed relationship after either request is accepted", async () => {
  const pair = await createHandshakePair();

  const requestA = await pair.a.manager.createRequest(pair.b.identity);
  await pair.b.manager.createRequest(pair.a.identity);
  await pair.a.manager.receiveEvents();
  const [incomingAtB] = await pair.b.manager.receiveEvents();

  assert.equal((await pair.a.manager.listConnections()).length, 2);
  assert.equal((await pair.b.manager.listConnections()).length, 2);
  assert.equal(incomingAtB.state, TetiConnectionState.PendingApproval);

  await pair.b.manager.acceptRequest(requestA.requestId);
  await pair.a.manager.receiveEvents();

  const connectionsA = await pair.a.manager.listConnections();
  const connectionsB = await pair.b.manager.listConnections();
  assert.equal(connectionsA.length, 1);
  assert.equal(connectionsB.length, 1);
  assert.equal(connectionsA[0].requestId, requestA.requestId);
  assert.equal(connectionsB[0].requestId, requestA.requestId);
  assert.equal(connectionsA[0].state, TetiConnectionState.Confirmed);
  assert.equal(connectionsB[0].state, TetiConnectionState.Confirmed);
});

test("a crossed request arriving after confirmation does not recreate pending approval", async () => {
  const pair = await createHandshakePair();

  const requestA = await pair.a.manager.createRequest(pair.b.identity);
  await pair.b.manager.receiveEvents();
  await pair.b.manager.acceptRequest(requestA.requestId);
  await pair.a.manager.receiveEvents();

  await pair.b.messaging.sendConnectionRequest({
    accountId: 2,
    toAddress: pair.a.identity.address,
    request: {
      version: 1,
      requestId: "late-request-b",
      fromTetiId: pair.b.identity.id,
      fromAddress: pair.b.identity.address,
      publicKey: pair.b.identity.publicKey,
      profile: pair.b.identity.publicProfile,
      createdAt: fixedNow,
      nonce: "late-nonce-b"
    }
  });
  await pair.a.manager.receiveEvents();

  const connectionsA = await pair.a.manager.listConnections();
  assert.equal(connectionsA.length, 1);
  assert.equal(connectionsA[0].requestId, requestA.requestId);
  assert.equal(connectionsA[0].state, TetiConnectionState.Confirmed);
});

test("legacy confirmed and waiting records for one peer reconcile to one relationship", async () => {
  const pair = await createHandshakePair();
  const confirmed = await pair.a.manager.createRequest(pair.b.identity);
  await pair.b.manager.receiveEvents();
  await pair.b.manager.acceptRequest(confirmed.requestId);
  await pair.a.manager.receiveEvents();

  const [canonical] = await pair.a.manager.listConnections();
  await pair.a.connectionStorage.upsert({
    ...canonical,
    requestId: "legacy-waiting-request",
    state: TetiConnectionState.Requested,
    direction: "outgoing",
    request: {
      ...canonical.request,
      requestId: "legacy-waiting-request"
    },
    confirmedAt: undefined
  });

  const reconciled = await reconcileConfirmedPeerConnections(pair.a.connectionStorage);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].requestId, canonical.requestId);
  assert.equal((await pair.a.connectionStorage.loadAll()).length, 1);
});

test("invalid requestId cannot be accepted or confirmed", async () => {
  const pair = await createHandshakePair();

  await assert.rejects(
    () => pair.b.manager.acceptRequest("missing-request"),
    /does not exist/
  );
  await assert.rejects(
    () =>
      pair.a.manager.handleAccept({
        version: 1,
        requestId: "missing-request",
        fromTetiId: "teti_b",
        fromAddress: "b@mail.seep.im",
        createdAt: fixedNow,
        nonce: "accept-nonce"
      }),
    /does not exist/
  );
});

async function createHandshakePair() {
  const aStorage = new MemoryTetiAccountStorage();
  const bStorage = new MemoryTetiAccountStorage();
  const aAccount = createAccount("teti_a", "a@mail.seep.im", 1);
  const bAccount = createAccount("teti_b", "b@mail.seep.im", 2);
  await aStorage.save(aAccount);
  await bStorage.save(bAccount);

  const aConnectionStorage = new MemoryTetiConnectionStorage();
  const bConnectionStorage = new MemoryTetiConnectionStorage();
  const aMessaging = new PairedConnectionMessagingAdapter();
  const bMessaging = new PairedConnectionMessagingAdapter();
  aMessaging.peer = bMessaging;
  bMessaging.peer = aMessaging;

  return {
    a: {
      identity: {
        id: aAccount.id,
        address: aAccount.address,
        publicKey: aAccount.publicKey,
        publicProfile: aAccount.publicProfile
      },
      messaging: aMessaging,
      connectionStorage: aConnectionStorage,
      manager: new TetiConnectionManager({
        accountStorage: aStorage,
        connectionStorage: aConnectionStorage,
        messagingAdapter: aMessaging,
        requestIdFactory: () => "request-a",
        nonceFactory: () => "nonce-a",
        now: () => fixedNow
      })
    },
    b: {
      identity: {
        id: bAccount.id,
        address: bAccount.address,
        publicKey: bAccount.publicKey,
        publicProfile: bAccount.publicProfile
      },
      messaging: bMessaging,
      connectionStorage: bConnectionStorage,
      manager: new TetiConnectionManager({
        accountStorage: bStorage,
        connectionStorage: bConnectionStorage,
        messagingAdapter: bMessaging,
        requestIdFactory: () => "request-b",
        nonceFactory: () => "nonce-b",
        now: () => fixedNow
      })
    }
  };
}

function createAccount(id: string, address: string, chatmailAccountId: number): TetiAccount {
  return {
    version: 1,
    id,
    address,
    chatmailAccountId,
    publicKey: `${id}-public-key`,
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code"]
    },
    createdAt: fixedNow
  };
}

class PairedConnectionMessagingAdapter implements ConnectionMessagingAdapter {
  peer?: PairedConnectionMessagingAdapter;
  private readonly inbox: ReceivedConnectionEvent[] = [];
  private nextMessageId = 1;

  async sendConnectionRequest(input: SendConnectionRequestInput): Promise<SentConnectionRequest> {
    const envelope = createConnectionRequestEnvelope(input.request);
    this.requirePeer().inbox.push({
      type: "teti.connection.request",
      messageId: this.nextMessageId++,
      chatId: input.accountId,
      fromAddress: input.request.fromAddress,
      receivedAt: fixedNow,
      request: input.request,
      envelope
    });

    return {
      messageId: this.nextMessageId,
      chatId: input.accountId
    };
  }

  async sendConnectionAccept(input: SendConnectionAcceptInput): Promise<SentConnectionEvent> {
    const envelope = createConnectionAcceptEnvelope(input.accept);
    this.requirePeer().inbox.push({
      type: "teti.connection.accept",
      messageId: this.nextMessageId++,
      chatId: input.accountId,
      fromAddress: input.accept.fromAddress,
      receivedAt: fixedNow,
      accept: input.accept,
      envelope
    });

    return {
      messageId: this.nextMessageId,
      chatId: input.accountId
    };
  }

  async sendConnectionReject(input: SendConnectionRejectInput): Promise<SentConnectionEvent> {
    const envelope = createConnectionRejectEnvelope(input.reject);
    this.requirePeer().inbox.push({
      type: "teti.connection.reject",
      messageId: this.nextMessageId++,
      chatId: input.accountId,
      receivedAt: fixedNow,
      reject: input.reject,
      envelope
    });

    return {
      messageId: this.nextMessageId,
      chatId: input.accountId
    };
  }

  async receiveConnectionEvents(
    _input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionEvent[]> {
    const events = [...this.inbox];
    this.inbox.length = 0;
    return events;
  }

  async receiveConnectionRequests(
    input: ReceiveConnectionRequestsInput
  ): Promise<ReceivedConnectionRequest[]> {
    return (await this.receiveConnectionEvents(input))
      .filter((event): event is ReceivedConnectionRequest & { type: "teti.connection.request" } => {
        return event.type === "teti.connection.request";
      })
      .map(({ type: _type, ...event }) => event);
  }

  duplicateInbox(): void {
    this.inbox.push(...this.inbox);
  }

  private requirePeer(): PairedConnectionMessagingAdapter {
    if (!this.peer) {
      throw new Error("Paired connection messaging adapter peer is required.");
    }

    return this.peer;
  }
}
