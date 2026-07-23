import assert from "node:assert/strict";
import test from "node:test";
import { RealChatmailAdapter } from "./real-adapter.ts";
import {
  ChatmailProvisioningError,
  DEFAULT_CHATMAIL_ACCOUNT_QR,
  RpcChatmailProvisioner
} from "./provisioner.ts";
import { ChatmailTransportError } from "./stdio-transport.ts";
import {
  ChatmailRpcConfigurationError,
  ChatmailRpcError,
  ChatmailRpcUnavailableError,
  JsonRpcChatmailClient,
  JsonRpcClientTransport,
  UnconfiguredChatmailRpcClient,
  type JsonRpcConnection,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "./rpc-client.ts";
import type {
  ChatmailChatCreateInput,
  ChatmailContactCreateInput,
  ChatmailContactLookupInput,
  ChatmailIdentity,
  ChatmailPublicIdentity,
  ChatmailReceivedMessage,
  ChatmailRpcClient,
  ChatmailMessageStatus,
  ChatmailSentMessage,
  ChatmailVcardImportInput,
  CreateChatmailAccountInput,
  ReceiveChatmailMessagesInput,
  SendChatmailMessageInput
} from "./types.ts";

test("real adapter reports RPC unavailable when no deltachat-rpc-server transport is configured", async () => {
  const adapter = new RealChatmailAdapter(new UnconfiguredChatmailRpcClient());

  await assert.rejects(
    () => adapter.loadAccount({ accountId: 1 }),
    (error) => error instanceof ChatmailRpcUnavailableError
  );
});

test("real adapter maps account info and public identity without exposing private material", async () => {
  const rpc = new RecordingChatmailRpcClient();
  const adapter = new RealChatmailAdapter(rpc);

  const identity = await adapter.createAccount({
    address: "teti_real@mail.seep.im",
    password: "do-not-return"
  });

  assert.equal(identity.accountId, 7);
  assert.equal(identity.address, "teti_real@mail.seep.im");
  assert.equal(identity.publicKey, "public-key");
  assert.equal(identity.fingerprint, "fingerprint");
  assert.equal("password" in identity, false);
  assert.deepEqual(rpc.calls, [
    "addAccount",
    "configureAccount",
    "startIo",
    "getAccountInfo",
    "getPublicIdentity"
  ]);
});

test("real adapter waits until the relay accepts an outgoing message", async () => {
  const rpc = new RecordingChatmailRpcClient();
  rpc.messageStatuses.push(
    { messageId: 17, state: 20, showPadlock: true, error: null },
    { messageId: 17, state: 26, showPadlock: true, error: null }
  );
  const adapter = new RealChatmailAdapter(rpc, {
    deliveryTimeoutMs: 100,
    deliveryPollIntervalMs: 0,
    delay: async () => undefined
  });

  const status = await adapter.waitForDelivery({ accountId: 7, messageId: 17 });

  assert.equal(status.state, 26);
  assert.deepEqual(rpc.messageStatusCalls, [
    { accountId: 7, messageId: 17 },
    { accountId: 7, messageId: 17 }
  ]);
});

test("real adapter rejects a failed outgoing message instead of reporting it as sent", async () => {
  const rpc = new RecordingChatmailRpcClient();
  rpc.messageStatuses.push({ messageId: 18, state: 24, error: "relay rejected message" });
  const adapter = new RealChatmailAdapter(rpc);

  await assert.rejects(
    () => adapter.waitForDelivery({ accountId: 7, messageId: 18 }),
    /relay rejected message/
  );
});

test("JSON-RPC transport maps JSON-RPC errors to ChatmailRpcError", async () => {
  const connection = new StaticJsonRpcConnection({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32601,
      message: "Method not found"
    }
  });
  const transport = new JsonRpcClientTransport(connection);

  await assert.rejects(
    () => transport.request("missing_method"),
    (error) => {
      assert.equal(error instanceof ChatmailRpcError, true);
      assert.equal((error as ChatmailRpcError).method, "missing_method");
      assert.equal((error as ChatmailRpcError).code, -32601);
      return true;
    }
  );
});

test("JSON-RPC client exports public identity from account info and vCard fallback", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_account_info: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        kind: "Configured",
        id: 12,
        addr: "teti_vcard@mail.seep.im",
        displayName: "Teti"
      }
    },
    make_vcard: {
      jsonrpc: "2.0",
      id: 2,
      result:
        "BEGIN:VCARD\nEMAIL:teti_vcard@mail.seep.im\nKEY:data:application/pgp-keys;base64\\,public-key-from-vcard\nEND:VCARD"
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const publicIdentity = await client.getPublicIdentity(12);

  assert.deepEqual(publicIdentity, {
    address: "teti_vcard@mail.seep.im",
    publicKey: "public-key-from-vcard",
    fingerprint: undefined
  });
  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "get_account_info",
      params: [12]
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "make_vcard",
      params: [12, [1]]
    }
  ]);
});

test("JSON-RPC client uses OpenRPC method names and positional params for account lifecycle", async () => {
  const connection = new RoutingJsonRpcConnection({
    add_account: {
      jsonrpc: "2.0",
      id: 1,
      result: 42
    },
    add_or_update_transport: {
      jsonrpc: "2.0",
      id: 2,
      result: null
    },
    start_io: {
      jsonrpc: "2.0",
      id: 3,
      result: null
    },
    get_account_info: {
      jsonrpc: "2.0",
      id: 4,
      result: {
        kind: "Configured",
        id: 42,
        addr: "abcdefghi@mail.seep.im",
        displayName: "Teti"
      }
    },
    make_vcard: {
      jsonrpc: "2.0",
      id: 5,
      result: "BEGIN:VCARD\nEMAIL:abcdefghi@mail.seep.im\nKEY:public-key\nEND:VCARD"
    },
    stop_io: {
      jsonrpc: "2.0",
      id: 6,
      result: null
    },
    remove_account: {
      jsonrpc: "2.0",
      id: 7,
      result: null
    }
  });
  const adapter = new RealChatmailAdapter(
    new JsonRpcChatmailClient(new JsonRpcClientTransport(connection))
  );

  const identity = await adapter.createAccount({
    address: "abcdefghi@mail.seep.im",
    password: "secret-password"
  });
  await adapter.deleteAccount({ accountId: identity.accountId });

  assert.deepEqual(identity, {
    accountId: 42,
    address: "abcdefghi@mail.seep.im",
    displayName: "Teti",
    isConfigured: true,
    isChatmail: true,
    publicKey: "public-key",
    fingerprint: undefined
  });
  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "add_account",
      params: []
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "add_or_update_transport",
      params: [42, { addr: "abcdefghi@mail.seep.im", password: "secret-password" }]
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "start_io",
      params: [42]
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "get_account_info",
      params: [42]
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "get_account_info",
      params: [42]
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "make_vcard",
      params: [42, [1]]
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "stop_io",
      params: [42]
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "remove_account",
      params: [42]
    }
  ]);
});

test("JSON-RPC client maps unconfigured account response", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_account_info: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        kind: "Unconfigured",
        id: 21
      }
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const identity = await client.getAccountInfo(21);

  assert.deepEqual(identity, {
    accountId: 21,
    address: "",
    isConfigured: false,
    isChatmail: true
  });
});

test("JSON-RPC client configures account from QR using positional params", async () => {
  const connection = new RoutingJsonRpcConnection({
    set_config: {
      jsonrpc: "2.0",
      id: 1,
      result: null
    },
    add_transport_from_qr: {
      jsonrpc: "2.0",
      id: 2,
      result: null
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  await client.configureAccount(5, {
    displayName: "Alex",
    qr: "dcaccount:mail.seep.im"
  });

  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "set_config",
      params: [5, "displayname", "Alex"]
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "add_transport_from_qr",
      params: [5, "dcaccount:mail.seep.im"]
    }
  ]);
});

test("JSON-RPC client requires address and password when QR is not provided", async () => {
  const client = new JsonRpcChatmailClient(
    new JsonRpcClientTransport(new RoutingJsonRpcConnection({}))
  );

  await assert.rejects(
    () => client.configureAccount(1, { address: "abcdefghi@mail.seep.im" }),
    (error) => error instanceof ChatmailRpcConfigurationError
  );
});

test("JSON-RPC client sends text by creating a missing contact and chat", async () => {
  const connection = new RoutingJsonRpcConnection({
    lookup_contact_id_by_addr: {
      jsonrpc: "2.0",
      id: 1,
      result: null
    },
    create_contact: {
      jsonrpc: "2.0",
      id: 2,
      result: 31
    },
    create_chat_by_contact_id: {
      jsonrpc: "2.0",
      id: 3,
      result: 41
    },
    misc_send_text_message: {
      jsonrpc: "2.0",
      id: 4,
      result: 51
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const sent = await client.sendTextMessage({
    accountId: 1,
    peerAddress: "peer@mail.seep.im",
    text: "hello"
  });

  assert.deepEqual(sent, {
    messageId: 51,
    chatId: 41
  });
  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "lookup_contact_id_by_addr",
      params: [1, "peer@mail.seep.im"]
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "create_contact",
      params: [1, "peer@mail.seep.im", null]
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "create_chat_by_contact_id",
      params: [1, 31]
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "misc_send_text_message",
      params: [1, 41, "hello"]
    }
  ]);
});

test("JSON-RPC client sends encrypted-capable text by importing peer vCard first", async () => {
  const connection = new RoutingJsonRpcConnection({
    import_vcard_contents: {
      jsonrpc: "2.0",
      id: 1,
      result: [33]
    },
    create_chat_by_contact_id: {
      jsonrpc: "2.0",
      id: 2,
      result: 43
    },
    misc_send_text_message: {
      jsonrpc: "2.0",
      id: 3,
      result: 53
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const sent = await client.sendTextMessage({
    accountId: 4,
    peerAddress: "secure@mail.seep.im",
    peerPublicKey: "data:application/pgp-keys;base64\\,peer-public-key",
    text: "secure hello"
  });

  assert.deepEqual(sent, {
    messageId: 53,
    chatId: 43
  });
  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "import_vcard_contents",
      params: [
        4,
        [
          "BEGIN:VCARD",
          "VERSION:4.0",
          "EMAIL:secure@mail.seep.im",
          "FN:secure@mail.seep.im",
          "KEY:data:application/pgp-keys;base64\\,peer-public-key",
          "END:VCARD"
        ].join("\r\n")
      ]
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "create_chat_by_contact_id",
      params: [4, 33]
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "misc_send_text_message",
      params: [4, 43, "secure hello"]
    }
  ]);
});

test("JSON-RPC client sends text using existing contact when present", async () => {
  const connection = new RoutingJsonRpcConnection({
    lookup_contact_id_by_addr: {
      jsonrpc: "2.0",
      id: 1,
      result: 32
    },
    create_chat_by_contact_id: {
      jsonrpc: "2.0",
      id: 2,
      result: 42
    },
    misc_send_text_message: {
      jsonrpc: "2.0",
      id: 3,
      result: 52
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  await client.sendTextMessage({
    accountId: 2,
    peerAddress: "known@mail.seep.im",
    text: "known"
  });

  assert.deepEqual(connection.requests.map((request) => request.method), [
    "lookup_contact_id_by_addr",
    "create_chat_by_contact_id",
    "misc_send_text_message"
  ]);
});

test("JSON-RPC client receives IncomingMsg events and loads messages", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_next_event_batch: {
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          contextId: 3,
          event: {
            kind: "Info",
            msg: "ignored"
          }
        },
        {
          contextId: 3,
          event: {
            kind: "IncomingMsg",
            chatId: 8,
            msgId: 9
          }
        }
      ]
    },
    get_message: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        id: 9,
        chatId: 8,
        text: "hello from event",
        timestamp: 1783771200,
        sender: {
          address: "peer@mail.seep.im"
        }
      }
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const messages = await client.receiveMessages({
    accountId: 3
  });

  assert.deepEqual(messages, [
    {
      messageId: 9,
      chatId: 8,
      fromAddress: "peer@mail.seep.im",
      text: "hello from event",
      receivedAt: "2026-07-11T12:00:00.000Z"
    }
  ]);
  assert.deepEqual(connection.requests, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "get_next_event_batch",
      params: []
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "get_message",
      params: [3, 9]
    }
  ]);
});

test("JSON-RPC client receives MsgsChanged events like Delta Chat Desktop fallback", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_next_event_batch: {
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          contextId: 5,
          event: {
            kind: "MsgsChanged",
            chatId: 12,
            msgId: 13
          }
        }
      ]
    },
    get_message: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        id: 13,
        chatId: 12,
        text: "{\"teti\":true}",
        timestamp: 1783771200,
        sender: {
          address: "peer@mail.seep.im"
        }
      }
    }
  });
  const diagnostics: unknown[] = [];
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const messages = await client.receiveMessages({
    accountId: 5,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, 13);
  assert.deepEqual(connection.requests.map((request) => request.method), [
    "get_next_event_batch",
    "get_message"
  ]);
  assert.deepEqual(diagnostics, [
    {
      type: "eventBatch",
      accountId: 5,
      events: [
        {
          contextId: 5,
          kind: "MsgsChanged",
          chatId: 12,
          msgId: 13
        }
      ]
    },
    {
      type: "messageFetched",
      accountId: 5,
      messageId: 13,
      chatId: 12,
      fromAddress: "peer@mail.seep.im",
      hasText: true
    }
  ]);
});

test("JSON-RPC client ignores outgoing messages reported through MsgsChanged", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_next_event_batch: {
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          contextId: 5,
          event: {
            kind: "MsgsChanged",
            chatId: 12,
            msgId: 14
          }
        }
      ]
    },
    get_message: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        id: 14,
        chatId: 12,
        text: "{\"teti\":true}",
        timestamp: 1783771200,
        state: 26,
        sender: {
          address: "local@mail.seep.im"
        }
      }
    },
    get_next_msgs: {
      jsonrpc: "2.0",
      id: 3,
      result: []
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const messages = await client.receiveMessages({ accountId: 5 });

  assert.deepEqual(messages, []);
  assert.deepEqual(connection.requests.map((request) => request.method), [
    "get_next_event_batch",
    "get_message",
    "get_next_msgs"
  ]);
});

test("JSON-RPC client falls back to get_next_msgs when event batch has no message event", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_next_event_batch: {
      jsonrpc: "2.0",
      id: 1,
      result: [
        {
          contextId: 6,
          event: {
            kind: "ImapInboxIdle"
          }
        }
      ]
    },
    get_next_msgs: {
      jsonrpc: "2.0",
      id: 2,
      result: [21]
    },
    get_message: {
      jsonrpc: "2.0",
      id: 3,
      result: {
        id: 21,
        chatId: 22,
        text: "{\"teti\":true}",
        timestamp: 1783771200,
        sender: {
          address: "peer@mail.seep.im"
        }
      }
    }
  });
  const diagnostics: unknown[] = [];
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const messages = await client.receiveMessages({
    accountId: 6,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(connection.requests.map((request) => request.method), [
    "get_next_event_batch",
    "get_next_msgs",
    "get_message"
  ]);
  assert.deepEqual(diagnostics[1], {
    type: "nextMessages",
    accountId: 6,
    messageIds: [21]
  });
});

test("JSON-RPC client drains offline backlog before waiting for live events", async () => {
  const connection = new RoutingJsonRpcConnection({
    get_next_msgs: {
      jsonrpc: "2.0",
      id: 1,
      result: [31]
    },
    get_message: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        id: 31,
        chatId: 32,
        text: "{\"teti\":true}",
        timestamp: 1783771200,
        sender: {
          address: "offline-peer@mail.seep.im"
        }
      }
    }
  });
  const client = new JsonRpcChatmailClient(new JsonRpcClientTransport(connection));

  const messages = await client.receiveMessages({
    accountId: 8,
    backlogFirst: true
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, 31);
  assert.deepEqual(connection.requests.map((request) => request.method), [
    "get_next_msgs",
    "get_message"
  ]);
});

test("chatmail provisioner creates identity from display name without exposing password", async () => {
  const rpc = new RecordingChatmailRpcClient();
  const provisioner = new RpcChatmailProvisioner(rpc);

  const identity = await provisioner.createIdentity("Alex");

  assert.deepEqual(identity, {
    accountId: 7,
    address: "teti_real@mail.seep.im",
    displayName: "Alex",
    publicKey: "public-key",
    fingerprint: "fingerprint"
  });
  assert.equal("password" in identity, false);
  assert.deepEqual(rpc.calls, [
    "addAccount",
    "configureAccount",
    "startIo",
    "getAccountInfo",
    "getPublicIdentity"
  ]);
  assert.deepEqual(rpc.configureInputs, [
    {
      accountId: 7,
      input: {
        displayName: "Alex",
        qr: DEFAULT_CHATMAIL_ACCOUNT_QR
      }
    }
  ]);
});

test("chatmail provisioner reports the relay configuration stage when it times out", async () => {
  const rpc = new (class extends RecordingChatmailRpcClient {
    override async configureAccount(
      accountId: number,
      input: CreateChatmailAccountInput
    ): Promise<void> {
      this.calls.push("configureAccount");
      this.configureInputs.push({ accountId, input });
      await new Promise<void>(() => undefined);
    }
  })();
  const provisioner = new RpcChatmailProvisioner(rpc, {
    timeouts: {
      relayConfigMs: 5
    }
  });

  await assert.rejects(
    () => provisioner.createIdentity("Alex"),
    (error) => {
      assert.equal(error instanceof ChatmailProvisioningError, true);
      assert.equal((error as ChatmailProvisioningError).code, "CM_CFG_TIMEOUT");
      assert.equal((error as ChatmailProvisioningError).stage, "relay_config");
      return true;
    }
  );
  assert.deepEqual(rpc.calls, [
    "addAccount",
    "configureAccount",
    "removeAccount"
  ]);
});

test("chatmail provisioner preserves an accounts.lock transport diagnosis", async () => {
  const rpc = new (class extends RecordingChatmailRpcClient {
    override async addAccount(): Promise<number> {
      throw new ChatmailTransportError(
        "CM_RPC_LOCKED",
        "Chatmail account storage is already owned by another local process."
      );
    }
  })();
  const provisioner = new RpcChatmailProvisioner(rpc);

  await assert.rejects(
    () => provisioner.createIdentity("Alex"),
    (error) => {
      assert.equal(error instanceof ChatmailProvisioningError, true);
      assert.equal((error as ChatmailProvisioningError).code, "CM_RPC_LOCKED");
      assert.equal((error as ChatmailProvisioningError).stage, "rpc_account");
      return true;
    }
  );
});

class RecordingChatmailRpcClient implements ChatmailRpcClient {
  readonly calls: string[] = [];
  readonly messageStatuses: ChatmailMessageStatus[] = [];
  readonly messageStatusCalls: Array<{ accountId: number; messageId: number }> = [];
  readonly configureInputs: Array<{
    accountId: number;
    input: CreateChatmailAccountInput;
  }> = [];

  async addAccount(): Promise<number> {
    this.calls.push("addAccount");
    return 7;
  }

  async getAccountInfo(accountId: number): Promise<ChatmailIdentity> {
    this.calls.push("getAccountInfo");
    return {
      accountId,
      address: "teti_real@mail.seep.im",
      displayName: "Teti Real",
      isConfigured: true,
      isChatmail: true
    };
  }

  async setConfig(
    _accountId: number,
    _key: string,
    _value: string | null
  ): Promise<void> {
    this.calls.push("setConfig");
  }

  async configureAccount(
    accountId: number,
    input: CreateChatmailAccountInput
  ): Promise<void> {
    this.calls.push("configureAccount");
    this.configureInputs.push({ accountId, input });
  }

  async startIo(_accountId: number): Promise<void> {
    this.calls.push("startIo");
  }

  async stopIo(_accountId: number): Promise<void> {
    this.calls.push("stopIo");
  }

  async getPublicIdentity(_accountId: number): Promise<ChatmailPublicIdentity> {
    this.calls.push("getPublicIdentity");
    return {
      address: "teti_real@mail.seep.im",
      publicKey: "public-key",
      fingerprint: "fingerprint"
    };
  }

  async lookupContactIdByAddr(_input: ChatmailContactLookupInput): Promise<number | null> {
    return null;
  }

  async createContact(_input: ChatmailContactCreateInput): Promise<number> {
    return 2;
  }

  async importVcardContents(_input: ChatmailVcardImportInput): Promise<number[]> {
    return [2];
  }

  async createChatByContactId(_input: ChatmailChatCreateInput): Promise<number> {
    return 3;
  }

  async sendTextMessage(_input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    return { messageId: 1 };
  }

  async receiveMessages(
    _input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    return [];
  }

  async getNextMessageIds(_accountId: number): Promise<number[]> {
    return [];
  }

  async getMessageStatus(accountId: number, messageId: number): Promise<ChatmailMessageStatus> {
    this.messageStatusCalls.push({ accountId, messageId });
    return this.messageStatuses.shift() ?? {
      messageId,
      state: 26,
      showPadlock: true,
      error: null
    };
  }

  async removeAccount(_accountId: number): Promise<void> {
    this.calls.push("removeAccount");
  }
}

class StaticJsonRpcConnection implements JsonRpcConnection {
  private readonly response: JsonRpcResponse;

  constructor(response: JsonRpcResponse) {
    this.response = response;
  }

  async send(_payload: JsonRpcRequest): Promise<JsonRpcResponse> {
    return this.response;
  }
}

class RoutingJsonRpcConnection implements JsonRpcConnection {
  readonly requests: JsonRpcRequest[] = [];
  private readonly responses: Record<string, JsonRpcResponse>;

  constructor(responses: Record<string, JsonRpcResponse>) {
    this.responses = responses;
  }

  async send(payload: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.requests.push(payload);
    const response = this.responses[payload.method];
    if (!response) {
      return {
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32601,
          message: "Method not found"
        }
      };
    }

    return {
      ...response,
      id: payload.id
    };
  }
}
