import { UnconfiguredChatmailRpcClient } from "./rpc-client.ts";
import type {
  ChatmailAdapter,
  ChatmailIdentity,
  ChatmailPublicIdentity,
  ChatmailReceivedMessage,
  ChatmailRpcClient,
  ChatmailSentMessage,
  CreateChatmailAccountInput,
  DeleteChatmailAccountInput,
  LoadChatmailAccountInput,
  ReceiveChatmailMessagesInput,
  SendChatmailMessageInput
} from "./types.ts";

export class RpcChatmailAdapter implements ChatmailAdapter {
  private readonly rpc: ChatmailRpcClient;

  constructor(rpc: ChatmailRpcClient = new UnconfiguredChatmailRpcClient()) {
    this.rpc = rpc;
  }

  async createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    const accountId = await this.rpc.addAccount();
    await this.rpc.configureAccount(accountId, input);
    await this.rpc.startIo(accountId);
    return this.rpc.getAccountInfo(accountId);
  }

  async loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.rpc.getAccountInfo(input.accountId);
  }

  async getIdentity(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.loadAccount(input);
  }

  async getPublicIdentity(input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity> {
    return this.rpc.getPublicIdentity(input.accountId);
  }

  async sendMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    return this.rpc.sendTextMessage(input);
  }

  async receiveMessages(
    input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    return this.rpc.receiveMessages(input);
  }

  async deleteAccount(input: DeleteChatmailAccountInput): Promise<void> {
    await this.rpc.stopIo(input.accountId);
    await this.rpc.removeAccount(input.accountId);
  }
}

export class MockChatmailAdapter implements ChatmailAdapter {
  private nextAccountId = 1;
  private nextMessageId = 1;
  private readonly accounts = new Map<number, ChatmailIdentity>();
  private readonly inbox = new Map<number, ChatmailReceivedMessage[]>();

  async createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    const accountId = this.nextAccountId++;
    const identity: ChatmailIdentity = {
      accountId,
      address: input.address || "teti_test@mail.seep.im",
      displayName: input.displayName,
      isConfigured: true,
      isChatmail: true
    };

    this.accounts.set(accountId, identity);
    this.inbox.set(accountId, []);

    return identity;
  }

  async loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.requireAccount(input.accountId);
  }

  async getIdentity(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.requireAccount(input.accountId);
  }

  async getPublicIdentity(input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity> {
    const account = this.requireAccount(input.accountId);
    return {
      address: account.address,
      displayName: account.displayName,
      publicKey: account.publicKey,
      fingerprint: account.fingerprint
    };
  }

  async sendMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    this.requireAccount(input.accountId);

    return {
      messageId: this.nextMessageId++,
      chatId: input.accountId
    };
  }

  async receiveMessages(
    input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    this.requireAccount(input.accountId);

    const messages = this.inbox.get(input.accountId) ?? [];
    return typeof input.limit === "number" ? messages.slice(0, input.limit) : [...messages];
  }

  async deleteAccount(input: DeleteChatmailAccountInput): Promise<void> {
    this.accounts.delete(input.accountId);
    this.inbox.delete(input.accountId);
  }

  addMockReceivedMessage(
    accountId: number,
    message: Omit<ChatmailReceivedMessage, "messageId" | "chatId">
  ): ChatmailReceivedMessage {
    this.requireAccount(accountId);

    const receivedMessage: ChatmailReceivedMessage = {
      messageId: this.nextMessageId++,
      chatId: accountId,
      receivedAt: new Date().toISOString(),
      ...message
    };

    const messages = this.inbox.get(accountId) ?? [];
    messages.push(receivedMessage);
    this.inbox.set(accountId, messages);

    return receivedMessage;
  }

  private requireAccount(accountId: number): ChatmailIdentity {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Chatmail account ${accountId} does not exist.`);
    }

    return account;
  }
}

export type {
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
};
