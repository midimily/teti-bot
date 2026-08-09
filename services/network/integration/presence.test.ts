import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
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

test("Beta 0.3.5 App keeps Presence minimal against local Network", async () => {
  const baseUrl = resolveTetiNetworkBaseUrl({
    TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
  });
  const client = new HttpTetiNetworkClient({
    baseUrl,
    clientVersion: "0.3.5",
    clientPlatform: "macos"
  });
  const accountStorage = new MemoryTetiAccountStorage();
  await accountStorage.save(account());
  const credentialStore = new MemoryTetiNetworkCredentialStore();
  await credentialStore.save(credentials());
  const identity = new TetiNetworkIdentityService({
    client,
    accountStorage,
    credentialStore,
    appVersion: "0.3.3",
    platform: "macos",
    adoptionGrant: "teti-development-first-claim",
    idempotencyKeyFactory: (operation) => `local-adopt-beta032-v1:${operation}`
  });
  const synchronized = await identity.synchronize();
  const { authentication } = await identity.getAuthenticatedSigner();
  const sessionId = `ps_${randomBytes(16).toString("base64url")}`;
  const report = await client.reportPresence({
    schemaVersion: 1,
    sessionId,
    sequence: 2,
    mode: "online",
    activityMarker: null
  }, authentication);

  assert.equal(report.tetiId, synchronized.id);
  assert.equal(report.sequence, 2);
  assert.equal(report.mode, "online");
  assert.equal(report.expiresInSeconds, 45);
  assert.ok(Date.parse(report.expiresAt) > Date.parse(report.reportedAt));

  const observed = await client.getPresence(synchronized.id, authentication);
  assert.equal(observed.state, "online");
  assert.equal(observed.mode, "online");
  assert.ok(observed.expiresInSeconds > 0);

  await assert.rejects(
    () => client.reportPresence({
      schemaVersion: 1,
      sessionId,
      sequence: 1,
      mode: "background",
      activityMarker: null
    }, authentication),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PRESENCE_SEQUENCE_STALE"
      && error.operation === "presence_report"
  );
});

function account(): TetiAccount {
  return {
    version: 1,
    id: "teti_old000001",
    address: "old000001@mail.seep.im",
    displayName: "Beta 033 Presence",
    chatmailAccountId: 7,
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] },
    createdAt: "2026-08-08T10:00:00.000Z"
  };
}

function credentials(): TetiNetworkCredentialRecord {
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
