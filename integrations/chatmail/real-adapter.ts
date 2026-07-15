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

export class RealChatmailAdapter implements ChatmailAdapter {
  private readonly rpc: ChatmailRpcClient;

  constructor(rpc: ChatmailRpcClient) {
    this.rpc = rpc;
  }

  async createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    const accountId = await this.rpc.addAccount();
    await this.rpc.configureAccount(accountId, input);
    await this.rpc.startIo(accountId);

    const identity = await this.rpc.getAccountInfo(accountId);
    const publicIdentity = await this.rpc.getPublicIdentity(accountId);

    return mergeIdentity(identity, publicIdentity);
  }

  async loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    const identity = await this.rpc.getAccountInfo(input.accountId);
    const publicIdentity = await this.rpc.getPublicIdentity(input.accountId);

    return mergeIdentity(identity, publicIdentity);
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

function mergeIdentity(
  identity: ChatmailIdentity,
  publicIdentity: ChatmailPublicIdentity
): ChatmailIdentity {
  return {
    ...identity,
    address: publicIdentity.address || identity.address,
    publicKey: publicIdentity.publicKey ?? identity.publicKey,
    fingerprint: publicIdentity.fingerprint ?? identity.fingerprint
  };
}

