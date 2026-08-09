import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { TetiNetworkProfileService } from "../profile-service.ts";
import { MemoryTetiNetworkProfileSyncStore } from "../profile-sync-store.ts";

test("Beta 0.3.5 Runtime synchronizes PublicProfile against local Network Revision 6", async () => {
  const client = new HttpTetiNetworkClient({
    baseUrl: resolveTetiNetworkBaseUrl({
      TETI_NETWORK_BASE_URL: process.env.TETI_NETWORK_BASE_URL ?? DEVELOPMENT_TETI_NETWORK_BASE_URL
    }),
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
    // This deterministic first-claim fixture originated in Beta 0.3.2. A
    // bound ClientInstance keeps its enrollment version across App upgrades.
    appVersion: "0.3.3",
    platform: "macos",
    adoptionGrant: "teti-development-first-claim",
    idempotencyKeyFactory: (operation) => `local-adopt-beta032-v1:${operation}`
  });
  const synchronized = await identity.synchronize();
  const signer = await identity.getAuthenticatedSigner();
  const before = await client.getProfileSelf(signer.authentication);
  const nextDisplayName = before.document.profile.displayName === "Beta 034 Local A"
    ? "Beta 034 Local B"
    : "Beta 034 Local A";
  const desired = {
    profile: {
      displayName: nextDisplayName,
      avatarUrl: null,
      summary: "Public Profile contract integration",
      capabilitySummary: {
        schemaVersion: 1 as const,
        platform: "macos" as const,
        category: ["developer"],
        capabilityIds: ["code-analysis"]
      }
    },
    isDiscoverable: true
  };
  const service = new TetiNetworkProfileService({
    client,
    store: new MemoryTetiNetworkProfileSyncStore(),
    getAuthentication: async () => signer,
    getDesiredProfile: async () => structuredClone(desired),
    idempotencyKeyFactory: () => `profile.local:${randomUUID()}`
  });

  const updated = await service.synchronize();
  const noOp = await service.synchronize();
  const publicNode = await client.getPublicNode(synchronized.id);

  assert.equal(updated.outcome, "updated");
  assert.ok(updated.document.revision > before.document.revision);
  assert.equal(noOp.outcome, "unchanged");
  assert.equal(noOp.document.revision, updated.document.revision);
  assert.equal(publicNode.profile.revision, updated.document.revision);
  assert.equal(publicNode.profile.displayName, nextDisplayName);
  assert.deepEqual(publicNode.profile.capabilitySummary?.aiEnvironment, []);
  assert.equal(JSON.stringify(updated.document).includes("lastSeen"), false);

  await assert.rejects(
    () => client.replaceProfileSelf({
      schemaVersion: 1,
      expectedRevision: before.document.revision,
      profile: desired.profile,
      isDiscoverable: true
    }, signer.authentication, {
      ifMatch: before.etag,
      idempotencyKey: `profile.stale:${randomUUID()}`
    }),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PROFILE_REVISION_CONFLICT"
      && error.status === 412
  );
});

function account(): TetiAccount {
  return {
    version: 1,
    id: "teti_old000001",
    address: "old000001@mail.seep.im",
    displayName: "Beta 034 Local",
    chatmailAccountId: 7,
    publicProfile: { platform: "macOS", category: ["developer"], aiEnvironment: [] },
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
