import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryTetiAccountStorage } from "../../core/account/storage.ts";
import type { TetiAccount } from "../../core/account/model.ts";
import {
  FileTetiNetworkCredentialStore,
  MemoryTetiNetworkCredentialStore,
  type TetiNetworkCredentialRecord
} from "./credential-store.ts";
import { FakeTetiNetworkClient } from "./fake-client.ts";
import { TetiNetworkIdentityService } from "./identity-service.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type {
  TetiNetworkIdentitySession,
  TetiNetworkRegisterIdentityRequest,
  TetiNetworkSigningKey,
  TetiNetworkWriteOptions
} from "./types.ts";

test("clean install registers a Network-generated Teti ID without changing Chatmail", async () => {
  const accountStorage = await accountStore(account({
    id: "teti_fresh0001",
    address: "fresh0001@mail.seep.im",
    networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
  }));
  const credentialStore = await makeCredentialStore();
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setIdentitySession(session(
    await credentialStore.load() as TetiNetworkCredentialRecord,
    "teti_new000001",
    "fresh0001@mail.seep.im"
  ));
  const service = identityService(client, accountStorage, credentialStore);

  const synchronized = await service.synchronize();

  assert.equal(client.registerCalls.length, 1);
  assert.equal(client.adoptCalls.length, 0);
  assert.equal(synchronized.id, "teti_new000001");
  assert.equal(synchronized.address, "fresh0001@mail.seep.im");
  assert.equal(synchronized.chatmailAccountId, 7);
  assert.equal(synchronized.publicKey, "OPENPGP-TRANSPORT-PUBLIC-KEY");
  assert.equal(synchronized.networkIdentity?.state, "active");
  const bound = await credentialStore.load();
  assert.equal(bound?.tetiId, "teti_new000001");
  assert.equal(bound?.pending, undefined);

  await service.synchronize();
  assert.equal(client.registerCalls.length, 1);
  assert.equal(client.selfCalls.length, 1);
});

test("existing account adoption preserves Teti ID and never provisions another Chatmail account", async () => {
  const accountStorage = await accountStore(account({
    id: "teti_old000001",
    address: "legacy001@mail.seep.im"
  }));
  const credentialStore = await makeCredentialStore();
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setIdentitySession(session(
    await credentialStore.load() as TetiNetworkCredentialRecord,
    "teti_old000001",
    "legacy001@mail.seep.im"
  ));
  const service = identityService(client, accountStorage, credentialStore);

  const synchronized = await service.synchronize();

  assert.equal(client.adoptCalls.length, 1);
  assert.equal(client.adoptCalls[0]?.tetiId, "teti_old000001");
  assert.equal(client.adoptCalls[0]?.adoptionGrant, "TEST_ONLY_32_BYTE_ADOPTION_GRANT_TOKEN");
  assert.equal(synchronized.id, "teti_old000001");
  assert.equal(synchronized.address, "legacy001@mail.seep.im");
  assert.equal(synchronized.chatmailAccountId, 7);
});

test("failed registration restart reuses exact body bytes and idempotency key", async () => {
  const accountStorage = await accountStore(account({
    id: "teti_fresh0001",
    address: "fresh0001@mail.seep.im",
    networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
  }));
  const credentialStore = await makeCredentialStore();
  const client = new FlakyRegistrationClient(bootstrap());
  client.setIdentitySession(session(
    await credentialStore.load() as TetiNetworkCredentialRecord,
    "teti_new000001",
    "fresh0001@mail.seep.im"
  ));
  const service = identityService(client, accountStorage, credentialStore);

  await assert.rejects(() => service.synchronize(), /simulated connection loss/);
  const pending = (await credentialStore.load())?.pending;
  assert.ok(pending);
  const synchronized = await service.synchronize();

  assert.equal(synchronized.id, "teti_new000001");
  assert.equal(client.attempts.length, 2);
  assert.equal(client.attempts[0]?.idempotencyKey, client.attempts[1]?.idempotencyKey);
  assert.equal(client.attempts[0]?.rawBody, client.attempts[1]?.rawBody);
  assert.equal(client.attempts[0]?.rawBody, pending.rawBody);
});

test("register account replaces a stale unbound adopt request without replacing signing keys", async () => {
  const currentAccount = account({
    id: "teti_fresh0001",
    address: "fresh0001@mail.seep.im",
    networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
  });
  const accountStorage = await accountStore(currentAccount);
  const originalCredentials = testCredentials();
  const credentialStore = new MemoryTetiNetworkCredentialStore();
  await credentialStore.save({
    ...originalCredentials,
    pending: staleAdoptPending(originalCredentials, {
      tetiId: "teti_legacy001",
      address: "legacy001@mail.seep.im"
    })
  });
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setIdentitySession(session(
    originalCredentials,
    "teti_new000001",
    "fresh0001@mail.seep.im"
  ));

  const synchronized = await identityService(client, accountStorage, credentialStore).synchronize();

  assert.equal(client.adoptCalls.length, 0);
  assert.equal(client.registerCalls.length, 1);
  assert.equal(client.registerCalls[0]?.delivery.address, currentAccount.address);
  assert.equal(synchronized.id, "teti_new000001");
  assert.equal(synchronized.address, currentAccount.address);
  assert.equal(synchronized.chatmailAccountId, currentAccount.chatmailAccountId);
  assert.equal(synchronized.publicKey, currentAccount.publicKey);
  const bound = await credentialStore.load();
  assert.equal(bound?.identityRoot.publicKey, originalCredentials.identityRoot.publicKey);
  assert.equal(bound?.identityRoot.privateSeed, originalCredentials.identityRoot.privateSeed);
  assert.equal(bound?.clientInstance.publicKey, originalCredentials.clientInstance.publicKey);
  assert.equal(bound?.clientInstance.privateSeed, originalCredentials.clientInstance.privateSeed);
  assert.equal(bound?.pending, undefined);
});

test("pending register for another Chatmail account is rebuilt for the current account", async () => {
  const currentAccount = account({
    id: "teti_fresh0001",
    address: "fresh0001@mail.seep.im",
    networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
  });
  const accountStorage = await accountStore(currentAccount);
  const credentials = testCredentials();
  const staleRequest: TetiNetworkRegisterIdentityRequest = {
    schemaVersion: 1,
    identityPublicKey: credentials.identityRoot.publicKey,
    clientInstance: {
      publicKey: credentials.clientInstance.publicKey,
      platform: "macos",
      appVersion: "0.3.2"
    },
    identityAuthorization: "ed25519:stale-signature",
    delivery: {
      address: "different-account@mail.seep.im",
      publicKey: "DIFFERENT-OPENPGP-KEY"
    }
  };
  const credentialStore = new MemoryTetiNetworkCredentialStore();
  await credentialStore.save({
    ...credentials,
    pending: {
      operation: "register",
      idempotencyKey: "test.register:stale-account-request",
      rawBody: JSON.stringify(staleRequest)
    }
  });
  const client = new FakeTetiNetworkClient(bootstrap());
  client.setIdentitySession(session(credentials, "teti_new000001", currentAccount.address));

  await identityService(client, accountStorage, credentialStore).synchronize();

  assert.equal(client.registerCalls.length, 1);
  assert.equal(client.registerCalls[0]?.delivery.address, currentAccount.address);
  assert.equal(client.registerCalls[0]?.delivery.publicKey, currentAccount.publicKey);
});

test("active binding refuses silent key regeneration when credentials are missing", async () => {
  const accountStorage = await accountStore(account({
    id: "teti_bound0001",
    address: "bound0001@mail.seep.im",
    networkIdentity: {
      schemaVersion: 1,
      mode: "register",
      state: "active",
      identityPublicKey: "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
      clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
      lastVerifiedAt: "2026-08-08T12:00:00.000Z"
    }
  }));
  const client = new FakeTetiNetworkClient(bootstrap());
  const service = identityService(client, accountStorage, new MemoryTetiNetworkCredentialStore());

  await assert.rejects(
    () => service.synchronize(),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_UNAUTHORIZED"
      && error.retryable === false
  );
});

test("file credential store uses private file permissions and never writes into account metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teti-network-credentials-"));
  try {
    const path = join(directory, "credentials", "network.json");
    const store = new FileTetiNetworkCredentialStore(path);
    const record = testCredentials();
    await store.save(record);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "credentials"))).mode & 0o777, 0o700);
    const raw = await readFile(path, "utf8");
    assert.ok(raw.includes("ed25519-seed:"));
    assert.deepEqual(await store.load(), record);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FlakyRegistrationClient extends FakeTetiNetworkClient {
  readonly attempts: Array<{ idempotencyKey: string; rawBody?: string }> = [];

  override async registerIdentity(
    input: TetiNetworkRegisterIdentityRequest,
    pendingClient: TetiNetworkSigningKey,
    options: TetiNetworkWriteOptions
  ): Promise<TetiNetworkIdentitySession> {
    this.attempts.push({
      idempotencyKey: options.idempotencyKey,
      ...(options.rawBody ? { rawBody: options.rawBody } : {})
    });
    if (this.attempts.length === 1) throw new Error("simulated connection loss");
    return super.registerIdentity(input, pendingClient, options);
  }
}

function identityService(
  client: FakeTetiNetworkClient,
  accountStorage: MemoryTetiAccountStorage,
  credentials: MemoryTetiNetworkCredentialStore
) {
  return new TetiNetworkIdentityService({
    client,
    accountStorage,
    credentialStore: credentials,
    appVersion: "0.3.2",
    platform: "macos",
    adoptionGrant: "TEST_ONLY_32_BYTE_ADOPTION_GRANT_TOKEN",
    now: () => new Date("2026-08-08T12:00:02.000Z"),
    idempotencyKeyFactory: (operation) => `test.${operation}:00000000-0000-4000-8000-000000000001`
  });
}

async function accountStore(value: TetiAccount): Promise<MemoryTetiAccountStorage> {
  const store = new MemoryTetiAccountStorage();
  await store.save(value);
  return store;
}

async function makeCredentialStore(): Promise<MemoryTetiNetworkCredentialStore> {
  const store = new MemoryTetiNetworkCredentialStore();
  await store.save(testCredentials());
  return store;
}

function testCredentials(): TetiNetworkCredentialRecord {
  return {
    schemaVersion: 1,
    identityRoot: {
      privateSeed: "ed25519-seed:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      publicKey: "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
    },
    clientInstance: {
      privateSeed: "ed25519-seed:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
      publicKey: "ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc"
    }
  };
}

function staleAdoptPending(
  credentials: TetiNetworkCredentialRecord,
  input: { tetiId: string; address: string }
): NonNullable<TetiNetworkCredentialRecord["pending"]> {
  const request = {
    schemaVersion: 1 as const,
    tetiId: input.tetiId,
    adoptionGrant: "TEST_ONLY_32_BYTE_ADOPTION_GRANT_TOKEN",
    identityPublicKey: credentials.identityRoot.publicKey,
    clientInstance: {
      publicKey: credentials.clientInstance.publicKey,
      platform: "macos",
      appVersion: "0.3.2"
    },
    identityAuthorization: "ed25519:stale-signature" as const,
    delivery: { address: input.address, publicKey: "OPENPGP-TRANSPORT-PUBLIC-KEY" }
  };
  return {
    operation: "adopt",
    idempotencyKey: "test.adopt:stale-account-request",
    rawBody: JSON.stringify(request)
  };
}

function account(overrides: Partial<TetiAccount>): TetiAccount {
  return {
    version: 1,
    id: "teti_fresh0001",
    address: "fresh0001@mail.seep.im",
    displayName: "Milo",
    chatmailAccountId: 7,
    publicKey: "OPENPGP-TRANSPORT-PUBLIC-KEY",
    publicProfile: { platform: "macOS", category: ["developer"], aiEnvironment: [] },
    createdAt: "2026-08-08T10:00:00.000Z",
    ...overrides
  };
}

function session(
  credentials: TetiNetworkCredentialRecord,
  tetiId: string,
  address: string
): TetiNetworkIdentitySession {
  return {
    identity: {
      tetiId,
      identityPublicKey: credentials.identityRoot.publicKey,
      status: "active",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z"
    },
    clientInstance: {
      id: "ci_AAAAAAAAAAAAAAAAAAAAAA",
      publicKey: credentials.clientInstance.publicKey,
      platform: "macos",
      appVersion: "0.3.2",
      status: "active",
      createdAt: "2026-08-08T12:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null
    },
    delivery: { address, publicKey: "OPENPGP-TRANSPORT-PUBLIC-KEY" }
  };
}

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-08T12:00:00.000Z",
    protocolSupport: { minimumSupportedVersion: 1, supportedVersions: [1] },
    releasePolicy: {
      schemaVersion: 1 as const,
      policyVersion: 1,
      channel: "beta" as const,
      minimumSupportedVersion: "0.3.0",
      effectiveAt: "2026-08-08T00:00:00.000Z"
    },
    capabilities: {
      publicDirectory: true,
      identity: true,
      clientAuthentication: true,
      presence: true,
      publicProfile: true,
      relationships: true,
      relayBindings: false,
      invites: false
    },
    presencePolicy: {
      collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
      viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
      online: { reportEverySeconds: 15, ttlSeconds: 45 },
      background: { reportEverySeconds: 30, ttlSeconds: 90 }
    }
  };
}
