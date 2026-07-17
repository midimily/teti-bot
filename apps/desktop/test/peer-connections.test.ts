import assert from "node:assert/strict";
import test from "node:test";
import { resolveIdentityQuery } from "../lifecycle-sidecar/connections.ts";
import type { TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { DiscoveryIdentity } from "../../../services/discovery/registry-client.ts";
import {
  PeerConnectionController,
  type PeerConnectionClient
} from "../src/connections/controller.ts";
import type {
  PeerConnectionDto,
  PeerConnectionResult,
  PublicTetiIdentity
} from "../src/lifecycle-bridge/protocol.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { TauriNotchWindowController } from "../src/platform/tauri-notch-window.ts";

const identity: DiscoveryIdentity = {
  version: 1,
  id: "teti_076bm9evq",
  address: "076bm9evq@mail.seep.im",
  displayName: "Remote",
  publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----remote-public-key-material-1234567890",
  publicProfile: { platform: "macOS" }
};

test("peer identity input resolves the 9-character ID shown on teti.bot", async () => {
  const registry = new StaticRegistry([identity]);

  assert.equal((await resolveIdentityQuery("076bm9evq", registry)).address, identity.address);
  assert.equal((await resolveIdentityQuery("076BM9EVQ", registry)).publicKey, identity.publicKey);
});

test("peer identity input rejects prefixed IDs, addresses, links, and public keys", async () => {
  const registry = new StaticRegistry([identity]);

  for (const query of [
    "teti_076bm9evq",
    identity.address,
    "https://teti.bot/076bm9evq",
    identity.publicKey!
  ]) {
    await assert.rejects(() => resolveIdentityQuery(query, registry), /exactly 9/);
  }
});

test("peer identity input rejects unknown public data", async () => {
  await assert.rejects(
    () => resolveIdentityQuery("000000000", new StaticRegistry([identity])),
    /No public Teti identity matched/
  );
});

test("repeating a confirmed peer ID shows explicit feedback and highlights the relationship", async () => {
  const connection: PeerConnectionDto = {
    requestId: "confirmed-request",
    state: "Confirmed",
    direction: "outgoing",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    remoteDisplayName: identity.displayName,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
  const client = new StaticPeerConnectionClient({
    connections: [connection],
    receivedCount: 0,
    heartbeatCount: 0,
    requestOutcome: {
      kind: "alreadyConfirmed",
      requestId: connection.requestId,
      remoteTetiId: connection.remoteTetiId
    }
  });
  const controller = new PeerConnectionController({
    client,
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: () => 0
  });

  controller.updateInput("076bm9evq");
  await controller.connect();

  assert.deepEqual(client.requestCalls, ["076bm9evq"]);
  assert.equal(controller.snapshot.input, "");
  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.notice, "已经与 Remote 建联，无需再次发送邀请。");
  assert.equal(controller.snapshot.error, undefined);
});

class StaticRegistry implements TetiRegistryReader {
  private readonly identities: DiscoveryIdentity[];

  constructor(identities: DiscoveryIdentity[]) {
    this.identities = identities;
  }

  async discover(): Promise<DiscoveryIdentity[]> {
    return this.identities;
  }

  async getIdentity(id: string): Promise<DiscoveryIdentity | null> {
    return this.identities.find((item) => item.id === id) ?? null;
  }
}

class StaticPeerConnectionClient implements PeerConnectionClient {
  readonly requestCalls: string[] = [];
  private readonly requestResult: PeerConnectionResult;

  constructor(requestResult: PeerConnectionResult) {
    this.requestResult = requestResult;
  }

  async resolve(_query: string): Promise<PublicTetiIdentity> {
    return identity;
  }

  async request(query: string): Promise<PeerConnectionResult> {
    this.requestCalls.push(query);
    return this.requestResult;
  }

  async list(): Promise<PeerConnectionResult> { return this.emptyResult(); }
  async poll(): Promise<PeerConnectionResult> { return this.emptyResult(); }
  async accept(_requestId: string): Promise<PeerConnectionResult> { return this.emptyResult(); }
  async reject(_requestId: string): Promise<PeerConnectionResult> { return this.emptyResult(); }

  private emptyResult(): PeerConnectionResult {
    return { connections: [], receivedCount: 0, heartbeatCount: 0 };
  }
}
