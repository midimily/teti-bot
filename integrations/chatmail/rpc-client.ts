import type {
  ChatmailIdentity,
  ChatmailPublicIdentity,
  ChatmailReceivedMessage,
  ChatmailReceiveDiagnosticEvent,
  ChatmailRpcClient,
  ChatmailMessageStatus,
  ChatmailSentMessage,
  ChatmailChatCreateInput,
  ChatmailContactCreateInput,
  ChatmailContactLookupInput,
  CreateChatmailAccountInput,
  ChatmailVcardImportInput,
  ReceiveChatmailMessagesInput,
  SendChatmailMessageInput
} from "./types.ts";

export interface JsonRpcTransport {
  request<TResponse>(method: string, params?: unknown): Promise<TResponse>;
}

export interface JsonRpcConnection {
  send(payload: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcClientTransport implements JsonRpcTransport {
  private nextId = 1;
  private readonly connection: JsonRpcConnection;

  constructor(connection: JsonRpcConnection) {
    this.connection = connection;
  }

  async request<TResponse>(method: string, params?: unknown): Promise<TResponse> {
    const id = this.nextId++;
    const response = await this.connection.send({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    if (response.error) {
      throw new ChatmailRpcError(method, response.error.message, response.error.code, response.error.data);
    }

    return response.result as TResponse;
  }
}

export class JsonRpcChatmailClient implements ChatmailRpcClient {
  private readonly transport: JsonRpcTransport;
  private readonly observedMessageIds = new Set<string>();

  constructor(transport: JsonRpcTransport) {
    this.transport = transport;
  }

  async addAccount(): Promise<number> {
    return this.transport.request<number>("add_account", []);
  }

  async getAccountInfo(accountId: number): Promise<ChatmailIdentity> {
    const account = await this.transport.request<ChatmailAccountInfo>("get_account_info", [
      accountId
    ]);
    return toChatmailIdentity(accountId, account);
  }

  async setConfig(accountId: number, key: string, value: string | null): Promise<void> {
    await this.transport.request<void>("set_config", [accountId, key, value]);
  }

  async configureAccount(
    accountId: number,
    input: CreateChatmailAccountInput
  ): Promise<void> {
    if (input.displayName) {
      await this.setConfig(accountId, "displayname", input.displayName);
    }

    if (input.qr) {
      await this.transport.request<void>("add_transport_from_qr", [accountId, input.qr]);
      return;
    }

    if (!input.address || !input.password) {
      throw new ChatmailRpcConfigurationError(
        "Chatmail address and password are required unless configuring from a chatmail QR."
      );
    }

    await this.transport.request<void>("add_or_update_transport", [
      accountId,
      toEnteredLoginParam(input)
    ]);
  }

  async startIo(accountId: number): Promise<void> {
    await this.transport.request<void>("start_io", [accountId]);
  }

  async stopIo(accountId: number): Promise<void> {
    await this.transport.request<void>("stop_io", [accountId]);
  }

  async getPublicIdentity(accountId: number): Promise<ChatmailPublicIdentity> {
    const account = await this.getAccountInfo(accountId);
    const vcard = await this.transport.request<string>("make_vcard", [
      accountId,
      [SELF_CONTACT_ID]
    ]);
    const vcardIdentity = extractPublicIdentityFromVcard(vcard);

    return {
      address: account.address || vcardIdentity.address || "",
      publicKey: vcardIdentity.publicKey,
      fingerprint: undefined
    };
  }

  async lookupContactIdByAddr(input: ChatmailContactLookupInput): Promise<number | null> {
    return this.transport.request<number | null>("lookup_contact_id_by_addr", [
      input.accountId,
      input.address
    ]);
  }

  async createContact(input: ChatmailContactCreateInput): Promise<number> {
    return this.transport.request<number>("create_contact", [
      input.accountId,
      input.address,
      input.displayName ?? null
    ]);
  }

  async importVcardContents(input: ChatmailVcardImportInput): Promise<number[]> {
    return this.transport.request<number[]>("import_vcard_contents", [
      input.accountId,
      input.vcard
    ]);
  }

  async createChatByContactId(input: ChatmailChatCreateInput): Promise<number> {
    return this.transport.request<number>("create_chat_by_contact_id", [
      input.accountId,
      input.contactId
    ]);
  }

  async sendTextMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    const contactId = await this.resolvePeerContactId(input);
    const chatId = await this.createChatByContactId({
      accountId: input.accountId,
      contactId
    });
    const messageId = await this.transport.request<number>("misc_send_text_message", [
      input.accountId,
      chatId,
      input.text
    ]);

    return {
      messageId,
      chatId
    };
  }

  private async resolvePeerContactId(input: SendChatmailMessageInput): Promise<number> {
    if (input.peerPublicKey) {
      const contactIds = await this.importVcardContents({
        accountId: input.accountId,
        vcard: makePeerVcard(input)
      });
      const importedContactId = contactIds[0];
      if (typeof importedContactId === "number") {
        return importedContactId;
      }
    }

    return (
      (await this.lookupContactIdByAddr({
        accountId: input.accountId,
        address: input.peerAddress
      })) ??
      (await this.createContact({
        accountId: input.accountId,
        address: input.peerAddress,
        displayName: input.peerDisplayName
      }))
    );
  }

  async receiveMessages(
    input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    const messages: ChatmailReceivedMessage[] = [];
    let events: ChatmailEvent[] = [];

    try {
      events = await this.transport.request<ChatmailEvent[]>("get_next_event_batch", []);
      input.onDiagnostic?.({
        type: "eventBatch",
        accountId: input.accountId,
        events: events.map(toDiagnosticEvent)
      });
    } catch (error) {
      if (!isJsonRpcTimeout(error)) {
        throw error;
      }

      input.onDiagnostic?.({
        type: "eventBatchError",
        accountId: input.accountId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    for (const event of events) {
      const eventAccountId = numberValue(event.contextId ?? event.context_id);
      if (eventAccountId !== undefined && eventAccountId !== input.accountId) {
        continue;
      }

      const eventBody = event.event;
      if (!eventBody || !isMessageEvent(eventBody.kind)) {
        continue;
      }

      const messageId = numberValue(eventBody.msgId ?? eventBody.msg_id);
      if (messageId === undefined) {
        continue;
      }

      const message = await this.fetchReceivedMessage(input, messageId, eventBody);
      if (message) {
        messages.push(message);
      }

      if (input.limit && messages.length >= input.limit) {
        break;
      }
    }

    if (messages.length === 0) {
      const nextMessageIds = await this.getNextMessageIds(input.accountId);
      input.onDiagnostic?.({
        type: "nextMessages",
        accountId: input.accountId,
        messageIds: nextMessageIds
      });

      for (const messageId of nextMessageIds) {
        const message = await this.fetchReceivedMessage(input, messageId);
        if (message) {
          messages.push(message);
        }

        if (input.limit && messages.length >= input.limit) {
          break;
        }
      }
    }

    return messages;
  }

  async getMessageStatus(accountId: number, messageId: number): Promise<ChatmailMessageStatus> {
    const message = await this.transport.request<ChatmailMessageObject>("get_message", [
      accountId,
      messageId
    ]);

    return {
      messageId: numberValue(message.id) ?? messageId,
      chatId: numberValue(message.chatId ?? message.chat_id),
      state: numberValue(message.state),
      showPadlock: booleanValue(message.showPadlock ?? message.show_padlock),
      error: stringValue(message.error) ?? null
    };
  }

  async getNextMessageIds(accountId: number): Promise<number[]> {
    try {
      return await this.transport.request<number[]>("get_next_msgs", [accountId]);
    } catch (error) {
      if (error instanceof ChatmailRpcError && error.code === -32601) {
        return [];
      }

      throw error;
    }
  }

  private async fetchReceivedMessage(
    input: ReceiveChatmailMessagesInput,
    messageId: number,
    eventBody?: NonNullable<ChatmailEvent["event"]>
  ): Promise<ChatmailReceivedMessage | null> {
    const accountId = input.accountId;
    const key = `${accountId}:${messageId}`;
    if (this.observedMessageIds.has(key)) {
      return null;
    }

    const message = await this.transport.request<ChatmailMessageObject>("get_message", [
      accountId,
      messageId
    ]);
    this.observedMessageIds.add(key);

    const received = toChatmailReceivedMessage(messageId, eventBody, message);
    input.onDiagnostic?.({
      type: "messageFetched",
      accountId,
      messageId: received.messageId,
      chatId: received.chatId,
      fromAddress: received.fromAddress,
      hasText: Boolean(received.text)
    });
    return received;
  }

  async removeAccount(accountId: number): Promise<void> {
    await this.transport.request<void>("remove_account", [accountId]);
  }
}

export class UnconfiguredChatmailRpcClient implements ChatmailRpcClient {
  async addAccount(): Promise<number> {
    throw rpcNotConfigured();
  }

  async getAccountInfo(_accountId: number): Promise<ChatmailIdentity> {
    throw rpcNotConfigured();
  }

  async setConfig(_accountId: number, _key: string, _value: string | null): Promise<void> {
    throw rpcNotConfigured();
  }

  async configureAccount(
    _accountId: number,
    _input: CreateChatmailAccountInput
  ): Promise<void> {
    throw rpcNotConfigured();
  }

  async startIo(_accountId: number): Promise<void> {
    throw rpcNotConfigured();
  }

  async stopIo(_accountId: number): Promise<void> {
    throw rpcNotConfigured();
  }

  async getPublicIdentity(_accountId: number): Promise<ChatmailPublicIdentity> {
    throw rpcNotConfigured();
  }

  async lookupContactIdByAddr(_input: ChatmailContactLookupInput): Promise<number | null> {
    throw rpcNotConfigured();
  }

  async createContact(_input: ChatmailContactCreateInput): Promise<number> {
    throw rpcNotConfigured();
  }

  async importVcardContents(_input: ChatmailVcardImportInput): Promise<number[]> {
    throw rpcNotConfigured();
  }

  async createChatByContactId(_input: ChatmailChatCreateInput): Promise<number> {
    throw rpcNotConfigured();
  }

  async sendTextMessage(_input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    throw rpcNotConfigured();
  }

  async receiveMessages(
    _input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    throw rpcNotConfigured();
  }

  async getNextMessageIds(_accountId: number): Promise<number[]> {
    throw rpcNotConfigured();
  }

  async getMessageStatus(_accountId: number, _messageId: number): Promise<ChatmailMessageStatus> {
    throw rpcNotConfigured();
  }

  async removeAccount(_accountId: number): Promise<void> {
    throw rpcNotConfigured();
  }
}

function rpcNotConfigured(): Error {
  return new ChatmailRpcUnavailableError(
    "Chatmail JSON-RPC is not configured. Use MockChatmailAdapter for local Teti lifecycle development or provide a deltachat-rpc-server transport."
  );
}

export class ChatmailRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, message: string, code: number, data?: unknown) {
    super(message);
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class ChatmailRpcUnavailableError extends Error {}

export class ChatmailRpcConfigurationError extends Error {}

type ChatmailAccountInfo =
  | {
      kind: "Configured";
      id: number;
      addr?: string | null;
      displayName?: string | null;
      profileImage?: string | null;
      color?: string;
      privateTag?: string | null;
    }
  | {
      kind: "Unconfigured";
      id: number;
    };

interface EnteredLoginParam {
  addr: string;
  password: string;
  imapServer?: string;
  smtpServer?: string;
}

interface VcardPublicIdentity {
  address?: string;
  publicKey?: string;
}

interface ChatmailEvent {
  contextId?: number;
  context_id?: number;
  event?: {
    kind?: string;
    chatId?: number;
    chat_id?: number;
    msgId?: number;
    msg_id?: number;
  };
}

interface ChatmailMessageObject {
  id?: number;
  chatId?: number;
  chat_id?: number;
  text?: string;
  timestamp?: number;
  receivedTimestamp?: number;
  received_timestamp?: number;
  state?: number;
  showPadlock?: boolean;
  show_padlock?: boolean;
  error?: string | null;
  sender?: {
    address?: string;
    addr?: string;
  };
}

const SELF_CONTACT_ID = 1;

function toChatmailIdentity(accountId: number, account: ChatmailAccountInfo): ChatmailIdentity {
  if (account.kind === "Configured") {
    return {
      accountId: account.id,
      address: account.addr ?? "",
      displayName: account.displayName ?? undefined,
      isConfigured: true,
      isChatmail: true
    };
  }

  return {
    accountId: account.id ?? accountId,
    address: "",
    isConfigured: false,
    isChatmail: true
  };
}

function toEnteredLoginParam(input: CreateChatmailAccountInput): EnteredLoginParam {
  const param: EnteredLoginParam = {
    addr: input.address as string,
    password: input.password as string
  };

  if (input.imapServer) {
    param.imapServer = input.imapServer;
  }

  if (input.smtpServer) {
    param.smtpServer = input.smtpServer;
  }

  return param;
}

function extractPublicIdentityFromVcard(vcard: string): VcardPublicIdentity {
  const folded = vcard.replace(/\r?\n[ \t]/g, "");
  const lines = folded.split(/\r?\n/);
  const keyLine = lines.find((line) => line.startsWith("KEY") || line.startsWith("X-DC-KEY"));
  const emailLine = lines.find((line) => line.startsWith("EMAIL"));

  return {
    address: valueAfterColon(emailLine),
    publicKey: normalizePublicKey(valueAfterColon(keyLine))
  };
}

function valueAfterColon(line: string | undefined): string | undefined {
  if (!line) {
    return undefined;
  }

  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return undefined;
  }

  const value = line.slice(separatorIndex + 1).trim();
  return value || undefined;
}

function makePeerVcard(input: SendChatmailMessageInput): string {
  const address = escapeVcardValue(input.peerAddress);
  const displayName = escapeVcardValue(input.peerDisplayName ?? input.peerAddress);
  const publicKey = normalizePublicKey(input.peerPublicKey) ?? "";

  return [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `EMAIL:${address}`,
    `FN:${displayName}`,
    `KEY:data:application/pgp-keys;base64\\,${publicKey}`,
    "END:VCARD"
  ].join("\r\n");
}

function normalizePublicKey(publicKey: string | undefined): string | undefined {
  const trimmed = publicKey?.trim();
  if (!trimmed) {
    return undefined;
  }

  const prefixes = [
    "data:application/pgp-keys;base64\\,",
    "data:application/pgp-keys;base64,"
  ];
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  return trimmed;
}

function escapeVcardValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

function toChatmailReceivedMessage(
  fallbackMessageId: number,
  event: NonNullable<ChatmailEvent["event"]> | undefined,
  message: ChatmailMessageObject
): ChatmailReceivedMessage {
  const receivedTimestamp = numberValue(message.receivedTimestamp ?? message.received_timestamp);
  const timestamp = numberValue(message.timestamp);

  return {
    messageId: numberValue(message.id) ?? fallbackMessageId,
    chatId: numberValue(message.chatId ?? message.chat_id ?? event?.chatId ?? event?.chat_id) ?? 0,
    fromAddress: message.sender?.address ?? message.sender?.addr,
    text: message.text,
    receivedAt: unixTimestampToIso(receivedTimestamp || timestamp)
  };
}

function toDiagnosticEvent(event: ChatmailEvent): ChatmailReceiveDiagnosticEvent {
  const eventBody = event.event;

  return {
    contextId: numberValue(event.contextId ?? event.context_id),
    kind: eventBody?.kind,
    chatId: numberValue(eventBody?.chatId ?? eventBody?.chat_id),
    msgId: numberValue(eventBody?.msgId ?? eventBody?.msg_id)
  };
}

function isMessageEvent(kind: string | undefined): boolean {
  return kind === "IncomingMsg" || kind === "MsgsChanged";
}

function isJsonRpcTimeout(error: unknown): boolean {
  return error instanceof Error && /JSON-RPC request .* timed out/.test(error.message);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unixTimestampToIso(timestamp: number | undefined): string | undefined {
  if (!timestamp || timestamp <= 0) {
    return undefined;
  }

  return new Date(timestamp * 1000).toISOString();
}
