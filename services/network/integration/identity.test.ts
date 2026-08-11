import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { TetiAccount } from "../../../core/account/model.ts";
import { MemoryTetiAccountStorage } from "../../../core/account/storage.ts";
import { HttpTetiNetworkClient } from "../client.ts";
import {
  MemoryTetiNetworkCredentialStore,
  type TetiNetworkCredentialRecord
} from "../credential-store.ts";
import { DEVELOPMENT_TETI_NETWORK_BASE_URL, resolveTetiNetworkBaseUrl } from "../config.ts";
import { TetiNetworkClientError } from "../errors.ts";
import { TetiNetworkIdentityService } from "../identity-service.ts";
import { MemoryTetiNetworkRelayBindingStore } from "../relay-binding-store.ts";
import { TetiNetworkRelayService } from "../relay-service.ts";
import {
  createTetiNetworkNonce,
  generateTetiNetworkSigningKey
} from "../signing.ts";

test("Beta 0.3.8 App preserves the local Revision 8 identity/auth lifecycle", async () => {
  const runId = randomUUID();
  const adoptedId = "teti_old000001";
  const adoptedAddress = "old000001@mail.seep.im";
  const registeredCode = canonicalCode();
  const registeredAddress = `${registeredCode}@mail.seep.im`;
  const registrationCredentials = freshCredentials();
  const baseUrl = resolveTetiNetworkBaseUrl({
    TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
  });
  const client = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.8",
    clientPlatform: "macos"
  });
  const bootstrap = await client.getBootstrap();
  assert.equal(bootstrap.contractRevision, 8);
  assert.equal(bootstrap.capabilities.identity, true);
  assert.equal(bootstrap.capabilities.clientAuthentication, true);

  // First-claim adoption deliberately runs before registration on a fresh dev DB.
  const adopted = await createIdentityHarness({
    client,
    account: account(adoptedId, adoptedAddress),
    credentials: legacyAdoptionCredentials(),
    idempotencyPrefix: "local-adopt-beta032-v1",
    appVersion: "0.3.3"
  });
  const adoptedAccount = await adopted.service.synchronize();
  assert.equal(adoptedAccount.id, adoptedId);
  assert.equal(adoptedAccount.address, adoptedAddress);
  assert.equal((await adopted.service.synchronize()).networkIdentity?.state, "active");

  const clientLifecycle = identityService(
    client,
    adopted.accountStorage,
    adopted.credentialStore,
    `local-client-beta037:${runId}`
  );
  const newClient = generateTetiNetworkSigningKey();
  const enrolled = await clientLifecycle.enrollClientInstance(newClient, {
    platform: "ios",
    appVersion: "0.3.3"
  });
  assert.equal(enrolled.publicKey, newClient.publicKey);
  assert.equal(enrolled.status, "active");

  const replayNonce = createTetiNetworkNonce();
  const replayRequestId = randomUUID();
  const replayClient = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.8",
    clientPlatform: "ios",
    requestIdFactory: () => replayRequestId,
    nonceFactory: () => replayNonce,
    now: () => new Date(bootstrap.serverTime)
  });
  const enrolledAuth = { clientInstanceId: enrolled.id, signingKey: newClient };
  assert.equal((await replayClient.getIdentitySelf(enrolledAuth)).identity.tetiId, adoptedId);
  await assert.rejects(
    () => replayClient.getIdentitySelf(enrolledAuth),
    (error) => error instanceof TetiNetworkClientError && error.code === "REQUEST_REPLAYED"
  );

  const revoked = await clientLifecycle.revokeClientInstance(enrolled.id);
  assert.equal(revoked.status, "revoked");
  await assert.rejects(
    () => client.getIdentitySelf(enrolledAuth),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "NETWORK_CLIENT_REVOKED"
  );

  const registered = await createIdentityHarness({
    client,
    account: {
      ...account("teti_fresh0321", registeredAddress),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: structuredClone(registrationCredentials),
    idempotencyPrefix: `local-register-beta037:${runId}`
  });
  const registeredAccount = await registered.service.synchronize();
  assert.notEqual(registeredAccount.id, "teti_fresh0321");
  assert.equal(registeredAccount.address, registeredAddress);
  assert.equal(registeredAccount.chatmailAccountId, 7);

  const relayStore = new MemoryTetiNetworkRelayBindingStore();
  const relayService = new TetiNetworkRelayService({
    client,
    accountStorage: registered.accountStorage,
    store: relayStore,
    environment: "local_development",
    getAuthentication: () => registered.service.getAuthenticatedSigner()
  });
  const relayBinding = await relayService.synchronize();
  assert.equal(relayBinding.document.active?.address, registeredAccount.address);
  assert.equal(relayBinding.document.active?.transportPublicKey, null);
  assert.equal((await relayStore.load())?.environment, "local_development");

  const duplicate = await createIdentityHarness({
    client,
    account: {
      ...account("teti_fresh0321", registeredAddress),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: structuredClone(registrationCredentials),
    idempotencyPrefix: `local-register-duplicate-beta037:${runId}`
  });
  assert.equal((await duplicate.service.synchronize()).id, registeredAccount.id);

  const keyConflict = await createIdentityHarness({
    client,
    account: {
      ...account("teti_other0321", `${canonicalCode()}@mail.seep.im`),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: structuredClone(registrationCredentials),
    idempotencyPrefix: `local-register-conflict:${randomUUID()}`
  });
  await assert.rejects(
    () => keyConflict.service.synchronize(),
    (error) => error instanceof TetiNetworkClientError
      && (error.code === "IDENTITY_ALREADY_EXISTS" || error.code === "NETWORK_CONFLICT")
  );

  // Recreate the Runtime service over the same stores to verify restart recovery through signed /self.
  const restarted = identityService(
    client,
    registered.accountStorage,
    registered.credentialStore,
    `local-register-beta037:${runId}`
  );
  assert.equal((await restarted.synchronize()).id, registeredAccount.id);
});

async function createIdentityHarness(input: {
  client: HttpTetiNetworkClient;
  account: TetiAccount;
  credentials: TetiNetworkCredentialRecord;
  idempotencyPrefix: string;
  appVersion?: string;
}) {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(input.account);
  const credentialStore = new MemoryTetiNetworkCredentialStore();
  await credentialStore.save(input.credentials);
  return {
    accountStorage,
    credentialStore,
    service: identityService(
      input.client,
      accountStorage,
      credentialStore,
      input.idempotencyPrefix,
      input.appVersion
    )
  };
}

function identityService(
  client: HttpTetiNetworkClient,
  accountStorage: MemoryTetiAccountStorage,
  credentialStore: MemoryTetiNetworkCredentialStore,
  prefix: string,
  appVersion = "0.3.8"
): TetiNetworkIdentityService {
  return new TetiNetworkIdentityService({
    client,
    accountStorage,
    credentialStore,
    environment: "local_development",
    appVersion,
    platform: "macos",
    adoptionGrant: "teti-development-first-claim",
    idempotencyKeyFactory: (operation) => `${prefix}:${operation}`
  });
}

function account(id: string, address: string): TetiAccount {
  return {
    version: 1,
    id,
    address,
    displayName: "Beta 032 Integration",
    chatmailAccountId: 7,
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
    createdAt: "2026-08-08T10:00:00.000Z"
  };
}

function freshCredentials(): TetiNetworkCredentialRecord {
  const identityRoot = generateTetiNetworkSigningKey();
  const clientInstance = generateTetiNetworkSigningKey();
  return {
    schemaVersion: 1,
    identityRoot: {
      privateSeed: identityRoot.privateSeed,
      publicKey: identityRoot.publicKey
    },
    clientInstance: {
      privateSeed: clientInstance.privateSeed,
      publicKey: clientInstance.publicKey
    }
  };
}

function legacyAdoptionCredentials(): TetiNetworkCredentialRecord {
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

function canonicalCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, 9);
}
