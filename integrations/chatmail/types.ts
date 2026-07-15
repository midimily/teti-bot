export interface ChatmailIdentity {
  accountId: number;
  address: string;
  displayName?: string;
  isConfigured: boolean;
  isChatmail: boolean;
  publicKey?: string;
  fingerprint?: string;
}

export interface ChatmailPublicIdentity {
  address: string;
  publicKey?: string;
  fingerprint?: string;
}

export interface CreateChatmailAccountInput {
  address?: string;
  password?: string;
  displayName?: string;
  qr?: string;
  imapServer?: string;
  smtpServer?: string;
}

export interface LoadChatmailAccountInput {
  accountId: number;
}

export interface SendChatmailMessageInput {
  accountId: number;
  peerAddress: string;
  peerPublicKey?: string;
  peerDisplayName?: string;
  text: string;
}

export interface ReceiveChatmailMessagesInput {
  accountId: number;
  limit?: number;
  onDiagnostic?: (diagnostic: ChatmailReceiveDiagnostic) => void;
}

export interface DeleteChatmailAccountInput {
  accountId: number;
}

export interface ChatmailSentMessage {
  messageId: number;
  chatId?: number;
}

export interface ChatmailReceivedMessage {
  messageId: number;
  chatId: number;
  fromAddress?: string;
  text?: string;
  receivedAt?: string;
}

export interface ChatmailReceiveDiagnosticEvent {
  contextId?: number;
  kind?: string;
  chatId?: number;
  msgId?: number;
}

export type ChatmailReceiveDiagnostic =
  | {
      type: "eventBatch";
      accountId: number;
      events: ChatmailReceiveDiagnosticEvent[];
    }
  | {
      type: "eventBatchError";
      accountId: number;
      error: string;
    }
  | {
      type: "nextMessages";
      accountId: number;
      messageIds: number[];
    }
  | {
      type: "messageFetched";
      accountId: number;
      messageId: number;
      chatId?: number;
      fromAddress?: string;
      hasText: boolean;
    };

export interface ChatmailMessageStatus {
  messageId: number;
  chatId?: number;
  state?: number;
  showPadlock?: boolean;
  error?: string | null;
}

export interface ChatmailContactLookupInput {
  accountId: number;
  address: string;
}

export interface ChatmailContactCreateInput {
  accountId: number;
  address: string;
  displayName?: string;
}

export interface ChatmailChatCreateInput {
  accountId: number;
  contactId: number;
}

export interface ChatmailVcardImportInput {
  accountId: number;
  vcard: string;
}

export interface ChatmailAdapter {
  createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity>;
  loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity>;
  getIdentity(input: LoadChatmailAccountInput): Promise<ChatmailIdentity>;
  getPublicIdentity(input: LoadChatmailAccountInput): Promise<ChatmailPublicIdentity>;
  sendMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage>;
  receiveMessages(input: ReceiveChatmailMessagesInput): Promise<ChatmailReceivedMessage[]>;
  deleteAccount(input: DeleteChatmailAccountInput): Promise<void>;
}

export interface ChatmailRpcClient {
  addAccount(): Promise<number>;
  getAccountInfo(accountId: number): Promise<ChatmailIdentity>;
  setConfig(accountId: number, key: string, value: string | null): Promise<void>;
  configureAccount(accountId: number, input: CreateChatmailAccountInput): Promise<void>;
  startIo(accountId: number): Promise<void>;
  stopIo(accountId: number): Promise<void>;
  getPublicIdentity(accountId: number): Promise<ChatmailPublicIdentity>;
  lookupContactIdByAddr(input: ChatmailContactLookupInput): Promise<number | null>;
  createContact(input: ChatmailContactCreateInput): Promise<number>;
  importVcardContents(input: ChatmailVcardImportInput): Promise<number[]>;
  createChatByContactId(input: ChatmailChatCreateInput): Promise<number>;
  sendTextMessage(input: SendChatmailMessageInput): Promise<ChatmailSentMessage>;
  receiveMessages(input: ReceiveChatmailMessagesInput): Promise<ChatmailReceivedMessage[]>;
  getNextMessageIds(accountId: number): Promise<number[]>;
  getMessageStatus(accountId: number, messageId: number): Promise<ChatmailMessageStatus>;
  removeAccount(accountId: number): Promise<void>;
}
