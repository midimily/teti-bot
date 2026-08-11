import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatmailAdapter,
  ChatmailIdentity,
  ChatmailReceivedMessage,
  ChatmailSentMessage,
  CreateChatmailAccountInput,
  DeleteChatmailAccountInput,
  LoadChatmailAccountInput,
  ReceiveChatmailMessagesInput,
  SendChatmailMessageInput
} from "../../integrations/chatmail/types.ts";
import type {
  ChatmailProvisionedIdentity,
  ChatmailProvisioner
} from "../../integrations/chatmail/provisioner.ts";
import { TetiAccountManager } from "./manager.ts";
import { MemoryTetiAccountStorage, type TetiAccountStorage } from "./storage.ts";
import type { TetiAccount } from "./model.ts";

test("account creation persists Chatmail identity locally without performing Network I/O", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailAdapter = new RecordingChatmailAdapter();
  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter,
    provisionalTetiIdFactory: () => "teti_local0001"
  });

  const account = await manager.createTetiAccount({
    address: "test00001@mail.seep.im",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Codex"]
    }
  });

  assert.equal(chatmailAdapter.createCalls.length, 1);
  assert.equal(account.id, "teti_local0001");
  assert.equal(account.address, "test00001@mail.seep.im");
  assert.equal(account.networkIdentity?.state, "pending");
  assert.deepEqual(await storage.load(), account);
});

test("account creation provisions Chatmail from the Network-selected relay QR", async () => {
  const provisioner = new RecordingChatmailProvisioner();
  const manager = new TetiAccountManager({
    storage: new MemoryTetiAccountStorage(),
    chatmailProvisioner: provisioner,
    provisionalTetiIdFactory: () => "teti_provis001"
  });

  const account = await manager.createTetiAccount({
    name: "Alex",
    chatmailQr: "dcaccount:mail.seep.im"
  });

  assert.deepEqual(provisioner.provisioningCalls, [{
    displayName: "Alex",
    accountQr: "dcaccount:mail.seep.im"
  }]);
  assert.equal(account.address, "abcdefghi@mail.seep.im");
  assert.equal(account.displayName, "Alex");
});

test("account creation canonicalizes the relay identity before persistence", async () => {
  const storage = new MemoryTetiAccountStorage();
  const manager = new TetiAccountManager({
    storage,
    chatmailProvisioner: new RecordingChatmailProvisioner("AbC123XyZ@MAIL.SEEP.IM"),
    expectedAddressSuffix: "@mail.seep.im",
    provisionalTetiIdFactory: () => "teti_case00001"
  });

  const account = await manager.createTetiAccount({ name: "Alex" });

  assert.equal(account.address, "abc123xyz@mail.seep.im");
  assert.equal((await storage.load())?.address, "abc123xyz@mail.seep.im");
});

test("account creation reports only local transaction stages", async () => {
  const stages: string[] = [];
  const manager = new TetiAccountManager({
    storage: new MemoryTetiAccountStorage(),
    chatmailProvisioner: new RecordingChatmailProvisioner(),
    onCreationStage: async (stage) => stages.push(stage)
  });

  await manager.createTetiAccount({ name: "Milo" });

  assert.deepEqual(stages, ["identity_created", "persisting", "persisted", "complete"]);
});

test("a local persistence failure is explicit and does not claim Network completion", async () => {
  const manager = new TetiAccountManager({
    storage: new FailingAccountStorage(),
    chatmailProvisioner: new RecordingChatmailProvisioner()
  });

  await assert.rejects(
    () => manager.createTetiAccount({ name: "Milo" }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "LOC_SAVE"
  );
});

test("restart loads the persisted account without Chatmail or Network side effects", async () => {
  const storage = new MemoryTetiAccountStorage();
  const firstAdapter = new RecordingChatmailAdapter();
  const created = await new TetiAccountManager({ storage, chatmailAdapter: firstAdapter })
    .createTetiAccount({ address: "restart01@mail.seep.im" });
  const restartAdapter = new RecordingChatmailAdapter();

  const loaded = await new TetiAccountManager({ storage, chatmailAdapter: restartAdapter })
    .loadTetiAccount();

  assert.deepEqual(loaded, created);
  assert.equal(restartAdapter.createCalls.length, 0);
});

test("status is derived from the locally persisted Network binding", async () => {
  const storage = new MemoryTetiAccountStorage();
  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter: new RecordingChatmailAdapter(),
    provisionalTetiIdFactory: () => "teti_status001"
  });
  await manager.createTetiAccount({ address: "status001@mail.seep.im" });

  const status = await manager.getTetiStatus();

  assert.equal(status.exists, true);
  assert.equal(status.networkIdentity.state, "pending");
  assert.equal(status.onlineStatus, "unknown");
});

test("delete removes only the local profile and its Chatmail account", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailAdapter = new RecordingChatmailAdapter();
  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter,
    provisionalTetiIdFactory: () => "teti_delete001"
  });
  const account = await manager.createTetiAccount({ address: "delete001@mail.seep.im" });

  await manager.deleteTetiAccount();

  assert.deepEqual(chatmailAdapter.deleteCalls, [{ accountId: account.chatmailAccountId }]);
  assert.equal(await storage.load(), null);
});

test("environment refresh remains local and never uploads profile or Presence", async () => {
  const storage = new MemoryTetiAccountStorage();
  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter: new RecordingChatmailAdapter(),
    provisionalTetiIdFactory: () => "teti_env000001",
    environmentScanner: async () => ({
      platform: "macOS",
      aiTools: [{ id: "codex", name: "Codex", source: "mock" }],
      timestamp: "2026-07-11T00:00:00.000Z"
    })
  });
  await manager.createTetiAccount({ address: "env000001@mail.seep.im" });

  const refreshed = await manager.refreshTetiEnvironment();

  assert.deepEqual(refreshed.publicProfile.aiEnvironment, ["Codex"]);
  assert.equal(refreshed.publicProfile.lastSeen, "2026-07-11T00:00:00.000Z");
});

class RecordingChatmailAdapter implements ChatmailAdapter {
  readonly createCalls: CreateChatmailAccountInput[] = [];
  readonly deleteCalls: DeleteChatmailAccountInput[] = [];

  async createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    this.createCalls.push(input);
    return {
      accountId: 1,
      address: input.address ?? "test00001@mail.seep.im",
      displayName: input.displayName,
      isConfigured: true,
      isChatmail: true,
      publicKey: "mock-public-key",
      fingerprint: "mock-fingerprint"
    };
  }

  async loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return {
      accountId: input.accountId,
      address: "test00001@mail.seep.im",
      isConfigured: true,
      isChatmail: true
    };
  }

  async getIdentity(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.loadAccount(input);
  }

  async getPublicIdentity(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return this.loadAccount(input);
  }

  async sendMessage(_input: SendChatmailMessageInput): Promise<ChatmailSentMessage> {
    return { messageId: 1 };
  }

  async receiveMessages(
    _input: ReceiveChatmailMessagesInput
  ): Promise<ChatmailReceivedMessage[]> {
    return [];
  }

  async deleteAccount(input: DeleteChatmailAccountInput): Promise<void> {
    this.deleteCalls.push(input);
  }
}

class RecordingChatmailProvisioner implements ChatmailProvisioner {
  readonly provisioningCalls: Array<{ displayName: string; accountQr?: string }> = [];
  private readonly address: string;

  constructor(address = "abcdefghi@mail.seep.im") {
    this.address = address;
  }

  async createIdentity(
    displayName: string,
    options: { accountQr?: string } = {}
  ): Promise<ChatmailProvisionedIdentity> {
    this.provisioningCalls.push({ displayName, ...options });
    return {
      accountId: 41,
      address: this.address,
      displayName,
      publicKey: "provisioned-public-key",
      fingerprint: "provisioned-fingerprint"
    };
  }
}

class FailingAccountStorage implements TetiAccountStorage {
  async exists(): Promise<boolean> { return false; }
  async load(): Promise<TetiAccount | null> { return null; }
  async save(_account: TetiAccount): Promise<void> { throw new Error("disk full"); }
  async remove(): Promise<void> {}
}
