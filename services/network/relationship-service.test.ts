import assert from "node:assert/strict";
import test from "node:test";
import { FakeTetiNetworkClient } from "./fake-client.ts";
import { TetiNetworkClientError } from "./errors.ts";
import { MemoryTetiNetworkRelationshipCommandStore } from "./relationship-command-store.ts";
import { TetiNetworkRelationshipService } from "./relationship-service.ts";
import { generateTetiNetworkSigningKey } from "./signing.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkMutateRelationshipRequest,
  TetiNetworkRelationshipCommand,
  TetiNetworkRelationshipDocument,
  TetiNetworkRelationshipResult,
  TetiNetworkRelationshipWriteOptions,
  TetiNetworkRequestRelationshipRequest
} from "./types.ts";

const SELF = "teti_aaaaaaaaa";
const PEER = "teti_bbbbbbbbb";
const RELATIONSHIP_ID = "rel_AAAAAAAAAAAAAAAAAAAAAA";
const authentication: TetiNetworkAuthenticatedSigner = {
  clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
  signingKey: generateTetiNetworkSigningKey()
};

test("Relationship service creates from revision zero and rereads authoritative state", async () => {
  const client = new StatefulRelationshipClient();
  const store = new MemoryTetiNetworkRelationshipCommandStore();
  const service = createService(client, store);

  const result = await service.request(PEER);

  assert.equal(result.document.id, RELATIONSHIP_ID);
  assert.equal(result.document.state, "requested");
  assert.equal(client.relationshipRequestCalls[0]?.input.expectedRevision, 0);
  assert.equal(client.relationshipRequestCalls[0]?.options.ifMatch, '"relationship-r0"');
  assert.equal(
    client.relationshipRequestCalls[0]?.options.rawBody,
    JSON.stringify({ schemaVersion: 1, peerTetiId: PEER, expectedRevision: 0 })
  );
  assert.equal(client.relationshipGetCalls.length, 1);
  assert.equal((await store.load()).pending, undefined);
});

test("Relationship service recovers the exact durable command after retryable failure", async () => {
  const client = new StatefulRelationshipClient();
  const store = new MemoryTetiNetworkRelationshipCommandStore();
  client.nextWriteError = new TetiNetworkClientError({
    code: "SERVER_UNAVAILABLE",
    operation: "relationship_request",
    message: "Unavailable.",
    retryable: true
  });
  await assert.rejects(() => createService(client, store).request(PEER), /Unavailable/);
  const pending = (await store.load()).pending;
  assert.ok(pending);

  await createService(client, store).synchronize();

  assert.equal(client.relationshipRequestCalls.length, 2);
  assert.equal(client.relationshipRequestCalls[1]?.options.idempotencyKey, pending.idempotencyKey);
  assert.equal(client.relationshipRequestCalls[1]?.options.rawBody, pending.rawBody);
  assert.equal(client.relationshipRequestCalls[1]?.options.ifMatch, pending.ifMatch);
  assert.equal((await store.load()).pending, undefined);
});

test("Relationship service refreshes but never replays a stale reject", async () => {
  const client = new StatefulRelationshipClient(relationship(1, "requested", "incoming"));
  const store = new MemoryTetiNetworkRelationshipCommandStore();
  client.nextWriteError = new TetiNetworkClientError({
    code: "RELATIONSHIP_REVISION_CONFLICT",
    operation: "relationship_reject",
    message: "Stale.",
    retryable: false,
    status: 412
  });

  await assert.rejects(
    () => createService(client, store).reject(RELATIONSHIP_ID),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "RELATIONSHIP_REVISION_CONFLICT"
  );

  assert.equal(client.relationshipMutationCalls.length, 1);
  assert.equal(client.relationshipGetCalls.length, 2);
  assert.equal((await store.load()).pending, undefined);
});

test("Relationship service discards historical idempotency receipts after a fresh GET", async () => {
  const client = new StatefulRelationshipClient(relationship(1, "requested", "incoming"));
  client.historicalWriteResult = result(relationship(1, "requested", "incoming"));
  client.nextStateAfterHistorical = relationship(2, "confirmed", "incoming");

  const accepted = await createService(
    client,
    new MemoryTetiNetworkRelationshipCommandStore()
  ).accept(RELATIONSHIP_ID);

  assert.equal(accepted.document.revision, 2);
  assert.equal(accepted.document.state, "confirmed");
});

test("Relationship service uses the request base revision for reciprocal convergence", async () => {
  const client = new StatefulRelationshipClient(relationship(1, "requested", "incoming"));

  const confirmed = await createService(
    client,
    new MemoryTetiNetworkRelationshipCommandStore()
  ).request(PEER);

  assert.equal(client.relationshipRequestCalls[0]?.input.expectedRevision, 0);
  assert.equal(client.relationshipRequestCalls[0]?.options.ifMatch, '"relationship-r0"');
  assert.equal(confirmed.document.id, RELATIONSHIP_ID);
  assert.equal(confirmed.document.state, "confirmed");
});

class StatefulRelationshipClient extends FakeTetiNetworkClient {
  current: TetiNetworkRelationshipDocument | null;
  nextWriteError: unknown = null;
  historicalWriteResult: TetiNetworkRelationshipResult | null = null;
  nextStateAfterHistorical: TetiNetworkRelationshipDocument | null = null;

  constructor(current: TetiNetworkRelationshipDocument | null = null) {
    super(bootstrap());
    this.current = current;
  }

  override async getRelationship(relationshipId: string): Promise<TetiNetworkRelationshipResult> {
    this.relationshipGetCalls.push(relationshipId);
    if (!this.current || this.current.id !== relationshipId) throw notFound();
    return result(this.current);
  }

  override async getRelationshipWithPeer(peerTetiId: string): Promise<TetiNetworkRelationshipResult> {
    this.relationshipPeerCalls.push(peerTetiId);
    if (!this.current || this.current.peerTetiId !== peerTetiId) throw notFound();
    return result(this.current);
  }

  override async requestRelationship(
    input: TetiNetworkRequestRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    this.relationshipRequestCalls.push({ input: structuredClone(input), options: { ...options } });
    this.throwNext();
    const reciprocal = this.current?.state === "requested"
      && this.current.direction === "incoming"
      && input.expectedRevision === this.current.revision - 1;
    this.current = relationship(
      (this.current?.revision ?? 0) + 1,
      reciprocal ? "confirmed" : "requested",
      reciprocal ? "incoming" : "outgoing"
    );
    return result(this.current);
  }

  override async mutateRelationship(
    relationshipId: string,
    command: TetiNetworkRelationshipCommand,
    input: TetiNetworkMutateRelationshipRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    options: TetiNetworkRelationshipWriteOptions
  ): Promise<TetiNetworkRelationshipResult> {
    this.relationshipMutationCalls.push({ relationshipId, command, input: structuredClone(input), options: { ...options } });
    this.throwNext();
    if (this.historicalWriteResult) {
      const historical = structuredClone(this.historicalWriteResult);
      this.historicalWriteResult = null;
      if (this.nextStateAfterHistorical) this.current = this.nextStateAfterHistorical;
      return historical;
    }
    const state = command === "accept" ? "confirmed" : command === "reject" ? "rejected" : command === "block" ? "blocked" : "revoked";
    this.current = relationship((this.current?.revision ?? 0) + 1, state, this.current?.direction ?? "incoming");
    return result(this.current);
  }

  private throwNext(): void {
    if (!this.nextWriteError) return;
    const error = this.nextWriteError;
    this.nextWriteError = null;
    throw error;
  }
}

function createService(
  client: StatefulRelationshipClient,
  store: MemoryTetiNetworkRelationshipCommandStore
): TetiNetworkRelationshipService {
  let key = 0;
  return new TetiNetworkRelationshipService({
    client,
    store,
    getAuthentication: async () => ({ tetiId: SELF, authentication }),
    idempotencyKeyFactory: (operation) => `relationship.${operation}:test-${++key}-000000000000`
  });
}

function relationship(
  revision: number,
  state: TetiNetworkRelationshipDocument["state"],
  direction: TetiNetworkRelationshipDocument["direction"]
): TetiNetworkRelationshipDocument {
  return {
    schemaVersion: 1,
    id: RELATIONSHIP_ID,
    revision,
    state,
    peerTetiId: PEER,
    requesterTetiId: direction === "outgoing" ? SELF : PEER,
    addresseeTetiId: direction === "outgoing" ? PEER : SELF,
    direction,
    blockedBy: state === "blocked" ? "self" : null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: `2026-08-09T00:0${revision}:00.000Z`,
    stateChangedAt: `2026-08-09T00:0${revision}:00.000Z`
  };
}

function result(document: TetiNetworkRelationshipDocument): TetiNetworkRelationshipResult {
  return { document: structuredClone(document), etag: `"relationship-r${document.revision}"` };
}

function notFound(): TetiNetworkClientError {
  return new TetiNetworkClientError({
    code: "RELATIONSHIP_NOT_FOUND",
    operation: "relationship_get",
    message: "Not found.",
    retryable: false,
    status: 404
  });
}

function bootstrap() {
  return {
    protocolVersion: 1,
    contractRevision: 6,
    service: { name: "teti-network" as const, version: "0.1.5" },
    serverTime: "2026-08-09T00:00:00.000Z",
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
