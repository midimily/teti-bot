import assert from "node:assert/strict";
import test from "node:test";
import type { TetiAccount } from "../account/model.ts";
import { MemoryTetiAccountStorage } from "../account/storage.ts";
import { MemoryTetiConnectionStorage } from "../connection/storage.ts";
import { TetiConnectionState, type TetiConnectionRecord } from "../connection/types.ts";
import { createApplicationEnvelope, parseApplicationEnvelope, serializeApplicationEnvelope } from "../protocol/envelope.ts";
import { MAX_TETI_APPLICATION_ENVELOPE_BYTES } from "../protocol/types.ts";
import { TetiApplicationProtocolError, validateApplicationEnvelope } from "../protocol/validator.ts";
import {
  MemoryTetiMessageTracker,
  TetiApplicationManager
} from "./manager.ts";
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
} from "../../integrations/chatmail/types.ts";

const fixedNow = "2026-07-11T00:00:00.000Z";

test("confirmed connection can send application envelope", async () => {
  const { manager, chatmailAdapter } = await createApplicationHarness({
    connectionState: TetiConnectionState.Confirmed,
    messageId: "message-1"
  });

  const sent = await manager.sendProfileSync("request-1", {
    displayName: "Alex",
    platform: "macOS",
    aiEnvironment: ["Claude Code"]
  });

  assert.equal(sent.envelope.type, "teti.profile.sync");
  assert.equal(sent.envelope.messageId, "message-1");
  assert.equal(sent.envelope.fromTetiId, "teti_local0001");
  assert.equal(chatmailAdapter.sendCalls.length, 1);
  assert.equal(chatmailAdapter.sendCalls[0].peerAddress, "remote001@mail.seep.im");
  assert.deepEqual(JSON.parse(chatmailAdapter.sendCalls[0].text), sent.envelope);
});

test("pending connection is rejected before sending", async () => {
  const { manager, chatmailAdapter } = await createApplicationHarness({
    connectionState: TetiConnectionState.Requested,
    messageId: "message-1"
  });

  await assert.rejects(
    () =>
      manager.sendPresence("request-1", {
        status: "online",
        timestamp: fixedNow,
        collaborationProtocolEpoch: 2,
        taskProtocolVersions: [4],
        passportSchemaVersions: [3]
      }),
    /Confirmed connection/
  );
  assert.equal(chatmailAdapter.sendCalls.length, 0);
});

test("invalid application envelope is rejected", () => {
  assert.throws(
    () =>
      validateApplicationEnvelope({
        version: 2,
        type: "teti.capability.offer",
        messageId: "bad-message",
        fromTetiId: "teti_remote001",
        createdAt: fixedNow,
        payload: {
          capabilities: ["coding"],
          privateKey: "must-not-cross-boundary"
        }
      }),
    (error) =>
      error instanceof TetiApplicationProtocolError &&
      /must not contain privateKey/.test(error.message)
  );
});

test("0.1 Application Envelopes are rejected before their payload is parsed", () => {
  assert.throws(() => validateApplicationEnvelope({
    version: 1,
    type: "teti.task.request",
    messageId: "legacy-task",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: { privateKey: "must-never-be-inspected-as-a-task" }
  }), /Unsupported Teti application envelope version/);
});

test("0.2 Application Envelopes reject historical Passport payloads", () => {
  assert.throws(() => validateApplicationEnvelope({
    version: 2,
    type: "teti.ai.status.sync",
    messageId: "legacy-passport",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: {
      schemaVersion: 1,
      sharing: "disabled",
      generatedAt: fixedNow,
      expiresAt: "2026-07-11T01:00:00.000Z",
      tools: []
    }
  }), /AI status sync payload is invalid/);
});

test("application protocol rejects a non-canonical fromTetiId", () => {
  assert.throws(
    () =>
      validateApplicationEnvelope({
        version: 2,
        type: "teti.presence",
        messageId: "bad-public-id",
        fromTetiId: "teti_REMOTE001",
        createdAt: fixedNow,
        payload: { status: "online", timestamp: fixedNow, collaborationProtocolEpoch: 2 }
      }),
    (error) =>
      error instanceof TetiApplicationProtocolError &&
      /exactly 9 ASCII lowercase/.test(error.message)
  );
});

test("Presence accepts explicit Passport capability and rejects malformed version lists", () => {
  assert.doesNotThrow(() => validateApplicationEnvelope({
    version: 2,
    type: "teti.presence",
    messageId: "passport-capability",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: {
      status: "online",
      timestamp: fixedNow,
      collaborationProtocolEpoch: 2,
      taskProtocolVersions: [4],
      passportSchemaVersions: [3]
    }
  }));
  for (const passportSchemaVersions of [[], [1], [3, 3], [0], [3, 4], [256]]) {
    assert.throws(() => validateApplicationEnvelope({
      version: 2,
      type: "teti.presence",
      messageId: "bad-passport-capability",
      fromTetiId: "teti_remote001",
      createdAt: fixedNow,
      payload: {
        status: "online",
        timestamp: fixedNow,
        collaborationProtocolEpoch: 2,
        taskProtocolVersions: [4],
        passportSchemaVersions
      }
    }), /Passport schema versions/);
  }
});

test("application protocol rejects oversized raw JSON and envelope extension fields", () => {
  const oversized = JSON.stringify({
    version: 2,
    type: "teti.presence",
    messageId: "oversized-message",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: { status: "online", timestamp: fixedNow, collaborationProtocolEpoch: 2 },
    padding: "x".repeat(MAX_TETI_APPLICATION_ENVELOPE_BYTES)
  });
  assert.throws(() => parseApplicationEnvelope(oversized), /exceeds the allowed size/);
  assert.throws(() => validateApplicationEnvelope({
    version: 2,
    type: "teti.presence",
    messageId: "extension-message",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: { status: "online", timestamp: fixedNow, collaborationProtocolEpoch: 2 },
    command: "unsafe"
  }), /unsupported field/);
  assert.throws(() => validateApplicationEnvelope({
    version: 2,
    type: "teti.presence",
    messageId: "payload-extension-message",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: { status: "online", timestamp: fixedNow, collaborationProtocolEpoch: 2, command: "unsafe" }
  }), /unsupported field/);
});

test("duplicate message is ignored after first processing", async () => {
  const { manager, chatmailAdapter } = await createApplicationHarness({
    connectionState: TetiConnectionState.Confirmed,
    messageId: "outgoing-message"
  });
  const envelope = createApplicationEnvelope({
    type: "teti.presence",
    messageId: "incoming-message",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: {
      status: "online",
      timestamp: fixedNow,
      collaborationProtocolEpoch: 2,
      taskProtocolVersions: [4],
      passportSchemaVersions: [3]
    }
  });
  chatmailAdapter.receivedMessages.push(
    {
      messageId: 1,
      chatId: 1,
      fromAddress: "remote001@mail.seep.im",
      text: serializeApplicationEnvelope(envelope),
      receivedAt: fixedNow
    },
    {
      messageId: 2,
      chatId: 1,
      fromAddress: "remote001@mail.seep.im",
      text: serializeApplicationEnvelope(envelope),
      receivedAt: fixedNow
    }
  );

  const firstBatch = await manager.receiveApplicationEnvelopes();
  const secondBatch = await manager.receiveApplicationEnvelopes();

  assert.equal(firstBatch.length, 1);
  assert.equal(firstBatch[0].result.type, "presence");
  assert.equal(secondBatch.length, 0);
});

test("capability exchange is handled for confirmed connections", async () => {
  const { manager, chatmailAdapter } = await createApplicationHarness({
    connectionState: TetiConnectionState.Confirmed,
    messageId: "outgoing-message"
  });
  const envelope = createApplicationEnvelope({
    type: "teti.capability.offer",
    messageId: "capability-message",
    fromTetiId: "teti_remote001",
    createdAt: fixedNow,
    payload: {
      capabilities: ["coding", "research"]
    }
  });
  chatmailAdapter.receivedMessages.push({
    messageId: 1,
    chatId: 1,
    fromAddress: "remote001@mail.seep.im",
    text: serializeApplicationEnvelope(envelope),
    receivedAt: fixedNow
  });

  const [received] = await manager.receiveApplicationEnvelopes();

  assert.equal(received.result.type, "capability.offer");
  assert.deepEqual(
    received.result.type === "capability.offer" ? received.result.capabilities : [],
    ["coding", "research"]
  );
});

test("Task request and receipt use the existing Application Envelope", async () => {
  const { manager, chatmailAdapter } = await createApplicationHarness({
    connectionState: TetiConnectionState.Confirmed,
    messageId: "task-envelope"
  });
  const request = {
    schemaVersion: 4 as const,
    taskId: "task-001",
    requesterTetiId: "teti_local0001",
    targetTetiId: "teti_remote001",
    offerId: "offer-001",
    capabilityId: "code-analysis",
    input: { kind: "parts" as const, parts: [{ kind: "text" as const, text: "Review this text." }] },
    createdAt: fixedNow,
    expiresAt: "2026-07-11T01:00:00.000Z"
  };

  const sent = await manager.sendTaskRequest("request-1", request);
  assert.equal(sent.envelope.version, 2);
  assert.equal(sent.envelope.type, "teti.task.request");
  assert.equal((sent.envelope.payload as typeof request).taskId, "task-001");
  assert.equal(chatmailAdapter.sendCalls.length, 1);

  const attachmentReceipt = await manager.sendTaskAttachmentReceipt("request-1", {
    schemaVersion: 1,
    taskId: request.taskId,
    requesterTetiId: request.requesterTetiId,
    targetTetiId: request.targetTetiId,
    purpose: "input",
    attachmentId: "image-001",
    receivedAt: fixedNow
  });
  assert.equal(attachmentReceipt.envelope.type, "teti.task.attachment.receipt");
  assert.equal(chatmailAdapter.sendCalls.length, 2);
  assert.equal(chatmailAdapter.sendCalls[1]?.attachment, undefined);

  assert.throws(() => createApplicationEnvelope({
    type: "teti.task.request",
    fromTetiId: "teti_local0001",
    payload: { ...request, command: "unsafe" }
  }), /Task request payload is invalid/);
});

async function createApplicationHarness(input: {
  connectionState: TetiConnectionState;
  messageId: string;
}) {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(createLocalAccount());
  const connectionStorage = new MemoryTetiConnectionStorage();
  await connectionStorage.upsert(createConnection(input.connectionState));
  const chatmailAdapter = new RecordingChatmailAdapter();
  const manager = new TetiApplicationManager({
    accountStorage,
    connectionStorage,
    chatmailAdapter,
    messageTracker: new MemoryTetiMessageTracker(),
    messageIdFactory: () => input.messageId,
    now: () => fixedNow
  });

  return { manager, chatmailAdapter };
}

function createLocalAccount(): TetiAccount {
  return {
    version: 1,
    id: "teti_local0001",
    address: "local0001@mail.seep.im",
    chatmailAccountId: 7,
    publicKey: "local-public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code"]
    },
    createdAt: fixedNow
  };
}

function createConnection(state: TetiConnectionState): TetiConnectionRecord {
  return {
    version: 1,
    requestId: "request-1",
    state,
    direction: "outgoing",
    remoteTetiId: "teti_remote001",
    remoteAddress: "remote001@mail.seep.im",
    request: {
      version: 1,
      requestId: "request-1",
      fromTetiId: "teti_local0001",
      fromAddress: "local0001@mail.seep.im",
      publicKey: "local-public-key",
      profile: {
        platform: "macOS",
        category: ["developer"],
        aiEnvironment: ["Claude Code"]
      },
      createdAt: fixedNow,
      nonce: "nonce"
    },
    createdAt: fixedNow,
    updatedAt: fixedNow,
    confirmedAt: state === TetiConnectionState.Confirmed ? fixedNow : undefined
  };
}

class RecordingChatmailAdapter implements ChatmailAdapter {
  readonly sendCalls: SendChatmailMessageInput[] = [];
  readonly receivedMessages: ChatmailReceivedMessage[] = [];
  private nextMessageId = 1;

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
      messageId: this.nextMessageId++,
      chatId: input.accountId
    };
  }

  async receiveMessages(
    _input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    const messages = [...this.receivedMessages];
    this.receivedMessages.length = 0;
    return messages;
  }

  async deleteAccount(_input: DeleteChatmailAccountInput): Promise<void> {
    throw new Error("Not implemented in this test.");
  }
}
