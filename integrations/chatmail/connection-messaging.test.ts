import assert from "node:assert/strict";
import test from "node:test";
import {
  parseConnectionAcceptEnvelope,
  parseConnectionRejectEnvelope,
  parseConnectionRequestEnvelope
} from "../../core/connection/protocol.ts";
import type { TetiConnectionRequest } from "../../core/connection/types.ts";
import { ChatmailConnectionMessagingAdapter } from "./connection-messaging.ts";
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
} from "./types.ts";

test("connection messaging sends request envelopes through chatmail adapter", async () => {
  const chatmailAdapter = new RecordingChatmailAdapter();
  const messaging = new ChatmailConnectionMessagingAdapter(chatmailAdapter);
  const request = createRequest();

  const sent = await messaging.sendConnectionRequest({
    accountId: 3,
    toAddress: "remote@mail.seep.im",
    toPublicKey: "remote-public-key",
    request
  });

  assert.deepEqual(sent, {
    messageId: 1,
    chatId: 3
  });
  assert.equal(chatmailAdapter.sendCalls.length, 1);
  assert.equal(chatmailAdapter.sendCalls[0].accountId, 3);
  assert.equal(chatmailAdapter.sendCalls[0].peerAddress, "remote@mail.seep.im");
  assert.equal(chatmailAdapter.sendCalls[0].peerPublicKey, "remote-public-key");
  assert.equal(JSON.parse(chatmailAdapter.sendCalls[0].text).teti, true);
  assert.deepEqual(parseConnectionRequestEnvelope(chatmailAdapter.sendCalls[0].text), request);
});

test("connection messaging receives only valid connection request envelopes", async () => {
  const chatmailAdapter = new RecordingChatmailAdapter();
  const request = createRequest();
  chatmailAdapter.receivedMessages.push(
    {
      messageId: 1,
      chatId: 3,
      fromAddress: "remote@mail.seep.im",
      text: JSON.stringify({
        type: "teti.connection.request",
        version: 1,
        payload: request
      }),
      receivedAt: "2026-07-11T00:00:00.000Z"
    },
    {
      messageId: 2,
      chatId: 3,
      text: "not a teti connection message"
    }
  );
  const messaging = new ChatmailConnectionMessagingAdapter(chatmailAdapter);

  const received = await messaging.receiveConnectionRequests({
    accountId: 3
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].messageId, 1);
  assert.deepEqual(received[0].request, request);
});

test("connection messaging sends accept and reject envelopes through chatmail adapter", async () => {
  const chatmailAdapter = new RecordingChatmailAdapter();
  const messaging = new ChatmailConnectionMessagingAdapter(chatmailAdapter);

  await messaging.sendConnectionAccept({
    accountId: 3,
    toAddress: "remote@mail.seep.im",
    toPublicKey: "remote-public-key",
    accept: {
      version: 1,
      requestId: "request-1",
      fromTetiId: "teti_local",
      fromAddress: "local@mail.seep.im",
      createdAt: "2026-07-11T00:00:00.000Z",
      nonce: "accept-nonce"
    }
  });
  await messaging.sendConnectionReject({
    accountId: 3,
    toAddress: "remote@mail.seep.im",
    toPublicKey: "remote-public-key",
    reject: {
      requestId: "request-2",
      reason: "not now"
    }
  });

  assert.equal(chatmailAdapter.sendCalls[0].peerPublicKey, "remote-public-key");
  assert.equal(chatmailAdapter.sendCalls[1].peerPublicKey, "remote-public-key");
  assert.deepEqual(parseConnectionAcceptEnvelope(chatmailAdapter.sendCalls[0].text), {
    version: 1,
    requestId: "request-1",
    fromTetiId: "teti_local",
    fromAddress: "local@mail.seep.im",
    createdAt: "2026-07-11T00:00:00.000Z",
    nonce: "accept-nonce"
  });
  assert.deepEqual(parseConnectionRejectEnvelope(chatmailAdapter.sendCalls[1].text), {
    requestId: "request-2",
    reason: "not now"
  });
});

test("connection messaging receives accept envelopes and ignores malformed envelopes", async () => {
  const chatmailAdapter = new RecordingChatmailAdapter();
  chatmailAdapter.receivedMessages.push(
    {
      messageId: 1,
      chatId: 3,
      fromAddress: "remote@mail.seep.im",
      text: JSON.stringify({
        teti: true,
        type: "teti.connection.accept",
        version: 1,
        payload: {
          version: 1,
          requestId: "request-1",
          fromTetiId: "teti_remote",
          fromAddress: "remote@mail.seep.im",
          createdAt: "2026-07-11T00:00:00.000Z",
          nonce: "accept-nonce"
        }
      }),
      receivedAt: "2026-07-11T00:00:00.000Z"
    },
    {
      messageId: 2,
      chatId: 3,
      text: JSON.stringify({
        teti: true,
        type: "teti.connection.request",
        version: 1,
        payload: {
          privateKey: "must-not-cross-boundary"
        }
      })
    }
  );
  const messaging = new ChatmailConnectionMessagingAdapter(chatmailAdapter);

  const events = await messaging.receiveConnectionEvents({
    accountId: 3
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "teti.connection.accept");
  if (events[0].type === "teti.connection.accept") {
    assert.equal(events[0].accept.requestId, "request-1");
  }
});

test("connection messaging polls repeatedly and extracts a Teti envelope", async () => {
  const chatmailAdapter = new RecordingChatmailAdapter();
  const request = createRequest();
  chatmailAdapter.receiveMessageBatches.push(
    [
      {
        messageId: 1,
        chatId: 3,
        text: "ordinary chatmail text"
      }
    ],
    [
      {
        messageId: 2,
        chatId: 3,
        fromAddress: "remote@mail.seep.im",
        text: JSON.stringify({
          teti: true,
          type: "teti.connection.request",
          version: 1,
          payload: request
        })
      }
    ]
  );
  const diagnostics: unknown[] = [];
  const messaging = new ChatmailConnectionMessagingAdapter(chatmailAdapter);

  const events = await messaging.receiveConnectionEvents({
    accountId: 3,
    pollCount: 2,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  assert.equal(chatmailAdapter.receiveCalls.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "teti.connection.request");
  assert.equal(JSON.stringify(diagnostics).includes("ordinary chatmail text"), false);
  assert.deepEqual(diagnostics.at(-1), {
    source: "connection",
    type: "parsedEnvelope",
    accountId: 3,
    messageId: 2,
    envelopeType: "teti.connection.request"
  });
});

function createRequest(): TetiConnectionRequest {
  return {
    version: 1,
    requestId: "request-1",
    fromTetiId: "teti_local",
    fromAddress: "local@mail.seep.im",
    publicKey: "local-public-key",
    profile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code"]
    },
    createdAt: "2026-07-11T00:00:00.000Z",
    nonce: "nonce-1"
  };
}

class RecordingChatmailAdapter implements ChatmailAdapter {
  readonly sendCalls: SendChatmailMessageInput[] = [];
  readonly receiveCalls: ReceiveChatmailMessagesInput[] = [];
  readonly receivedMessages: ChatmailReceivedMessage[] = [];
  readonly receiveMessageBatches: ChatmailReceivedMessage[][] = [];

  async createAccount(_input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    throw new Error("Not implemented in this test.");
  }

  async loadAccount(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    throw new Error("Not implemented in this test.");
  }

  async getIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    throw new Error("Not implemented in this test.");
  }

  async getPublicIdentity(_input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity> {
    throw new Error("Not implemented in this test.");
  }

  async sendMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    this.sendCalls.push(input);
    return {
      messageId: this.sendCalls.length,
      chatId: input.accountId
    };
  }

  async receiveMessages(
    input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    this.receiveCalls.push(input);
    if (this.receiveMessageBatches.length > 0) {
      return this.receiveMessageBatches.shift() ?? [];
    }

    return this.receivedMessages;
  }

  async deleteAccount(_input: DeleteChatmailAccountInput): Promise<void> {
    throw new Error("Not implemented in this test.");
  }
}
