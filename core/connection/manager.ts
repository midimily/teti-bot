import type { TetiAccountStorage } from "../account/storage.ts";
import { FileTetiAccountStorage } from "../account/storage.ts";
import type { TetiIdentity } from "../../services/discovery/types.ts";
import {
  ChatmailConnectionMessagingAdapter,
  type ConnectionMessagingAdapter,
  type ReceiveConnectionRequestsInput
} from "../../integrations/chatmail/connection-messaging.ts";
import { RealChatmailAdapter } from "../../integrations/chatmail/real-adapter.ts";
import { UnconfiguredChatmailRpcClient } from "../../integrations/chatmail/rpc-client.ts";
import {
  acceptConnection,
  createHandshakeRequest,
  handleAccept,
  handleIncomingRequest,
  handleReject,
  rejectConnection
} from "./handshake.ts";
import {
  type TetiConnectionAccept,
  type TetiConnectionRecord,
  type TetiConnectionReject
} from "./types.ts";
import {
  FileTetiConnectionStorage,
  type TetiConnectionStorage
} from "./storage.ts";

export interface TetiConnectionManagerOptions {
  accountStorage?: TetiAccountStorage;
  connectionStorage?: TetiConnectionStorage;
  messagingAdapter?: ConnectionMessagingAdapter;
  requestIdFactory?: () => string;
  nonceFactory?: () => string;
  now?: () => string;
}

export class TetiConnectionManager {
  private readonly accountStorage: TetiAccountStorage;
  private readonly connectionStorage: TetiConnectionStorage;
  private readonly messagingAdapter: ConnectionMessagingAdapter;
  private readonly requestIdFactory?: () => string;
  private readonly nonceFactory?: () => string;
  private readonly now: () => string;

  constructor(options: TetiConnectionManagerOptions = {}) {
    this.accountStorage = options.accountStorage ?? new FileTetiAccountStorage();
    this.connectionStorage = options.connectionStorage ?? new FileTetiConnectionStorage();
    this.messagingAdapter =
      options.messagingAdapter ??
      new ChatmailConnectionMessagingAdapter(
        new RealChatmailAdapter(new UnconfiguredChatmailRpcClient())
      );
    this.requestIdFactory = options.requestIdFactory;
    this.nonceFactory = options.nonceFactory;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createRequest(remoteIdentity: TetiIdentity): Promise<TetiConnectionRecord> {
    return createHandshakeRequest(remoteIdentity, this.handshakeOptions());
  }

  async receiveRequests(input: Omit<ReceiveConnectionRequestsInput, "accountId"> = {}): Promise<TetiConnectionRecord[]> {
    const account = await this.requireLocalAccount();
    const received = await this.messagingAdapter.receiveConnectionRequests({
      ...input,
      accountId: account.chatmailAccountId,
    });
    const records: TetiConnectionRecord[] = [];

    for (const item of received) {
      records.push(await handleIncomingRequest(item.request, this.handshakeOptions(item.receivedAt)));
    }

    return records;
  }

  async acceptRequest(requestId: string): Promise<TetiConnectionRecord> {
    return acceptConnection(requestId, this.handshakeOptions());
  }

  async rejectRequest(requestId: string): Promise<TetiConnectionRecord> {
    return rejectConnection(requestId, this.handshakeOptions());
  }

  async handleAccept(accept: TetiConnectionAccept): Promise<TetiConnectionRecord> {
    return handleAccept(accept, this.handshakeOptions());
  }

  async handleReject(reject: TetiConnectionReject): Promise<TetiConnectionRecord> {
    return handleReject(reject, this.handshakeOptions());
  }

  async receiveEvents(input: Omit<ReceiveConnectionRequestsInput, "accountId"> = {}): Promise<TetiConnectionRecord[]> {
    const account = await this.requireLocalAccount();
    const events = await this.messagingAdapter.receiveConnectionEvents({
      ...input,
      accountId: account.chatmailAccountId,
    });
    const records: TetiConnectionRecord[] = [];

    for (const event of events) {
      if (event.type === "teti.connection.request") {
        records.push(await handleIncomingRequest(event.request, this.handshakeOptions(event.receivedAt)));
      }

      if (event.type === "teti.connection.accept") {
        records.push(await handleAccept(event.accept, this.handshakeOptions(event.receivedAt)));
      }

      if (event.type === "teti.connection.reject") {
        records.push(await handleReject(event.reject, this.handshakeOptions(event.receivedAt)));
      }
    }

    return records;
  }

  async listConnections(): Promise<TetiConnectionRecord[]> {
    return this.connectionStorage.loadAll();
  }

  private async requireLocalAccount() {
    const account = await this.accountStorage.load();
    if (!account) {
      throw new Error("A local Teti account is required before creating connections.");
    }

    return account;
  }

  private handshakeOptions(timestamp?: string) {
    return {
      accountStorage: this.accountStorage,
      connectionStorage: this.connectionStorage,
      messagingAdapter: this.messagingAdapter,
      requestIdFactory: this.requestIdFactory,
      nonceFactory: this.nonceFactory,
      now: timestamp ? () => timestamp : this.now
    };
  }
}
