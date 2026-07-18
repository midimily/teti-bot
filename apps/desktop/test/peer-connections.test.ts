import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("peer identity input folds ASCII uppercase but reports invalid characters without deleting them", () => {
  const controller = makeController({ connections: [], receivedCount: 0, heartbeatCount: 0 });

  controller.updateInput("ABC123XYZ");
  assert.equal(controller.snapshot.input, "abc123xyz");
  assert.equal(controller.snapshot.inputError, undefined);

  controller.updateInput("abc-12345");
  assert.equal(controller.snapshot.input, "abc-12345");
  assert.equal(controller.snapshot.inputError, "ID 只能包含英文字母和数字。");

  controller.updateInput("abc123xyz!");
  assert.equal(controller.snapshot.input, "abc123xyz!");
  assert.equal(controller.snapshot.inputError, "ID 只能包含英文字母和数字。");
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

test("repeating a pending outgoing request keeps one request and emphasizes the wait state", async () => {
  const connection: PeerConnectionDto = {
    requestId: "waiting-request",
    state: "Requested",
    direction: "outgoing",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    remoteDisplayName: identity.displayName,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
  const controller = makeController({
    connections: [connection],
    receivedCount: 0,
    heartbeatCount: 0,
    requestOutcome: {
      kind: "alreadyRequested",
      requestId: connection.requestId,
      remoteTetiId: connection.remoteTetiId
    }
  });

  controller.updateInput("076bm9evq");
  await controller.connect();

  assert.equal(controller.snapshot.connections.length, 1);
  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.notice, "邀请已发送，正在等待 Remote 确认。");
  assert.equal(controller.snapshot.noticeTone, "attention");
});

test("mutual invitation shows a concise success state and highlights the confirmed peer", async () => {
  const connection: PeerConnectionDto = {
    requestId: "mutual-request",
    state: "Confirmed",
    direction: "incoming",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    remoteDisplayName: identity.displayName,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
  const controller = makeController({
    connections: [connection],
    receivedCount: 0,
    heartbeatCount: 0,
    requestOutcome: {
      kind: "mutualConfirmed",
      requestId: connection.requestId,
      remoteTetiId: connection.remoteTetiId
    }
  });

  controller.updateInput("076bm9evq");
  await controller.connect();

  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.notice, "双方均已发起邀请，已与 Remote 建联。");
  assert.equal(controller.snapshot.noticeTone, "success");
});

test("outside focus loss collapses an open connection panel even with pending approval", async () => {
  const pending: PeerConnectionDto = {
    requestId: "pending-request",
    state: "PendingApproval",
    direction: "incoming",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    remoteDisplayName: identity.displayName,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
  const invoker = new RecordingTauriInvoker();
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient({ connections: [pending], receivedCount: 1, heartbeatCount: 0 }),
    notchWindow: new TauriNotchWindowController(invoker),
    onChange: () => undefined,
    schedule: () => 0
  });

  await controller.connect();
  controller.open();
  controller.dismissFromOutside();

  assert.equal(controller.snapshot.open, false);
  assert.deepEqual(invoker.calls.at(-1), {
    command: "set_island_mode",
    args: { mode: "idle", reason: "peer-panel-focus-lost" }
  });
});

test("pending approval no longer disables the inactive auto-collapse timer", async () => {
  const pending: PeerConnectionDto = {
    requestId: "pending-timeout",
    state: "PendingApproval",
    direction: "incoming",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient({ connections: [pending], receivedCount: 1, heartbeatCount: 0 }),
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs })
  });

  await controller.connect();
  controller.open();
  scheduled.at(-1)?.callback();

  assert.equal(scheduled.at(-1)?.delayMs, 20_000);
  assert.equal(controller.snapshot.open, false);
});

test("connection UI renders the complete list inside a bounded vertical scroller", async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(appSource, /slice\(0,\s*3\)/);
  assert.match(styles, /\.teti-connection-list\s*\{[\s\S]*max-height:\s*138px/);
  assert.match(styles, /\.teti-connection-list\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /\.teti-pending-indicator\s*\{/);
  assert.match(styles, /data-has-notch="true"\]\s+\.teti-header\s*\{[\s\S]*grid-template-columns/);
  assert.match(styles, /data-has-notch="true"\]\s+\.teti-island--connections\s*\{[\s\S]*safe-top-inset/);
});

function makeController(result: PeerConnectionResult): PeerConnectionController {
  return new PeerConnectionController({
    client: new StaticPeerConnectionClient(result),
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: () => 0
  });
}

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
