import { randomUUID } from "node:crypto";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type { TetiNetworkProfileSyncStore } from "./profile-sync-store.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkProfileResult,
  TetiNetworkPublicProfileFields,
  TetiNetworkReplacePublicProfileRequest
} from "./types.ts";

export interface DesiredTetiNetworkPublicProfile {
  profile: TetiNetworkPublicProfileFields;
  isDiscoverable: boolean;
}

export interface TetiNetworkProfileSynchronizationResult extends TetiNetworkProfileResult {
  outcome: "unchanged" | "updated";
}

export interface TetiNetworkProfileServiceOptions {
  client: TetiNetworkClient;
  store: TetiNetworkProfileSyncStore;
  getAuthentication(): Promise<{ tetiId: string; authentication: TetiNetworkAuthenticatedSigner }>;
  getDesiredProfile(): Promise<DesiredTetiNetworkPublicProfile>;
  idempotencyKeyFactory?: () => string;
}

/** Runtime-owned durable Profile writer. Presence and Passport never enter this service. */
export class TetiNetworkProfileService {
  private readonly client: TetiNetworkClient;
  private readonly store: TetiNetworkProfileSyncStore;
  private readonly getAuthentication: TetiNetworkProfileServiceOptions["getAuthentication"];
  private readonly getDesiredProfile: TetiNetworkProfileServiceOptions["getDesiredProfile"];
  private readonly idempotencyKeyFactory: () => string;
  private inFlight: Promise<TetiNetworkProfileSynchronizationResult> | null = null;
  private rerunRequested = false;

  constructor(options: TetiNetworkProfileServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.getAuthentication = options.getAuthentication;
    this.getDesiredProfile = options.getDesiredProfile;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory
      ?? (() => `profile.replace:${randomUUID()}`);
  }

  synchronize(): Promise<TetiNetworkProfileSynchronizationResult> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    const synchronization = this.runUntilClean();
    this.inFlight = synchronization;
    void synchronization.finally(() => {
      if (this.inFlight === synchronization) this.inFlight = null;
    }).catch(() => undefined);
    return synchronization;
  }

  private async runUntilClean(): Promise<TetiNetworkProfileSynchronizationResult> {
    let result: TetiNetworkProfileSynchronizationResult;
    do {
      this.rerunRequested = false;
      result = await this.synchronizeOnce();
    } while (this.rerunRequested);
    return result!;
  }

  private async synchronizeOnce(): Promise<TetiNetworkProfileSynchronizationResult> {
    assertTetiNetworkCompatible(await this.client.getBootstrap());
    const [{ tetiId, authentication }, desired] = await Promise.all([
      this.getAuthentication(),
      this.getDesiredProfile()
    ]);
    let stored = await this.store.load();
    if (stored.pending && stored.pending.tetiId !== tetiId) {
      stored = { schemaVersion: 1 };
      await this.store.save(stored);
    }
    if (stored.pending) {
      try {
        const result = await this.sendPending(stored.pending.rawBody, stored.pending, authentication);
        await this.store.save({ schemaVersion: 1 });
        if (sameDesired(result.document, desired)) return { ...result, outcome: "updated" };
      } catch (error) {
        if (!(error instanceof TetiNetworkClientError)
          || error.code !== "PROFILE_REVISION_CONFLICT") throw error;
        await this.store.save({ schemaVersion: 1 });
      }
    }

    let current = await this.client.getProfileSelf(authentication);
    if (current.document.tetiId !== tetiId) {
      throw new TetiNetworkClientError({
        code: "NETWORK_CONFLICT",
        operation: "profile_self",
        message: "Network Profile identity does not match the local authenticated identity.",
        retryable: false
      });
    }
    if (sameDesired(current.document, desired)) return { ...current, outcome: "unchanged" };

    for (let conflictAttempt = 0; conflictAttempt < 2; conflictAttempt += 1) {
      const request: TetiNetworkReplacePublicProfileRequest = {
        schemaVersion: 1,
        expectedRevision: current.document.revision,
        profile: structuredClone(desired.profile),
        isDiscoverable: desired.isDiscoverable
      };
      const pending = {
        tetiId,
        expectedRevision: request.expectedRevision,
        ifMatch: current.etag,
        idempotencyKey: this.idempotencyKeyFactory(),
        rawBody: JSON.stringify(request)
      };
      await this.store.save({ schemaVersion: 1, pending });
      try {
        const result = await this.sendPending(pending.rawBody, pending, authentication);
        await this.store.save({ schemaVersion: 1 });
        return { ...result, outcome: "updated" };
      } catch (error) {
        if (!(error instanceof TetiNetworkClientError)
          || error.code !== "PROFILE_REVISION_CONFLICT") throw error;
        await this.store.save({ schemaVersion: 1 });
        if (conflictAttempt === 1) throw error;
        current = await this.client.getProfileSelf(authentication);
        if (sameDesired(current.document, desired)) return { ...current, outcome: "unchanged" };
      }
    }
    throw new Error("Unreachable Teti Network Profile synchronization state.");
  }

  private sendPending(
    rawBody: string,
    pending: {
      expectedRevision: number;
      ifMatch: `"profile-r${number}"`;
      idempotencyKey: string;
    },
    authentication: TetiNetworkAuthenticatedSigner
  ): Promise<TetiNetworkProfileResult> {
    const request = JSON.parse(rawBody) as TetiNetworkReplacePublicProfileRequest;
    if (request.expectedRevision !== pending.expectedRevision) {
      throw new Error("Persisted Network Profile revision is inconsistent.");
    }
    return this.client.replaceProfileSelf(request, authentication, {
      ifMatch: pending.ifMatch,
      idempotencyKey: pending.idempotencyKey,
      rawBody
    });
  }
}

function sameDesired(
  document: TetiNetworkProfileResult["document"],
  desired: DesiredTetiNetworkPublicProfile
): boolean {
  return document.isDiscoverable === desired.isDiscoverable
    && JSON.stringify(document.profile) === JSON.stringify(desired.profile);
}
