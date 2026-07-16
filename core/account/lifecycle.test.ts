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
import type {
  DiscoveryClient,
  DiscoveryIdentity
} from "../../services/discovery/registry-client.ts";
import {
  TetiAccountManager,
  toDiscoveryRegistrationPayload
} from "./manager.ts";
import { MemoryTetiAccountStorage } from "./storage.ts";
import type {
  DiscoveryHeartbeatPayload,
  DiscoveryRegistrationPayload
} from "./model.ts";

test("create account calls chatmail adapter, saves local state, and registers discovery identity", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailAdapter = new RecordingChatmailAdapter();
  const discoveryClient = new RecordingDiscoveryClient();
  const manager = new TetiAccountManager({ storage, chatmailAdapter, discoveryClient });

  const account = await manager.createTetiAccount({
    address: "teti_test@mail.seep.im",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Claude Code", "Cursor"]
    }
  });

  assert.equal(chatmailAdapter.createCalls.length, 1);
  assert.equal(account.id, "teti_test");
  assert.equal(account.address, "teti_test@mail.seep.im");
  assert.equal(account.chatmailAccountId, 1);
  assert.equal(account.publicKey, "mock-public-key");
  assert.deepEqual(await storage.load(), account);
  assert.equal(discoveryClient.registerCalls.length, 1);
  assert.deepEqual(discoveryClient.registerCalls[0], toDiscoveryRegistrationPayload(account));
});

test("create account can auto provision chatmail identity from display name", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailProvisioner = new RecordingChatmailProvisioner();
  const discoveryClient = new RecordingDiscoveryClient();
  const manager = new TetiAccountManager({ storage, chatmailProvisioner, discoveryClient });

  const account = await manager.createTetiAccount({
    name: "Alex",
    publicProfile: {
      category: ["developer"]
    }
  });

  assert.deepEqual(chatmailProvisioner.createCalls, ["Alex"]);
  assert.equal(account.address, "abcdefghi@mail.seep.im");
  assert.equal(account.id, "teti_abcdefghi");
  assert.equal(account.displayName, "Alex");
  assert.equal(account.chatmailAccountId, 41);
  assert.equal(account.publicKey, "provisioned-public-key");
  assert.deepEqual(await storage.load(), account);
  assert.equal(discoveryClient.registerCalls.length, 1);
  assert.equal(discoveryClient.registerCalls[0].id, "teti_abcdefghi");
  assert.equal(discoveryClient.registerCalls[0].displayName, "Alex");
});

test("account creation reports relay, persistence, and registry transaction stages in order", async () => {
  const stages: string[] = [];
  const manager = new TetiAccountManager({
    storage: new MemoryTetiAccountStorage(),
    chatmailProvisioner: new RecordingChatmailProvisioner(),
    discoveryClient: new RecordingDiscoveryClient(),
    onCreationStage: async (stage) => stages.push(stage)
  });

  await manager.createTetiAccount({ name: "Milo" });

  assert.deepEqual(stages, [
    "identity_created",
    "persisting",
    "persisted",
    "registering_discovery",
    "complete"
  ]);
});

test("registry failure retains the relay identity locally for idempotent recovery", async () => {
  const storage = new MemoryTetiAccountStorage();
  const stages: string[] = [];
  const manager = new TetiAccountManager({
    storage,
    chatmailProvisioner: new RecordingChatmailProvisioner(),
    discoveryClient: new FailingDiscoveryClient(),
    onCreationStage: async (stage) => stages.push(stage)
  });

  await assert.rejects(() => manager.createTetiAccount({ name: "Milo" }), /registry unavailable/);

  assert.equal((await storage.load())?.address, "abcdefghi@mail.seep.im");
  assert.equal(stages.at(-1), "registering_discovery");
});

test("wrong relay address blocks persistence and discovery registration", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailProvisioner = new RecordingChatmailProvisioner("abcdefghi@example.org");
  const discoveryClient = new RecordingDiscoveryClient();
  const manager = new TetiAccountManager({
    storage,
    chatmailProvisioner,
    discoveryClient,
    expectedAddressSuffix: "@mail.seep.im"
  });

  await assert.rejects(
    () => manager.createTetiAccount({ name: "Alex" }),
    /must end in @mail\.seep\.im/
  );

  assert.equal(await storage.load(), null);
  assert.equal(discoveryClient.registerCalls.length, 0);
});

test("restart simulation loads existing account without network or chatmail calls", async () => {
  const storage = new MemoryTetiAccountStorage();
  const firstChatmailAdapter = new RecordingChatmailAdapter();
  const firstDiscoveryClient = new RecordingDiscoveryClient();
  const firstManager = new TetiAccountManager({
    storage,
    chatmailAdapter: firstChatmailAdapter,
    discoveryClient: firstDiscoveryClient
  });

  const created = await firstManager.createTetiAccount({
    address: "teti_restart@mail.seep.im"
  });

  const restartChatmailAdapter = new RecordingChatmailAdapter();
  const restartDiscoveryClient = new RecordingDiscoveryClient();
  const restartManager = new TetiAccountManager({
    storage,
    chatmailAdapter: restartChatmailAdapter,
    discoveryClient: restartDiscoveryClient
  });

  const loaded = await restartManager.loadTetiAccount();

  assert.deepEqual(loaded, created);
  assert.equal(restartChatmailAdapter.createCalls.length, 0);
  assert.equal(restartDiscoveryClient.registerCalls.length, 0);
});

test("status reports registry sync pending when a legacy identity is missing its display name", async () => {
  const storage = new MemoryTetiAccountStorage();
  await storage.save({
    version: 1,
    id: "teti_abcdefghi",
    address: "abcdefghi@mail.seep.im",
    displayName: "Milo",
    chatmailAccountId: 41,
    publicKey: "provisioned-public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Codex"]
    },
    createdAt: "2026-07-16T00:00:00.000Z"
  });

  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter: new RecordingChatmailAdapter(),
    discoveryClient: new LegacyDiscoveryClient()
  });

  assert.equal((await manager.getTetiStatus()).registered, false);
});

test("delete account removes discovery identity, deletes chatmail account, and removes local state", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailAdapter = new RecordingChatmailAdapter();
  const discoveryClient = new RecordingDiscoveryClient();
  const manager = new TetiAccountManager({ storage, chatmailAdapter, discoveryClient });

  const account = await manager.createTetiAccount({
    address: "teti_delete@mail.seep.im"
  });

  await manager.deleteTetiAccount();

  assert.equal(discoveryClient.deleteCalls.length, 1);
  assert.equal(discoveryClient.deleteCalls[0], "teti_delete");
  assert.equal(chatmailAdapter.deleteCalls.length, 1);
  assert.deepEqual(chatmailAdapter.deleteCalls[0], {
    accountId: account.chatmailAccountId
  });
  assert.equal(await storage.load(), null);
});

test("refresh environment updates local profile and registry heartbeat payload", async () => {
  const storage = new MemoryTetiAccountStorage();
  const chatmailAdapter = new RecordingChatmailAdapter();
  const discoveryClient = new RecordingDiscoveryClient();
  const manager = new TetiAccountManager({
    storage,
    chatmailAdapter,
    discoveryClient,
    environmentScanner: async () => ({
      platform: "macOS",
      aiTools: [{ id: "codex", name: "Codex", source: "mock" }],
      timestamp: "2026-07-11T00:00:00.000Z"
    })
  });

  await manager.createTetiAccount({
    address: "teti_env@mail.seep.im"
  });

  const refreshed = await manager.refreshTetiEnvironment();

  assert.deepEqual(refreshed.publicProfile.aiEnvironment, ["Codex"]);
  assert.equal(refreshed.publicProfile.platform, "macOS");
  assert.equal(refreshed.publicProfile.lastSeen, "2026-07-11T00:00:00.000Z");
  assert.equal(discoveryClient.heartbeatCalls.length, 1);
  assert.deepEqual(discoveryClient.heartbeatCalls[0], {
    id: "teti_env",
    publicProfile: refreshed.publicProfile
  });
});

class RecordingChatmailAdapter implements ChatmailAdapter {
  readonly createCalls: CreateChatmailAccountInput[] = [];
  readonly deleteCalls: DeleteChatmailAccountInput[] = [];
  private nextAccountId = 1;

  async createAccount(input: CreateChatmailAccountInput): Promise<ChatmailIdentity> {
    this.createCalls.push(input);
    return {
      accountId: this.nextAccountId++,
      address: input.address ?? "teti_test@mail.seep.im",
      isConfigured: true,
      isChatmail: true,
      publicKey: "mock-public-key",
      fingerprint: "mock-fingerprint"
    };
  }

  async loadAccount(input: LoadChatmailAccountInput): Promise<ChatmailIdentity> {
    return {
      accountId: input.accountId,
      address: "teti_test@mail.seep.im",
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
  readonly createCalls: string[] = [];
  private readonly address: string;

  constructor(address = "abcdefghi@mail.seep.im") {
    this.address = address;
  }

  async createIdentity(displayName: string): Promise<ChatmailProvisionedIdentity> {
    this.createCalls.push(displayName);
    return {
      accountId: 41,
      address: this.address,
      displayName,
      publicKey: "provisioned-public-key",
      fingerprint: "provisioned-fingerprint"
    };
  }
}

class RecordingDiscoveryClient implements DiscoveryClient {
  readonly registerCalls: DiscoveryRegistrationPayload[] = [];
  readonly heartbeatCalls: DiscoveryHeartbeatPayload[] = [];
  readonly deleteCalls: string[] = [];
  private readonly identities = new Map<string, DiscoveryIdentity>();

  async registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity> {
    this.registerCalls.push(payload);
    const identity: DiscoveryIdentity = {
      version: 1,
      id: payload.id,
      address: payload.address,
      displayName: payload.displayName,
      publicKey: payload.publicKey,
      publicProfile: payload.publicProfile
    };
    this.identities.set(payload.id, identity);
    return identity;
  }

  async heartbeatIdentity(payload: DiscoveryHeartbeatPayload): Promise<DiscoveryIdentity> {
    this.heartbeatCalls.push(payload);
    const existing = this.identities.get(payload.id);
    if (!existing) {
      throw new Error("Identity not found.");
    }

    const identity: DiscoveryIdentity = {
      ...existing,
      publicProfile: payload.publicProfile ?? existing.publicProfile,
      lastSeen: payload.publicProfile?.lastSeen,
      updatedAt: new Date().toISOString()
    };
    this.identities.set(payload.id, identity);
    return identity;
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return this.identities.get(id) ?? null;
  }

  async discover(): Promise<DiscoveryIdentity[]> {
    return [...this.identities.values()];
  }

  async deleteIdentity(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.identities.delete(id);
  }
}

class FailingDiscoveryClient extends RecordingDiscoveryClient {
  override async registerIdentity(payload: DiscoveryRegistrationPayload): Promise<DiscoveryIdentity> {
    this.registerCalls.push(payload);
    throw new Error("registry unavailable");
  }
}

class LegacyDiscoveryClient extends RecordingDiscoveryClient {
  override async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return {
      version: 1,
      id,
      address: "abcdefghi@mail.seep.im",
      publicKey: "provisioned-public-key",
      publicProfile: {
        platform: "macOS",
        category: ["developer"],
        aiEnvironment: ["Codex"]
      }
    };
  }
}
