import assert from "node:assert/strict";
import test from "node:test";
import { FakeTetiNetworkClient } from "./fake-client.ts";
import { TetiNetworkClientError } from "./errors.ts";
import { TetiNetworkProfileService } from "./profile-service.ts";
import { MemoryTetiNetworkProfileSyncStore } from "./profile-sync-store.ts";
import { generateTetiNetworkSigningKey } from "./signing.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkProfileResult,
  TetiNetworkProfileWriteOptions,
  TetiNetworkReplacePublicProfileRequest
} from "./types.ts";

const TETI_ID = "teti_c77np4w6r";
const authentication: TetiNetworkAuthenticatedSigner = {
  clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
  signingKey: generateTetiNetworkSigningKey()
};

test("Profile service writes one public-only full replacement and then becomes a no-op", async () => {
  const client = new ProfileClient(emptyProfile());
  const store = new MemoryTetiNetworkProfileSyncStore();
  const service = createService(client, store);

  const first = await service.synchronize();
  client.current = first;
  const second = await service.synchronize();

  assert.equal(first.outcome, "updated");
  assert.equal(second.outcome, "unchanged");
  assert.equal(client.replacements.length, 1);
  assert.deepEqual(client.replacements[0]?.input.profile, desired().profile);
  assert.equal(client.replacements[0]?.options.ifMatch, '"profile-r0"');
  assert.equal(client.replacements[0]?.options.rawBody, JSON.stringify(client.replacements[0]?.input));
  assert.equal(client.replacements[0]?.options.rawBody?.includes("aiEnvironment"), false);
  assert.equal(client.replacements[0]?.options.rawBody?.includes("lastSeen"), false);
});

test("Profile service keeps a durable exact mutation across retryable failure", async () => {
  const client = new ProfileClient(emptyProfile());
  const store = new MemoryTetiNetworkProfileSyncStore();
  client.nextReplaceError = new TetiNetworkClientError({
    code: "SERVER_UNAVAILABLE",
    operation: "profile_replace",
    message: "Unavailable.",
    retryable: true
  });
  const firstService = createService(client, store);
  await assert.rejects(() => firstService.synchronize(), /Unavailable/);
  const pending = (await store.load()).pending;
  assert.ok(pending);

  const retryClient = new ProfileClient(emptyProfile());
  const retryService = createService(retryClient, store);
  await retryService.synchronize();
  assert.equal(retryClient.replacements[0]?.options.idempotencyKey, pending.idempotencyKey);
  assert.equal(retryClient.replacements[0]?.options.rawBody, pending.rawBody);
  assert.equal(retryClient.replacements[0]?.options.ifMatch, pending.ifMatch);
  assert.equal((await store.load()).pending, undefined);
});

test("Profile service treats 412 as terminal, rereads, and uses a fresh revision and key", async () => {
  const client = new ProfileClient(emptyProfile());
  let key = 0;
  client.nextReplaceError = new TetiNetworkClientError({
    code: "PROFILE_REVISION_CONFLICT",
    operation: "profile_replace",
    message: "Stale.",
    retryable: false,
    status: 412
  });
  client.afterConflict = profileResult(3, {
    displayName: "Other writer",
    avatarUrl: null,
    summary: null,
    capabilitySummary: null
  }, false);
  const service = createService(client, new MemoryTetiNetworkProfileSyncStore(), () => `profile.replace:test-${++key}`);

  const result = await service.synchronize();

  assert.equal(result.document.revision, 4);
  assert.equal(client.replacements.length, 2);
  assert.equal(client.replacements[0]?.input.expectedRevision, 0);
  assert.equal(client.replacements[1]?.input.expectedRevision, 3);
  assert.notEqual(
    client.replacements[0]?.options.idempotencyKey,
    client.replacements[1]?.options.idempotencyKey
  );
});

class ProfileClient extends FakeTetiNetworkClient {
  current: TetiNetworkProfileResult;
  readonly replacements: Array<{
    input: TetiNetworkReplacePublicProfileRequest;
    options: TetiNetworkProfileWriteOptions;
  }> = [];
  nextReplaceError: unknown = null;
  afterConflict: TetiNetworkProfileResult | null = null;
  private conflictOccurred = false;

  constructor(current: TetiNetworkProfileResult) {
    super(bootstrap());
    this.current = current;
  }

  override async getProfileSelf(): Promise<TetiNetworkProfileResult> {
    if (this.conflictOccurred && this.afterConflict) {
      this.current = this.afterConflict;
      this.afterConflict = null;
      this.conflictOccurred = false;
    }
    return structuredClone(this.current);
  }

  override async replaceProfileSelf(
    input: TetiNetworkReplacePublicProfileRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkProfileWriteOptions
  ): Promise<TetiNetworkProfileResult> {
    this.replacements.push({ input: structuredClone(input), options: { ...options } });
    if (this.nextReplaceError) {
      const error = this.nextReplaceError;
      this.nextReplaceError = null;
      if (error instanceof TetiNetworkClientError
        && error.code === "PROFILE_REVISION_CONFLICT") this.conflictOccurred = true;
      throw error;
    }
    const result = profileResult(input.expectedRevision + 1, input.profile, input.isDiscoverable);
    this.current = result;
    return structuredClone(result);
  }
}

function createService(
  client: ProfileClient,
  store: MemoryTetiNetworkProfileSyncStore,
  idempotencyKeyFactory: () => string = () => "profile.replace:00000000-0000-4000-8000-000000000000"
): TetiNetworkProfileService {
  return new TetiNetworkProfileService({
    client,
    store,
    getAuthentication: async () => ({ tetiId: TETI_ID, authentication }),
    getDesiredProfile: async () => structuredClone(desired()),
    idempotencyKeyFactory
  });
}

function desired() {
  return {
    profile: {
      displayName: "Casey",
      avatarUrl: null,
      summary: null,
      capabilitySummary: {
        schemaVersion: 1 as const,
        platform: "macos" as const,
        category: ["developer"],
        capabilityIds: ["code-analysis"]
      }
    },
    isDiscoverable: true
  };
}

function emptyProfile(): TetiNetworkProfileResult {
  return profileResult(0, {
    displayName: null,
    avatarUrl: null,
    summary: null,
    capabilitySummary: null
  }, false, null);
}

function profileResult(
  revision: number,
  profile: TetiNetworkReplacePublicProfileRequest["profile"],
  isDiscoverable: boolean,
  updatedAt: string | null = "2026-08-09T09:00:00.000Z"
): TetiNetworkProfileResult {
  return {
    document: {
      schemaVersion: 1,
      tetiId: TETI_ID,
      revision,
      profile: structuredClone(profile),
      isDiscoverable,
      updatedAt
    },
    etag: `"profile-r${revision}"`
  };
}

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-09T09:00:00.000Z",
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
