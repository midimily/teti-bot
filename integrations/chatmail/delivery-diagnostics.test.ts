import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTIC_PLAIN_TEXT_BODY,
  classifyDeliveryMatrixResult,
  redactDeliveryDiagnostics,
  safeMessagePreview,
  sendDiagnosticPlainTextMessage
} from "./delivery-diagnostics.ts";
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

test("diagnostic plain text send uses the same chatmail adapter send path", async () => {
  const adapter = new RecordingChatmailAdapter();

  const sent = await sendDiagnosticPlainTextMessage(adapter, {
    accountId: 9,
    peerAddress: "remote@mail.seep.im"
  });

  assert.deepEqual(sent, {
    messageId: 1,
    chatId: 9
  });
  assert.deepEqual(adapter.sendCalls, [
    {
      accountId: 9,
      peerAddress: "remote@mail.seep.im",
      text: DIAGNOSTIC_PLAIN_TEXT_BODY
    }
  ]);
});

test("receive loop can surface diagnostic plain text when mocked", async () => {
  const adapter = new RecordingChatmailAdapter();
  adapter.receivedMessages.push({
    messageId: 2,
    chatId: 3,
    fromAddress: "remote@mail.seep.im",
    text: DIAGNOSTIC_PLAIN_TEXT_BODY
  });

  const messages = await adapter.receiveMessages({ accountId: 9 });

  assert.equal(messages.length, 1);
  assert.equal(safeMessagePreview(messages[0].text), DIAGNOSTIC_PLAIN_TEXT_BODY);
});

test("delivery diagnostics redact secrets and normal message bodies", () => {
  const redacted = redactDeliveryDiagnostics({
    password: "secret",
    token: "secret-token",
    privateKey: "private",
    text: "normal user text must not be logged",
    nested: {
      body: DIAGNOSTIC_PLAIN_TEXT_BODY,
      databasePath: "/private/db"
    }
  });

  assert.deepEqual(redacted, {
    password: "[REDACTED]",
    token: "[REDACTED]",
    privateKey: "[REDACTED]",
    text: "[REDACTED]",
    nested: {
      body: DIAGNOSTIC_PLAIN_TEXT_BODY,
      databasePath: "[REDACTED]"
    }
  });
});

test("delivery matrix classification separates send success from receive success", () => {
  assert.equal(
    classifyDeliveryMatrixResult({ sendSucceeded: false, receiveSucceeded: false }),
    "send_failed"
  );
  assert.equal(
    classifyDeliveryMatrixResult({ sendSucceeded: true, receiveSucceeded: false }),
    "send_succeeded_receive_failed"
  );
  assert.equal(
    classifyDeliveryMatrixResult({ sendSucceeded: true, receiveSucceeded: true }),
    "send_and_receive_succeeded"
  );
});

class RecordingChatmailAdapter implements ChatmailAdapter {
  readonly sendCalls: SendChatmailMessageInput[] = [];
  readonly receivedMessages: ChatmailReceivedMessage[] = [];

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
    _input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    return this.receivedMessages;
  }

  async deleteAccount(_input: DeleteChatmailAccountInput): Promise<void> {
    throw new Error("Not implemented in this test.");
  }
}
