import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FileTetiAccountStorage, type TetiAccountStorage } from "../account/storage.ts";
import {
  FileTetiConnectionStorage,
  type TetiConnectionStorage
} from "../connection/storage.ts";
import { TetiConnectionState, type TetiConnectionRecord } from "../connection/types.ts";
import {
  createApplicationEnvelope,
  parseApplicationEnvelope,
  serializeApplicationEnvelope
} from "../protocol/envelope.ts";
import {
  TETI_APPLICATION_PROTOCOL_VERSION,
  type TetiApplicationEnvelope,
  type TetiCapabilityOfferPayload,
  type TetiPresencePayload,
  type TetiProcessedMessageStore,
  type TetiProfileSyncPayload
} from "../protocol/types.ts";
import { TetiApplicationProtocolError } from "../protocol/validator.ts";
import { RealChatmailAdapter } from "../../integrations/chatmail/real-adapter.ts";
import { UnconfiguredChatmailRpcClient } from "../../integrations/chatmail/rpc-client.ts";
import type { ChatmailAdapter } from "../../integrations/chatmail/types.ts";
import {
  handleApplicationEnvelope,
  type TetiApplicationHandlerResult
} from "./handlers.ts";

export interface TetiMessageTracker {
  has(messageId: string): Promise<boolean>;
  markProcessed(messageId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TetiApplicationManagerOptions {
  accountStorage?: TetiAccountStorage;
  connectionStorage?: TetiConnectionStorage;
  chatmailAdapter?: ChatmailAdapter;
  messageTracker?: TetiMessageTracker;
  messageIdFactory?: () => string;
  now?: () => string;
}

export interface SendApplicationEnvelopeInput<TPayload> {
  connectionRequestId: string;
  type: TetiApplicationEnvelope<TPayload>["type"];
  payload: TPayload;
}

export interface SentApplicationEnvelope {
  envelope: TetiApplicationEnvelope;
  messageId: number;
  chatId?: number;
}

export interface ReceivedApplicationEnvelope {
  envelope: TetiApplicationEnvelope;
  result: TetiApplicationHandlerResult;
  connection: TetiConnectionRecord;
  chatmailMessageId: number;
}

export class TetiApplicationManager {
  private readonly accountStorage: TetiAccountStorage;
  private readonly connectionStorage: TetiConnectionStorage;
  private readonly chatmailAdapter: ChatmailAdapter;
  private readonly messageTracker: TetiMessageTracker;
  private readonly messageIdFactory?: () => string;
  private readonly now: () => string;

  constructor(options: TetiApplicationManagerOptions = {}) {
    this.accountStorage = options.accountStorage ?? new FileTetiAccountStorage();
    this.connectionStorage = options.connectionStorage ?? new FileTetiConnectionStorage();
    this.chatmailAdapter =
      options.chatmailAdapter ?? new RealChatmailAdapter(new UnconfiguredChatmailRpcClient());
    this.messageTracker = options.messageTracker ?? new FileTetiMessageTracker();
    this.messageIdFactory = options.messageIdFactory;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async sendProfileSync(
    connectionRequestId: string,
    payload: TetiProfileSyncPayload
  ): Promise<SentApplicationEnvelope> {
    return this.sendApplicationEnvelope({
      connectionRequestId,
      type: "teti.profile.sync",
      payload
    });
  }

  async sendCapabilityOffer(
    connectionRequestId: string,
    payload: TetiCapabilityOfferPayload
  ): Promise<SentApplicationEnvelope> {
    return this.sendApplicationEnvelope({
      connectionRequestId,
      type: "teti.capability.offer",
      payload
    });
  }

  async sendPresence(
    connectionRequestId: string,
    payload: TetiPresencePayload
  ): Promise<SentApplicationEnvelope> {
    return this.sendApplicationEnvelope({
      connectionRequestId,
      type: "teti.presence",
      payload
    });
  }

  async sendApplicationEnvelope<TPayload>(
    input: SendApplicationEnvelopeInput<TPayload>
  ): Promise<SentApplicationEnvelope> {
    const account = await this.requireLocalAccount();
    const connection = await this.requireConfirmedConnection(input.connectionRequestId);
    const envelope = createApplicationEnvelope({
      type: input.type,
      fromTetiId: account.id,
      payload: input.payload,
      messageId: this.messageIdFactory?.(),
      createdAt: this.now()
    });
    const sent = await this.chatmailAdapter.sendMessage({
      accountId: account.chatmailAccountId,
      peerAddress: connection.remoteAddress,
      text: serializeApplicationEnvelope(envelope)
    });

    return {
      envelope,
      messageId: sent.messageId,
      chatId: sent.chatId
    };
  }

  async receiveApplicationEnvelopes(input: { limit?: number } = {}): Promise<ReceivedApplicationEnvelope[]> {
    const account = await this.requireLocalAccount();
    const messages = await this.chatmailAdapter.receiveMessages({
      accountId: account.chatmailAccountId,
      limit: input.limit
    });
    const results: ReceivedApplicationEnvelope[] = [];

    for (const message of messages) {
      if (!message.text) {
        continue;
      }

      let envelope: TetiApplicationEnvelope;
      try {
        envelope = parseApplicationEnvelope(message.text);
      } catch (error) {
        if (error instanceof TetiApplicationProtocolError) {
          continue;
        }

        throw error;
      }

      const connection = await this.findConfirmedConnectionForEnvelope(envelope, message.fromAddress);
      if (!connection) {
        continue;
      }

      if (await this.messageTracker.has(envelope.messageId)) {
        continue;
      }

      const result = handleApplicationEnvelope(envelope);
      await this.messageTracker.markProcessed(envelope.messageId);
      results.push({
        envelope,
        result,
        connection,
        chatmailMessageId: message.messageId
      });
    }

    return results;
  }

  private async requireLocalAccount() {
    const account = await this.accountStorage.load();
    if (!account) {
      throw new Error("A local Teti account is required before sending application messages.");
    }

    return account;
  }

  private async requireConfirmedConnection(requestId: string): Promise<TetiConnectionRecord> {
    const connection = (await this.connectionStorage.loadAll()).find((item) => item.requestId === requestId);
    if (!connection) {
      throw new Error(`Teti connection ${requestId} does not exist.`);
    }

    if (connection.state !== TetiConnectionState.Confirmed) {
      throw new Error("Teti application messages require a Confirmed connection.");
    }

    return connection;
  }

  private async findConfirmedConnectionForEnvelope(
    envelope: TetiApplicationEnvelope,
    fromAddress: string | undefined
  ): Promise<TetiConnectionRecord | null> {
    return (
      (await this.connectionStorage.loadAll()).find((connection) => {
        return (
          connection.state === TetiConnectionState.Confirmed &&
          connection.remoteTetiId === envelope.fromTetiId &&
          (!fromAddress || connection.remoteAddress === fromAddress)
        );
      }) ?? null
    );
  }
}

export class FileTetiMessageTracker implements TetiMessageTracker {
  private readonly messagesPath: string;

  constructor(messagesPath = defaultTetiMessagesPath()) {
    this.messagesPath = messagesPath;
  }

  async has(messageId: string): Promise<boolean> {
    return (await this.load()).messageIds.includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    const store = await this.load();
    if (!store.messageIds.includes(messageId)) {
      store.messageIds.push(messageId);
      await this.save(store);
    }
  }

  async clear(): Promise<void> {
    await rm(this.messagesPath, { force: true });
  }

  private async load(): Promise<TetiProcessedMessageStore> {
    try {
      const raw = await readFile(this.messagesPath, "utf8");
      const store = JSON.parse(raw) as TetiProcessedMessageStore;
      validateMessageStore(store);
      return store;
    } catch (error) {
      if (isNotFound(error)) {
        return {
          version: TETI_APPLICATION_PROTOCOL_VERSION,
          messageIds: []
        };
      }

      throw error;
    }
  }

  private async save(store: TetiProcessedMessageStore): Promise<void> {
    validateMessageStore(store);
    await mkdir(dirname(this.messagesPath), { recursive: true });
    const tmpPath = `${this.messagesPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.messagesPath);
  }
}

export class MemoryTetiMessageTracker implements TetiMessageTracker {
  private readonly messageIds = new Set<string>();

  async has(messageId: string): Promise<boolean> {
    return this.messageIds.has(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    this.messageIds.add(messageId);
  }

  async clear(): Promise<void> {
    this.messageIds.clear();
  }
}

export function defaultTetiMessagesPath(): string {
  return join(homedir(), ".teti", "messages.json");
}

function validateMessageStore(store: TetiProcessedMessageStore): void {
  if (store.version !== TETI_APPLICATION_PROTOCOL_VERSION) {
    throw new Error("Unsupported Teti message store version.");
  }

  if (!Array.isArray(store.messageIds)) {
    throw new Error("Teti message store messageIds must be an array.");
  }

  if (store.messageIds.some((messageId) => typeof messageId !== "string" || !messageId.trim())) {
    throw new Error("Teti message store contains an invalid messageId.");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
