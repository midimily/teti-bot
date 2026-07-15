import { JsonRpcChatmailClient, JsonRpcClientTransport } from "./rpc-client.ts";
import {
  resolveChatmailRuntimeConfig,
  type ChatmailRuntimeConfigInput
} from "./runtime-config.ts";
import {
  StdioJsonRpcTransport,
  type StdioTransportOptions
} from "./stdio-transport.ts";
import type { ChatmailRpcClient } from "./types.ts";

export interface RuntimeChatmailClientOptions {
  runtime?: ChatmailRuntimeConfigInput;
  transport?: StdioTransportOptions;
}

export interface RuntimeChatmailRpcClient extends ChatmailRpcClient {
  close(): Promise<void>;
}

export function createRuntimeChatmailRpcClient(
  options: RuntimeChatmailClientOptions = {}
): RuntimeChatmailRpcClient {
  const runtimeConfig = resolveChatmailRuntimeConfig(options.runtime);
  const stdioTransport = StdioJsonRpcTransport.spawn(runtimeConfig, options.transport);
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(stdioTransport));

  return new ClosableRuntimeChatmailRpcClient(client, stdioTransport);
}

class ClosableRuntimeChatmailRpcClient implements RuntimeChatmailRpcClient {
  private readonly client: ChatmailRpcClient;
  private readonly stdioTransport: StdioJsonRpcTransport;

  constructor(
    client: ChatmailRpcClient,
    stdioTransport: StdioJsonRpcTransport
  ) {
    this.client = client;
    this.stdioTransport = stdioTransport;
  }

  addAccount(): ReturnType<ChatmailRpcClient["addAccount"]> {
    return this.client.addAccount();
  }

  getAccountInfo(
    accountId: Parameters<ChatmailRpcClient["getAccountInfo"]>[0]
  ): ReturnType<ChatmailRpcClient["getAccountInfo"]> {
    return this.client.getAccountInfo(accountId);
  }

  setConfig(
    accountId: Parameters<ChatmailRpcClient["setConfig"]>[0],
    key: Parameters<ChatmailRpcClient["setConfig"]>[1],
    value: Parameters<ChatmailRpcClient["setConfig"]>[2]
  ): ReturnType<ChatmailRpcClient["setConfig"]> {
    return this.client.setConfig(accountId, key, value);
  }

  configureAccount(
    accountId: Parameters<ChatmailRpcClient["configureAccount"]>[0],
    input: Parameters<ChatmailRpcClient["configureAccount"]>[1]
  ): ReturnType<ChatmailRpcClient["configureAccount"]> {
    return this.client.configureAccount(accountId, input);
  }

  startIo(accountId: Parameters<ChatmailRpcClient["startIo"]>[0]): ReturnType<ChatmailRpcClient["startIo"]> {
    return this.client.startIo(accountId);
  }

  stopIo(accountId: Parameters<ChatmailRpcClient["stopIo"]>[0]): ReturnType<ChatmailRpcClient["stopIo"]> {
    return this.client.stopIo(accountId);
  }

  getPublicIdentity(
    accountId: Parameters<ChatmailRpcClient["getPublicIdentity"]>[0]
  ): ReturnType<ChatmailRpcClient["getPublicIdentity"]> {
    return this.client.getPublicIdentity(accountId);
  }

  lookupContactIdByAddr(
    input: Parameters<ChatmailRpcClient["lookupContactIdByAddr"]>[0]
  ): ReturnType<ChatmailRpcClient["lookupContactIdByAddr"]> {
    return this.client.lookupContactIdByAddr(input);
  }

  createContact(
    input: Parameters<ChatmailRpcClient["createContact"]>[0]
  ): ReturnType<ChatmailRpcClient["createContact"]> {
    return this.client.createContact(input);
  }

  importVcardContents(
    input: Parameters<ChatmailRpcClient["importVcardContents"]>[0]
  ): ReturnType<ChatmailRpcClient["importVcardContents"]> {
    return this.client.importVcardContents(input);
  }

  createChatByContactId(
    input: Parameters<ChatmailRpcClient["createChatByContactId"]>[0]
  ): ReturnType<ChatmailRpcClient["createChatByContactId"]> {
    return this.client.createChatByContactId(input);
  }

  sendTextMessage(
    input: Parameters<ChatmailRpcClient["sendTextMessage"]>[0]
  ): ReturnType<ChatmailRpcClient["sendTextMessage"]> {
    return this.client.sendTextMessage(input);
  }

  receiveMessages(
    input: Parameters<ChatmailRpcClient["receiveMessages"]>[0]
  ): ReturnType<ChatmailRpcClient["receiveMessages"]> {
    return this.client.receiveMessages(input);
  }

  getNextMessageIds(
    accountId: Parameters<ChatmailRpcClient["getNextMessageIds"]>[0]
  ): ReturnType<ChatmailRpcClient["getNextMessageIds"]> {
    return this.client.getNextMessageIds(accountId);
  }

  getMessageStatus(
    accountId: Parameters<ChatmailRpcClient["getMessageStatus"]>[0],
    messageId: Parameters<ChatmailRpcClient["getMessageStatus"]>[1]
  ): ReturnType<ChatmailRpcClient["getMessageStatus"]> {
    return this.client.getMessageStatus(accountId, messageId);
  }

  removeAccount(
    accountId: Parameters<ChatmailRpcClient["removeAccount"]>[0]
  ): ReturnType<ChatmailRpcClient["removeAccount"]> {
    return this.client.removeAccount(accountId);
  }

  close(): Promise<void> {
    return this.stdioTransport.close();
  }
}
