import { randomUUID } from "node:crypto";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type {
  TetiNetworkPendingRelationshipCommand,
  TetiNetworkRelationshipCommandStore
} from "./relationship-command-store.ts";
import type {
  TetiNetworkRelationshipReconciliationStore
} from "./relationship-reconciliation-store.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkMutateRelationshipRequest,
  TetiNetworkRelationshipCommand,
  TetiNetworkRelationshipAuthorization,
  TetiNetworkRelationshipDocument,
  TetiNetworkRelationshipResult,
  TetiNetworkRequestRelationshipRequest
} from "./types.ts";

export interface TetiNetworkRelationshipServiceOptions {
  client: TetiNetworkClient;
  store: TetiNetworkRelationshipCommandStore;
  reconciliationStore: TetiNetworkRelationshipReconciliationStore;
  getAuthentication(): Promise<{ tetiId: string; authentication: TetiNetworkAuthenticatedSigner }>;
  idempotencyKeyFactory?: (operation: "request" | TetiNetworkRelationshipCommand) => string;
}

/** Runtime-owned authoritative Relationship contract with durable exact-command recovery. */
export class TetiNetworkRelationshipService {
  private readonly client: TetiNetworkClient;
  private readonly store: TetiNetworkRelationshipCommandStore;
  private readonly reconciliationStore: TetiNetworkRelationshipReconciliationStore;
  private readonly getAuthentication: TetiNetworkRelationshipServiceOptions["getAuthentication"];
  private readonly idempotencyKeyFactory: NonNullable<
    TetiNetworkRelationshipServiceOptions["idempotencyKeyFactory"]
  >;
  private queue: Promise<void> = Promise.resolve();
  private compatible = false;

  constructor(options: TetiNetworkRelationshipServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.reconciliationStore = options.reconciliationStore;
    this.getAuthentication = options.getAuthentication;
    this.idempotencyKeyFactory = options.idempotencyKeyFactory
      ?? ((operation) => `relationship.${operation}:${randomUUID()}`);
  }

  synchronize(signal?: AbortSignal): Promise<TetiNetworkRelationshipDocument[]> {
    const documents: TetiNetworkRelationshipDocument[] = [];
    return this.reconcile(async (document) => {
      documents.push(document);
    }, signal).then(() => documents);
  }

  reconcile(
    apply: (document: TetiNetworkRelationshipDocument) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    return this.serial(async () => {
      const identity = await this.prepare(signal);
      await this.recoverPending(identity, signal);
      const stored = await this.reconciliationStore.load();
      if (stored.tetiId && stored.tetiId !== identity.tetiId) {
        await this.reconciliationStore.save({ schemaVersion: 1 });
      }
      let checkpoint = stored.tetiId === identity.tetiId ? stored.checkpoint : undefined;
      if (!checkpoint) checkpoint = await this.scanSnapshot(identity, apply, signal);
      await this.scanChanges(checkpoint, identity, apply, signal);
    });
  }

  async authorizePeer(
    peerTetiId: string,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipAuthorization> {
    const identity = await this.prepare(signal);
    const authorization = await this.client.getRelationshipAuthorization(
      peerTetiId,
      identity.authentication,
      signal
    );
    if (authorization.peerTetiId !== peerTetiId
      || (authorization.decision === "allow") !== (authorization.reason === "confirmed")) {
      throw conflict(
        "relationship_authorization",
        "Network Relationship authorization does not match the requested peer."
      );
    }
    return authorization;
  }

  getByPeer(peerTetiId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult | null> {
    return this.serial(async () => {
      const identity = await this.prepare(signal);
      await this.recoverPending(identity, signal);
      return this.readByPeer(peerTetiId, identity, signal);
    });
  }

  request(peerTetiId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult> {
    return this.serial(async () => {
      const identity = await this.prepare(signal);
      const recovered = await this.recoverPending(identity, signal);
      if (recovered?.document.peerTetiId === peerTetiId) return recovered;
      const current = await this.readByPeer(peerTetiId, identity, signal);
      return this.executeNew({ operation: "request", peerTetiId }, current, identity, signal);
    });
  }

  accept(relationshipId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult> {
    return this.command(relationshipId, "accept", signal);
  }

  reject(relationshipId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult> {
    return this.command(relationshipId, "reject", signal);
  }

  block(relationshipId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult> {
    return this.command(relationshipId, "block", signal);
  }

  revoke(relationshipId: string, signal?: AbortSignal): Promise<TetiNetworkRelationshipResult> {
    return this.command(relationshipId, "revoke", signal);
  }

  private command(
    relationshipId: string,
    operation: TetiNetworkRelationshipCommand,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    return this.serial(async () => {
      const identity = await this.prepare(signal);
      const recovered = await this.recoverPending(identity, signal);
      if (recovered?.document.id === relationshipId) return recovered;
      const current = await this.client.getRelationship(
        relationshipId,
        identity.authentication,
        signal
      );
      this.assertProjection(current.document, identity.tetiId);
      return this.executeNew({ operation, relationshipId }, current, identity, signal);
    });
  }

  private async prepare(signal?: AbortSignal): Promise<AuthenticatedIdentity> {
    if (!this.compatible) {
      assertTetiNetworkCompatible(await this.client.getBootstrap(signal));
      this.compatible = true;
    }
    return this.getAuthentication();
  }

  private async scanSnapshot(
    identity: AuthenticatedIdentity,
    apply: (document: TetiNetworkRelationshipDocument) => Promise<void>,
    signal?: AbortSignal
  ): Promise<string> {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let baseCheckpoint: string | undefined;
    do {
      const page = await this.client.getRelationshipSnapshot(
        cursor ? { limit: 100, cursor } : { limit: 100 },
        identity.authentication,
        signal
      );
      if (baseCheckpoint && page.baseCheckpoint !== baseCheckpoint) {
        throw conflict(
          "relationship_reconciliation_snapshot",
          "Network Relationship snapshot checkpoint changed between pages."
        );
      }
      baseCheckpoint = page.baseCheckpoint;
      for (const document of page.items) {
        this.assertProjection(document, identity.tetiId);
        await apply(document);
      }
      cursor = page.page.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor)) {
        throw conflict(
          "relationship_reconciliation_snapshot",
          "Network Relationship snapshot cursor repeated."
        );
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (!baseCheckpoint) {
      throw conflict(
        "relationship_reconciliation_snapshot",
        "Network Relationship snapshot omitted its base checkpoint."
      );
    }
    return baseCheckpoint;
  }

  private async scanChanges(
    initialCheckpoint: string,
    identity: AuthenticatedIdentity,
    apply: (document: TetiNetworkRelationshipDocument) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const seenCheckpoints = new Set<string>();
    let checkpoint = initialCheckpoint;
    while (true) {
      if (seenCheckpoints.has(checkpoint)) {
        throw conflict(
          "relationship_reconciliation_changes",
          "Network Relationship changes checkpoint repeated."
        );
      }
      seenCheckpoints.add(checkpoint);
      const page = await this.client.getRelationshipChanges(
        { after: checkpoint, limit: 100 },
        identity.authentication,
        signal
      );
      if (page.page.hasMore && page.items.length === 0) {
        throw conflict(
          "relationship_reconciliation_changes",
          "Network Relationship changes reported an empty continuation page."
        );
      }
      for (const change of page.items) {
        this.assertProjection(change.relationship, identity.tetiId);
        await apply(change.relationship);
      }
      await this.reconciliationStore.save({
        schemaVersion: 1,
        tetiId: identity.tetiId,
        checkpoint: page.checkpoint
      });
      if (!page.page.hasMore) return;
      checkpoint = page.checkpoint;
    }
  }

  private async readByPeer(
    peerTetiId: string,
    identity: AuthenticatedIdentity,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult | null> {
    try {
      const result = await this.client.getRelationshipWithPeer(
        peerTetiId,
        identity.authentication,
        signal
      );
      this.assertProjection(result.document, identity.tetiId, peerTetiId);
      return result;
    } catch (error) {
      if (error instanceof TetiNetworkClientError && error.code === "RELATIONSHIP_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  private async executeNew(
    target:
      | { operation: "request"; peerTetiId: string }
      | { operation: TetiNetworkRelationshipCommand; relationshipId: string },
    current: TetiNetworkRelationshipResult | null,
    identity: AuthenticatedIdentity,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult> {
    const expectedRevision = target.operation === "request"
      && current?.document.state === "requested"
      && current.document.direction === "incoming"
      ? current.document.revision - 1
      : current?.document.revision ?? 0;
    const ifMatch = `"relationship-r${expectedRevision}"` as const;
    const body: TetiNetworkRequestRelationshipRequest | TetiNetworkMutateRelationshipRequest =
      target.operation === "request"
        ? { schemaVersion: 1, peerTetiId: target.peerTetiId, expectedRevision }
        : { schemaVersion: 1, expectedRevision };
    const pending: TetiNetworkPendingRelationshipCommand = {
      tetiId: identity.tetiId,
      operation: target.operation,
      ...(target.operation === "request"
        ? { peerTetiId: target.peerTetiId }
        : { relationshipId: target.relationshipId }),
      expectedRevision,
      ifMatch,
      idempotencyKey: this.idempotencyKeyFactory(target.operation),
      rawBody: JSON.stringify(body)
    };
    await this.store.save({ schemaVersion: 1, pending });
    return this.sendPending(pending, identity, signal, false);
  }

  private async recoverPending(
    identity: AuthenticatedIdentity,
    signal?: AbortSignal
  ): Promise<TetiNetworkRelationshipResult | null> {
    const stored = await this.store.load();
    if (!stored.pending) return null;
    if (stored.pending.tetiId !== identity.tetiId) {
      await this.store.save({ schemaVersion: 1 });
      return null;
    }
    return this.sendPending(stored.pending, identity, signal, true);
  }

  private async sendPending(
    pending: TetiNetworkPendingRelationshipCommand,
    identity: AuthenticatedIdentity,
    signal: AbortSignal | undefined,
    recovered: boolean
  ): Promise<TetiNetworkRelationshipResult> {
    try {
      const options = {
        ifMatch: pending.ifMatch,
        idempotencyKey: pending.idempotencyKey,
        rawBody: pending.rawBody,
        signal
      };
      const result = pending.operation === "request"
        ? await this.client.requestRelationship(
            JSON.parse(pending.rawBody) as TetiNetworkRequestRelationshipRequest,
            identity.authentication,
            options
          )
        : await this.client.mutateRelationship(
            pending.relationshipId!,
            pending.operation,
            JSON.parse(pending.rawBody) as TetiNetworkMutateRelationshipRequest,
            identity.authentication,
            options
          );
      this.assertProjection(result.document, identity.tetiId, pending.peerTetiId);
      await this.store.save({ schemaVersion: 1 });
      try {
        const latest = await this.client.getRelationship(
          result.document.id,
          identity.authentication,
          signal
        );
        this.assertProjection(latest.document, identity.tetiId, result.document.peerTetiId);
        return latest;
      } catch (error) {
        if (recovered) throw error;
        return result;
      }
    } catch (error) {
      if (error instanceof TetiNetworkClientError && !error.retryable) {
        await this.store.save({ schemaVersion: 1 });
      }
      if (error instanceof TetiNetworkClientError
        && error.code === "RELATIONSHIP_REVISION_CONFLICT") {
        try {
          if (pending.operation === "request") {
            await this.client.getRelationshipWithPeer(
              pending.peerTetiId!,
              identity.authentication,
              signal
            );
          } else {
            await this.client.getRelationship(
              pending.relationshipId!,
              identity.authentication,
              signal
            );
          }
        } catch {
          // Preserve the original stale-command error. This read only refreshes
          // Network observation; the caller must re-evaluate intent explicitly.
        }
      }
      throw error;
    }
  }

  private assertProjection(
    document: TetiNetworkRelationshipDocument,
    tetiId: string,
    expectedPeerTetiId?: string
  ): void {
    if ((document.requesterTetiId !== tetiId && document.addresseeTetiId !== tetiId)
      || document.requesterTetiId === document.addresseeTetiId
      || document.peerTetiId === tetiId
      || (expectedPeerTetiId && document.peerTetiId !== expectedPeerTetiId)
      || (document.direction === "outgoing" && document.requesterTetiId !== tetiId)
      || (document.direction === "incoming" && document.addresseeTetiId !== tetiId)) {
      throw conflict("relationship_get", "Network Relationship projection does not match the local identity.");
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

interface AuthenticatedIdentity {
  tetiId: string;
  authentication: TetiNetworkAuthenticatedSigner;
}

function conflict(
  operation:
    | "relationship_list"
    | "relationship_get"
    | "relationship_authorization"
    | "relationship_reconciliation_snapshot"
    | "relationship_reconciliation_changes",
  message: string
): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "NETWORK_CONFLICT",
    operation,
    message,
    retryable: false
  });
}
