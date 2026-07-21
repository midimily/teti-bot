import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveIdentityQuery } from "../lifecycle-sidecar/connections.ts";
import type { TetiRegistryReader } from "../../../services/discovery/client.ts";
import type { DiscoveryIdentity } from "../../../services/discovery/registry-client.ts";
import {
  CONNECT_PANEL_CLOSE_MS,
  CONNECT_PANEL_OPEN_MS,
  CONNECT_PANEL_SUCCESS_MS,
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

const emptyResult: PeerConnectionResult = {
  connections: [],
  receivedCount: 0,
  heartbeatCount: 0
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

test("controller starts with the connect panel idle and opens it only through the eyes", () => {
  const { controller, scheduler } = makeHarness();

  assert.equal(controller.snapshot.connectPanel.state, "idle");
  assert.equal(controller.snapshot.input, "");
  controller.open();
  assert.equal(controller.snapshot.connectPanel.state, "idle");
  controller.activateEyes();
  assert.equal(controller.snapshot.connectPanel.state, "opening");
  scheduler.runDelay(CONNECT_PANEL_OPEN_MS);
  assert.equal(controller.snapshot.connectPanel.state, "editing");
  assert.equal(controller.snapshot.connectPanel.message, "");
});

test("peer identity input trims pasted-style whitespace, folds case, and caps at 9 characters", () => {
  const { controller, scheduler } = makeHarness();
  openEditor(controller, scheduler);

  controller.updateInput("  ABC123XYZ-more  ");
  assert.equal(controller.snapshot.input, "abc123xyz");
  assert.equal(controller.snapshot.connectPanel.state, "editing");

  controller.updateInput("abc-12345");
  assert.equal(controller.snapshot.input, "abc-12345");
  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.snapshot.connectPanel.message, "请输入正确的 9 位 ID");
});

test("an incomplete ID never reaches the real connection client", async () => {
  const { controller, scheduler, client } = makeHarness();
  openEditor(controller, scheduler);
  controller.updateInput("abc123");

  await controller.connect();

  assert.deepEqual(client.requestCalls, []);
  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.snapshot.connectPanel.message, "请输入正确的 9 位 ID");
});

test("a valid ID enters connecting immediately and duplicate submits are ignored", async () => {
  const deferred = new DeferredPeerConnectionClient();
  const { controller, scheduler } = makeHarness(deferred);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  const request = controller.connect();
  assert.equal(controller.snapshot.connectPanel.state, "connecting");
  assert.equal(controller.snapshot.connectPanel.message, "正在建立连接…");
  assert.equal(controller.snapshot.busy, true);
  void controller.connect();
  assert.deepEqual(deferred.requestCalls, ["076bm9evq"]);

  deferred.finish(emptyResult);
  await request;
  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.message, "建联请求已发送");
});

test("connecting cannot be closed by eyes, Escape, or outside focus loss", async () => {
  const deferred = new DeferredPeerConnectionClient();
  const { controller, scheduler } = makeHarness(deferred);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");
  const request = controller.connect();

  controller.activateEyes();
  assert.equal(controller.handleEscape(), true);
  controller.dismissFromOutside();
  assert.equal(controller.snapshot.open, true);
  assert.equal(controller.snapshot.connectPanel.state, "connecting");

  deferred.finish(emptyResult);
  await request;
});

test("a mutually confirmed request shows true success then automatically returns to idle", async () => {
  const connection = confirmedConnection("mutual-request");
  const result = withOutcome(connection, "mutualConfirmed");
  const { controller, scheduler } = makeHarness(new StaticPeerConnectionClient(result));
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.message, "已成功建联");
  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.connections.length, 1);
  scheduler.runDelay(CONNECT_PANEL_SUCCESS_MS);
  assert.equal(controller.snapshot.connectPanel.state, "closing");
  scheduler.runDelay(CONNECT_PANEL_CLOSE_MS);
  assert.equal(controller.snapshot.connectPanel.state, "idle");
  assert.equal(controller.snapshot.input, "");
  assert.equal(controller.snapshot.connectPanel.message, "");
});

test("success can be closed early with Escape", async () => {
  const connection = confirmedConnection("success-escape");
  const { controller, scheduler } = makeHarness(
    new StaticPeerConnectionClient(withOutcome(connection, "mutualConfirmed"))
  );
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");
  await controller.connect();

  assert.equal(controller.handleEscape(), true);
  assert.equal(controller.snapshot.connectPanel.state, "closing");
  assert.equal(scheduler.hasDelay(CONNECT_PANEL_SUCCESS_MS), false);
  scheduler.runDelay(CONNECT_PANEL_CLOSE_MS);
  assert.equal(controller.snapshot.connectPanel.state, "idle");
});

test("failed connection keeps the input, restores editing, and can retry", async () => {
  const error = new Error("safe unified failure");
  error.name = "CONNECTION_REQUEST_FAILED";
  const client = new SequencedPeerConnectionClient([error, emptyResult]);
  const { controller, scheduler } = makeHarness(client);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.snapshot.connectPanel.message, "暂时无法完成建联，请稍后重试");
  assert.equal(controller.snapshot.input, "076bm9evq");
  assert.equal(controller.snapshot.busy, false);

  await controller.connect();
  assert.equal(client.requestCalls.length, 2);
  assert.equal(controller.snapshot.connectPanel.state, "success");
});

test("known timeout and lookup errors map only from trustworthy error codes", async () => {
  for (const [name, expected] of [
    ["REQUEST_TIMEOUT", "连接超时，请稍后重试"],
    ["CONNECTION_RESOLVE_FAILED", "没有找到这个 Teti，请检查 ID"]
  ] as const) {
    const error = new Error(name);
    error.name = name;
    const { controller, scheduler } = makeHarness(new SequencedPeerConnectionClient([error]));
    openEditor(controller, scheduler);
    controller.updateInput("076bm9evq");

    await controller.connect();

    assert.equal(controller.snapshot.connectPanel.state, "error");
    assert.equal(controller.snapshot.connectPanel.message, expected);
  }
});

test("an already-confirmed peer stays visible and returns a recoverable scoped error", async () => {
  const connection = confirmedConnection("confirmed-request");
  const client = new StaticPeerConnectionClient(withOutcome(connection, "alreadyConfirmed"));
  const { controller, scheduler } = makeHarness(client);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.deepEqual(client.requestCalls, ["076bm9evq"]);
  assert.equal(controller.snapshot.input, "076bm9evq");
  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.snapshot.connectPanel.message, "你们已经建联");
  assert.equal(controller.snapshot.connections.length, 1);
});

test("an outgoing request is acknowledged without falsely claiming the peer is connected", async () => {
  const connection: PeerConnectionDto = {
    ...confirmedConnection("waiting-request"),
    state: "Requested"
  };
  const { controller, scheduler } = makeHarness(
    new StaticPeerConnectionClient(withOutcome(connection, "alreadyRequested"))
  );
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.message, "建联请求已发送");
  assert.notEqual(controller.snapshot.connectPanel.message, "已成功建联");
});

test("editing and error close through the eyes or Escape and clear only after closing", async () => {
  const { controller, scheduler } = makeHarness();
  openEditor(controller, scheduler);
  controller.updateInput("abc123xyz");
  controller.activateEyes();
  assert.equal(controller.snapshot.connectPanel.state, "closing");
  controller.activateEyes();
  controller.handleEscape();
  assert.equal(controller.snapshot.connectPanel.state, "closing");
  scheduler.runDelay(CONNECT_PANEL_CLOSE_MS);
  assert.equal(controller.snapshot.connectPanel.state, "idle");
  assert.equal(controller.snapshot.input, "");

  controller.activateEyes();
  scheduler.runDelay(CONNECT_PANEL_OPEN_MS);
  controller.updateInput("too-short");
  await controller.connect();
  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.handleEscape(), true);
  scheduler.runDelay(CONNECT_PANEL_CLOSE_MS);
  assert.equal(controller.snapshot.connectPanel.state, "idle");
});

test("outside focus loss collapses the outer connection island when no request is running", async () => {
  const invoker = new RecordingTauriInvoker();
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient(emptyResult),
    notchWindow: new TauriNotchWindowController(invoker),
    onChange: () => undefined
  });

  controller.open();
  controller.dismissFromOutside();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controller.snapshot.open, false);
  assert.deepEqual(invoker.calls.at(-1), {
    command: "set_island_mode",
    args: { mode: "idle", reason: "peer-panel-focus-lost" }
  });
  controller.dispose();
});

test("disposing the controller cancels opening, success, collapse, and snapshot timers", async () => {
  const scheduler = new ControlledScheduler();
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient(emptyResult),
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  await controller.initialize();
  controller.open();
  controller.activateEyes();
  assert.ok(scheduler.size > 0);
  controller.dispose();
  assert.equal(scheduler.size, 0);
  scheduler.runAll();
  assert.equal(controller.snapshot.connectPanel.state, "opening");
});

test("connection UI keeps status inside the input and closes on clicks outside its controls", async () => {
  const [appSource, stateSource, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/connections/connect-panel-state.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(appSource, /stage\.append\(face\);\s*\n\s*if \(panelState !== "idle"\)/);
  assert.doesNotMatch(appSource, /textContent\s*=\s*"连接另一个 Teti"/);
  assert.doesNotMatch(appSource, /还没有建联记录/);
  assert.match(appSource, /input\.placeholder = CONNECT_PANEL_PLACEHOLDER/);
  assert.match(stateSource, /CONNECT_PANEL_PLACEHOLDER = "\*{9}（teti\.bot 社区9位ID）"/);
  assert.match(appSource, /maxLength = 9/);
  assert.match(appSource, /pasted\.trim\(\)/);
  assert.match(appSource, /aria-controls", "teti-connect-panel"/);
  assert.match(appSource, /aria-expanded/);
  assert.match(appSource, /aria-label", "建立连接"/);
  assert.match(appSource, /aria-live", "polite"/);
  assert.match(appSource, /inlineStatus\.textContent = hasInlineStatus/);
  assert.match(appSource, /target\.closest\("\.teti-connect-input-shell"\)/);
  assert.match(appSource, /target\.closest\("\.teti-connect-button"\)/);
  assert.doesNotMatch(appSource, /cancel\.textContent = "取消"/);
  assert.match(appSource, /focusAfterPanelExpansion\(input\)/);
  assert.doesNotMatch(styles, /\.teti-connect-message-slot/);
  assert.match(styles, /\.teti-connect-inline-status/);
  assert.match(styles, /@keyframes teti-connect-open/);
  assert.match(styles, /@keyframes teti-connect-close/);
  assert.match(styles, /@keyframes teti-connect-search/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("connection UI renders the complete existing card list inside a bounded scroller", async () => {
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

function makeHarness(client: PeerConnectionClient = new StaticPeerConnectionClient(emptyResult)): {
  controller: PeerConnectionController;
  scheduler: ControlledScheduler;
  client: PeerConnectionClient & { requestCalls: string[] };
} {
  const scheduler = new ControlledScheduler();
  const controller = new PeerConnectionController({
    client,
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });
  return {
    controller,
    scheduler,
    client: client as PeerConnectionClient & { requestCalls: string[] }
  };
}

function openEditor(controller: PeerConnectionController, scheduler: ControlledScheduler): void {
  controller.open();
  controller.activateEyes();
  assert.equal(controller.snapshot.connectPanel.state, "opening");
  scheduler.runDelay(CONNECT_PANEL_OPEN_MS);
  assert.equal(controller.snapshot.connectPanel.state, "editing");
}

function confirmedConnection(requestId: string): PeerConnectionDto {
  return {
    requestId,
    state: "Confirmed",
    direction: "outgoing",
    remoteTetiId: identity.id,
    remoteAddress: identity.address,
    remoteDisplayName: identity.displayName,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z"
  };
}

function withOutcome(
  connection: PeerConnectionDto,
  kind: NonNullable<PeerConnectionResult["requestOutcome"]>["kind"]
): PeerConnectionResult {
  return {
    connections: [connection],
    receivedCount: 0,
    heartbeatCount: 0,
    requestOutcome: {
      kind,
      requestId: connection.requestId,
      remoteTetiId: connection.remoteTetiId
    }
  };
}

class ControlledScheduler {
  private nextId = 1;
  private readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  readonly schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  readonly cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  get size(): number {
    return this.tasks.size;
  }

  hasDelay(delayMs: number): boolean {
    return [...this.tasks.values()].some((task) => task.delayMs === delayMs);
  }

  runDelay(delayMs: number): void {
    const entry = [...this.tasks.entries()].find(([, task]) => task.delayMs === delayMs);
    assert.ok(entry, `expected a scheduled ${delayMs}ms task`);
    const [id, task] = entry;
    this.tasks.delete(id);
    task.callback();
  }

  runAll(): void {
    for (const [id, task] of [...this.tasks.entries()]) {
      this.tasks.delete(id);
      task.callback();
    }
  }
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

  async list(): Promise<PeerConnectionResult> { return emptyResult; }
  async readSnapshot(): Promise<PeerConnectionResult> { return emptyResult; }
  async accept(_requestId: string): Promise<PeerConnectionResult> { return emptyResult; }
  async reject(_requestId: string): Promise<PeerConnectionResult> { return emptyResult; }
}

class SequencedPeerConnectionClient extends StaticPeerConnectionClient {
  private readonly sequence: Array<PeerConnectionResult | Error>;

  constructor(sequence: Array<PeerConnectionResult | Error>) {
    super(emptyResult);
    this.sequence = [...sequence];
  }

  override async request(query: string): Promise<PeerConnectionResult> {
    this.requestCalls.push(query);
    const next = this.sequence.shift() ?? emptyResult;
    if (next instanceof Error) throw next;
    return next;
  }
}

class DeferredPeerConnectionClient extends StaticPeerConnectionClient {
  private resolveRequest?: (result: PeerConnectionResult) => void;

  constructor() {
    super(emptyResult);
  }

  override request(query: string): Promise<PeerConnectionResult> {
    this.requestCalls.push(query);
    return new Promise((resolve) => {
      this.resolveRequest = resolve;
    });
  }

  finish(result: PeerConnectionResult): void {
    assert.ok(this.resolveRequest, "expected a pending request");
    this.resolveRequest(result);
    this.resolveRequest = undefined;
  }
}
