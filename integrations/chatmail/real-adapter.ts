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
  SendChatmailMessageInput,
  WaitForChatmailDeliveryInput
} from "./types.ts";

const CHATMAIL_OUT_FAILED = 24;
const CHATMAIL_OUT_DELIVERED = 26;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 250;

export interface RealChatmailAdapterOptions {
  deliveryTimeoutMs?: number;
  deliveryPollIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export class RealChatmailAdapter implements ChatmailAdapter {
  private readonly rpc: ChatmailRpcClient;
  private readonly deliveryTimeoutMs: number;
  private readonly deliveryPollIntervalMs: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(rpc: ChatmailRpcClient, options: RealChatmailAdapterOptions = {}) {
    this.rpc = rpc;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.deliveryPollIntervalMs = options.deliveryPollIntervalMs ?? DEFAULT_DELIVERY_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
    if (!input.attachment) return this.rpc.sendTextMessage(input);
    if (!this.rpc.sendFileMessage) throw new Error("Chatmail file messages are unavailable.");
    return this.rpc.sendFileMessage({ ...input, attachment: input.attachment });
  }

  async waitForDelivery(input: WaitForChatmailDeliveryInput) {
    const deadline = this.now() + this.deliveryTimeoutMs;
    let lastState: number | undefined;

    do {
      const status = await this.rpc.getMessageStatus(input.accountId, input.messageId);
      lastState = status.state;
      if (typeof status.state === "number" && status.state >= CHATMAIL_OUT_DELIVERED) {
        return status;
      }
      if (status.state === CHATMAIL_OUT_FAILED) {
        throw new Error(status.error || "Chatmail could not deliver the Teti invitation.");
      }
      if (this.now() >= deadline) break;
      await this.delay(this.deliveryPollIntervalMs);
    } while (this.now() <= deadline);

    throw new Error(
      `Chatmail did not confirm delivery of the Teti invitation in time${
        lastState === undefined ? "." : ` (message state ${lastState}).`
      } Keep Teti online and retry.`
    );
  }

  async receiveMessages(
    input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    return this.rpc.receiveMessages(input);
  }

  async acknowledgeReceivedMessage(accountId: number, messageId: number): Promise<void> {
    await this.rpc.markMessageSeen?.(accountId, messageId);
  }

  async downloadMessageAttachment(
    accountId: number,
    messageId: number
  ): Promise<ChatmailReceivedMessage> {
    if (!this.rpc.downloadFullMessage || !this.rpc.getReceivedMessage) {
      throw new Error("Chatmail attachment download is unavailable.");
    }
    let downloadError: unknown;
    try {
      // DeltaChat schedules the full download and returns before the file is
      // available. Callers must treat the refreshed InProgress state as a
      // durable wait condition, not as a completed download.
      await this.rpc.downloadFullMessage(accountId, messageId);
    } catch (error) {
      // MsgsChanged may race the poll that observed Available. Re-read before
      // deciding whether a repeated/in-flight request is actually an error.
      downloadError = error;
    }
    const refreshed = await this.rpc.getReceivedMessage(accountId, messageId);
    if (downloadError
      && !refreshed.filePath
      && refreshed.downloadState !== "InProgress"
      && refreshed.downloadState !== "Done") {
      throw downloadError;
    }
    return refreshed;
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
