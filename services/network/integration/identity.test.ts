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
import {
  createTetiNetworkNonce,
  generateTetiNetworkSigningKey
} from "../signing.ts";

test("Beta 0.3.5 App preserves the local Revision 6 identity/auth lifecycle", async () => {
  const baseUrl = resolveTetiNetworkBaseUrl({
    TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
  });
  const client = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.5",
    clientPlatform: "macos"
  });
  const bootstrap = await client.getBootstrap();
  assert.equal(bootstrap.contractRevision, 6);
  assert.equal(bootstrap.capabilities.identity, true);
  assert.equal(bootstrap.capabilities.clientAuthentication, true);

  // First-claim adoption deliberately runs before registration on a fresh dev DB.
  const adopted = await createIdentityHarness({
    client,
    account: account("teti_old000001", "old000001@mail.seep.im"),
    credentials: adoptionCredentials(),
    idempotencyPrefix: "local-adopt-beta032-v1"
  });
  const adoptedAccount = await adopted.service.synchronize();
  assert.equal(adoptedAccount.id, "teti_old000001");
  assert.equal(adoptedAccount.address, "old000001@mail.seep.im");
  assert.equal((await adopted.service.synchronize()).networkIdentity?.state, "active");

  const clientLifecycle = identityService(
    client,
    adopted.accountStorage,
    adopted.credentialStore,
    `local-client-beta032:${randomUUID()}`
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
    clientVersion: "0.3.5",
    clientPlatform: "ios",
    requestIdFactory: () => replayRequestId,
    nonceFactory: () => replayNonce,
    now: () => new Date(bootstrap.serverTime)
  });
  const enrolledAuth = { clientInstanceId: enrolled.id, signingKey: newClient };
  assert.equal((await replayClient.getIdentitySelf(enrolledAuth)).identity.tetiId, "teti_old000001");
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
      ...account("teti_fresh0321", "fresh0321@mail.seep.im"),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: registrationCredentials(),
    idempotencyPrefix: "local-register-beta032-v1"
  });
  const registeredAccount = await registered.service.synchronize();
  assert.notEqual(registeredAccount.id, "teti_fresh0321");
  assert.equal(registeredAccount.address, "fresh0321@mail.seep.im");
  assert.equal(registeredAccount.chatmailAccountId, 7);

  const duplicate = await createIdentityHarness({
    client,
    account: {
      ...account("teti_fresh0321", "fresh0321@mail.seep.im"),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: registrationCredentials(),
    idempotencyPrefix: "local-register-duplicate-beta032-v1"
  });
  assert.equal((await duplicate.service.synchronize()).id, registeredAccount.id);

  const keyConflict = await createIdentityHarness({
    client,
    account: {
      ...account("teti_other0321", "other0321@mail.seep.im"),
      networkIdentity: { schemaVersion: 1, mode: "register", state: "pending" }
    },
    credentials: registrationCredentials(),
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
    "local-register-beta032-v1"
  );
  assert.equal((await restarted.synchronize()).id, registeredAccount.id);
});

async function createIdentityHarness(input: {
  client: HttpTetiNetworkClient;
  account: TetiAccount;
  credentials: TetiNetworkCredentialRecord;
  idempotencyPrefix: string;
}) {
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(input.account);
  const credentialStore = new MemoryTetiNetworkCredentialStore();
  await credentialStore.save(input.credentials);
  return {
    accountStorage,
    credentialStore,
    service: identityService(input.client, accountStorage, credentialStore, input.idempotencyPrefix)
  };
}

function identityService(
  client: HttpTetiNetworkClient,
  accountStorage: MemoryTetiAccountStorage,
  credentialStore: MemoryTetiNetworkCredentialStore,
  prefix: string
): TetiNetworkIdentityService {
  return new TetiNetworkIdentityService({
    client,
    accountStorage,
    credentialStore,
    appVersion: "0.3.3",
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

function adoptionCredentials(): TetiNetworkCredentialRecord {
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

function registrationCredentials(): TetiNetworkCredentialRecord {
  return {
    schemaVersion: 1,
    identityRoot: {
      privateSeed: "ed25519-seed:G-lO7ghQ7mxHYRYk1G0BKNjRR8GI9S6LDkbiQYsnwdg",
      publicKey: "ed25519:zalosR03yQuAjSutFaYyR3a40sMwE-_XSo0Z3rwu728"
    },
    clientInstance: {
      privateSeed: "ed25519-seed:P-2SaeRB68nAscuLX1r5CVlAwG7g8W4oznI4j6xA-54",
      publicKey: "ed25519:3A4KHA_YBPCCfwieCUVPlB1x9xkZIsHt01_-qa0aU8U"
    }
  };
}
