import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveIdentityQuery } from "../lifecycle-sidecar/connections.ts";
import type { TetiPublicDirectoryReader } from "../../../services/discovery/client.ts";
import type { TetiPublicDirectoryIdentity } from "../../../services/discovery/types.ts";
import {
  CONNECT_PANEL_CLOSE_MS,
  CONNECT_PANEL_OPEN_MS,
  CONNECT_PANEL_SUCCESS_MS,
  CONNECTION_DETAILS_TRANSITION_MS,
  PeerConnectionController,
  type PeerConnectionClient,
  type PeerConnectionCommandResult
} from "../src/connections/controller.ts";
import type { PassportConnectionSnapshot } from "../../../core/passport/snapshot.ts";
import type {
  PublicTetiIdentity
} from "../src/lifecycle-bridge/protocol.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { TauriNotchWindowController } from "../src/platform/tauri-notch-window.ts";

const identity: TetiPublicDirectoryIdentity = {
  version: 1,
  id: "teti_076bm9evq",
  address: "076bm9evq@mail.seep.im",
  displayName: "Remote",
  publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----remote-public-key-material-1234567890",
  publicProfile: { platform: "macOS" }
};

const emptyResult: TestCommandResult = { connections: [] };

test("peer identity input resolves the 9-character ID shown on teti.bot", async () => {
  const directory = new StaticDirectory([identity]);

  assert.equal((await resolveIdentityQuery("076bm9evq", directory)).address, identity.address);
  assert.equal((await resolveIdentityQuery("076BM9EVQ", directory)).publicKey, identity.publicKey);
});

test("peer identity input rejects prefixed IDs, addresses, links, and public keys", async () => {
  const directory = new StaticDirectory([identity]);

  for (const query of [
    "teti_076bm9evq",
    identity.address,
    "https://teti.bot/076bm9evq",
    identity.publicKey!
  ]) {
    await assert.rejects(() => resolveIdentityQuery(query, directory), /exactly 9/);
  }
});

test("peer identity input rejects unknown public data", async () => {
  await assert.rejects(
    () => resolveIdentityQuery("000000000", new StaticDirectory([identity])),
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
  assert.equal(controller.snapshot.connectPanel.messageCode, undefined);
});

test("confirmed peer details persist in controller state and Escape returns to the list row", () => {
  const { controller } = makeHarness();
  const connection = confirmedConnection("detail-peer");
  controller.syncPassportConnections([connection]);
  controller.open();

  controller.openDetails(connection.requestId);
  assert.equal(controller.snapshot.expandedRequestId, connection.requestId);
  assert.equal(controller.snapshot.open, true);
  assert.equal(controller.handleEscape(), true);
  assert.equal(controller.snapshot.expandedRequestId, undefined);
  assert.equal(controller.snapshot.open, true, "Escape closes details before the connection island");

  controller.openDetails(connection.requestId);
  controller.syncPassportConnections([]);
  assert.equal(controller.snapshot.expandedRequestId, undefined, "removed peers cannot leave orphaned details open");
});

test("inline details grow the native window before shrinking after the accordion transition", async () => {
  const { controller, scheduler, invoker } = makeHarness();
  const connection = confirmedConnection("detail-window-peer");
  controller.syncPassportConnections([connection]);
  controller.open();
  await flushPromises();
  invoker.calls.length = 0;

  controller.openDetails(connection.requestId);
  await flushPromises();
  assert.deepEqual(invoker.calls.at(-1), {
    command: "set_island_mode",
    args: { mode: "connection_detail", reason: "peer-details-open" }
  });

  controller.closeDetails();
  assert.equal(controller.snapshot.expandedRequestId, undefined);
  assert.equal(scheduler.hasDelay(CONNECTION_DETAILS_TRANSITION_MS), true);
  scheduler.runDelay(CONNECTION_DETAILS_TRANSITION_MS);
  await flushPromises();
  assert.deepEqual(invoker.calls.at(-1), {
    command: "set_island_mode",
    args: { mode: "onboarding", reason: "peer-details-close" }
  });
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
  assert.equal(controller.snapshot.connectPanel.messageCode, "invalid_public_id");
});

test("an incomplete ID never reaches the real connection client", async () => {
  const { controller, scheduler, client } = makeHarness();
  openEditor(controller, scheduler);
  controller.updateInput("abc123");

  await controller.connect();

  assert.deepEqual(client.requestCalls, []);
  assert.equal(controller.snapshot.connectPanel.state, "error");
  assert.equal(controller.snapshot.connectPanel.messageCode, "invalid_public_id");
});

test("a valid ID enters connecting immediately and duplicate submits are ignored", async () => {
  const deferred = new DeferredPeerConnectionClient();
  const { controller, scheduler } = makeHarness(deferred);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  const request = controller.connect();
  assert.equal(controller.snapshot.connectPanel.state, "connecting");
  assert.equal(controller.snapshot.connectPanel.messageCode, "connecting");
  assert.equal(controller.snapshot.busy, true);
  void controller.connect();
  assert.deepEqual(deferred.requestCalls, ["076bm9evq"]);

  deferred.finish(emptyResult);
  await request;
  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.messageCode, "request_sent");
});

test("connecting defers outside focus loss without interrupting the request", async () => {
  const deferred = new DeferredPeerConnectionClient();
  const diagnostics: Array<{ event: string }> = [];
  const { controller, scheduler } = makeHarness(deferred, (entry) => diagnostics.push(entry));
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
  assert.equal(controller.snapshot.open, false);
  assert.deepEqual(diagnostics.map(({ event }) => event), [
    "panel.dismiss.deferred",
    "panel.dismiss.resolved"
  ]);
});

test("focus regain cancels a deferred connection dismissal", async () => {
  const deferred = new DeferredPeerConnectionClient();
  const { controller, scheduler } = makeHarness(deferred);
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");
  const request = controller.connect();

  controller.dismissFromOutside();
  controller.cancelPendingOutsideDismiss();
  deferred.finish(emptyResult);
  await request;

  assert.equal(controller.snapshot.open, true);
});

test("a mutually confirmed request shows true success then automatically returns to idle", async () => {
  const connection = confirmedConnection("mutual-request");
  const result = withOutcome(connection, "mutualConfirmed");
  const { controller, scheduler } = makeHarness(new StaticPeerConnectionClient(result));
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.messageCode, "connected");
  assert.equal(controller.snapshot.highlightedRequestId, connection.requestId);
  assert.equal(controller.snapshot.connections.length, 1);
  scheduler.runDelay(CONNECT_PANEL_SUCCESS_MS);
  assert.equal(controller.snapshot.connectPanel.state, "closing");
  scheduler.runDelay(CONNECT_PANEL_CLOSE_MS);
  assert.equal(controller.snapshot.connectPanel.state, "idle");
  assert.equal(controller.snapshot.input, "");
  assert.equal(controller.snapshot.connectPanel.messageCode, undefined);
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
  assert.equal(controller.snapshot.connectPanel.messageCode, "connection_failed");
  assert.equal(controller.snapshot.input, "076bm9evq");
  assert.equal(controller.snapshot.busy, false);

  await controller.connect();
  assert.equal(client.requestCalls.length, 2);
  assert.equal(controller.snapshot.connectPanel.state, "success");
});

test("known timeout and lookup errors map only from trustworthy error codes", async () => {
  for (const [name, expected] of [
    ["REQUEST_TIMEOUT", "connection_timeout"],
    ["CONNECTION_RESOLVE_FAILED", "identity_not_found"]
  ] as const) {
    const error = new Error(name);
    error.name = name;
    const { controller, scheduler } = makeHarness(new SequencedPeerConnectionClient([error]));
    openEditor(controller, scheduler);
    controller.updateInput("076bm9evq");

    await controller.connect();

    assert.equal(controller.snapshot.connectPanel.state, "error");
    assert.equal(controller.snapshot.connectPanel.messageCode, expected);
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
  assert.equal(controller.snapshot.connectPanel.messageCode, "already_connected");
  assert.equal(controller.snapshot.connections.length, 1);
});

test("an outgoing request is acknowledged without falsely claiming the peer is connected", async () => {
  const connection: PassportConnectionSnapshot = {
    ...confirmedConnection("waiting-request"),
    connectionState: "Requested"
  };
  const { controller, scheduler } = makeHarness(
    new StaticPeerConnectionClient(withOutcome(connection, "alreadyRequested"))
  );
  openEditor(controller, scheduler);
  controller.updateInput("076bm9evq");

  await controller.connect();

  assert.equal(controller.snapshot.connectPanel.state, "success");
  assert.equal(controller.snapshot.connectPanel.messageCode, "request_sent");
  assert.notEqual(controller.snapshot.connectPanel.messageCode, "connected");
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

test("reopening an open connection island reasserts its native mode", async () => {
  const invoker = new RecordingTauriInvoker();
  let renders = 0;
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient(emptyResult),
    notchWindow: new TauriNotchWindowController(invoker),
    onChange: () => { renders += 1; }
  });

  controller.open();
  await new Promise<void>((resolve) => setImmediate(resolve));
  invoker.calls.length = 0;
  renders = 0;
  controller.open("dock-activate");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controller.snapshot.open, true);
  assert.equal(renders, 1);
  assert.deepEqual(invoker.calls, [{
    command: "set_island_mode",
    args: { mode: "onboarding", reason: "dock-activate" }
  }]);
  controller.dispose();
});

test("disposing the controller cancels opening, success, and collapse timers", async () => {
  const scheduler = new ControlledScheduler();
  const controller = new PeerConnectionController({
    client: new StaticPeerConnectionClient(emptyResult),
    notchWindow: new TauriNotchWindowController(new RecordingTauriInvoker()),
    onChange: () => undefined,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel
  });

  controller.open();
  controller.activateEyes();
  assert.ok(scheduler.size > 0);
  controller.dispose();
  assert.equal(scheduler.size, 0);
  scheduler.runAll();
  assert.equal(controller.snapshot.connectPanel.state, "opening");
});

test("connection UI keeps status inside the input and closes on clicks outside its controls", async () => {
  const [appSource, chineseCatalog, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/i18n/locales/zh-hans.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(appSource, /stage\.append\(face\);\s*\n\s*if \(panelState !== "idle"\)/);
  assert.doesNotMatch(appSource, /textContent\s*=\s*"连接另一个 Teti"/);
  assert.doesNotMatch(appSource, /还没有建联记录/);
  assert.match(appSource, /input\.placeholder = i18n\.messages\.connections\.panel\.placeholder/);
  assert.match(chineseCatalog, /placeholder: "\*{9}（teti\.bot 社区 9 位 ID）"/);
  assert.match(appSource, /maxLength = 9/);
  assert.match(appSource, /pasted\.trim\(\)/);
  assert.match(appSource, /aria-controls", "teti-connect-panel"/);
  assert.match(appSource, /aria-expanded/);
  assert.match(appSource, /messages\.connections\.panel\.connectAction/);
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

test("connection UI renders the complete semantic row list inside a bounded scroller", async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(appSource, /slice\(0,\s*3\)/);
  assert.match(appSource, /document\.createElement\("ul"\)/);
  assert.match(appSource, /document\.createElement\("li"\)/);
  assert.match(appSource, /teti-connection-disclosure/);
  assert.doesNotMatch(appSource, /•••/);
  assert.match(styles, /\.teti-connection-list\s*\{[\s\S]*max-height:\s*196px/);
  assert.match(styles, /\.teti-connection-list\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /Beta 0\.2\.1 connection-list integration:[\s\S]*\.teti-connection-row\.is-confirmed \.teti-connection-row-main\s*\{[\s\S]*height:\s*64px/);
  assert.match(styles, /\.teti-island--connections\.has-peer-details \.teti-connection-list\s*\{[\s\S]*max-height:/);
  assert.match(styles, /\.teti-pending-indicator\s*\{/);
  assert.match(styles, /data-has-notch="true"\]\s+\.teti-header\s*\{[\s\S]*grid-template-columns/);
  assert.match(styles, /data-has-notch="true"\]\s+\.teti-island--connections\s*\{[\s\S]*safe-top-inset/);
});

function makeHarness(
  client: PeerConnectionClient = new StaticPeerConnectionClient(emptyResult),
  diagnostic: ConstructorParameters<typeof PeerConnectionController>[0]["diagnostic"] = () => undefined
): {
  controller: PeerConnectionController;
  scheduler: ControlledScheduler;
  invoker: RecordingTauriInvoker;
  client: PeerConnectionClient & { requestCalls: string[] };
} {
  const scheduler = new ControlledScheduler();
  const invoker = new RecordingTauriInvoker();
  let controller: PeerConnectionController;
  controller = new PeerConnectionController({
    client,
    notchWindow: new TauriNotchWindowController(invoker),
    onChange: () => undefined,
    refreshPassport: async () => {
      const connections = (client as Partial<TestPeerConnectionClient>).connections ?? [];
      controller.syncPassportConnections(connections);
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    diagnostic
  });
  return {
    controller,
    scheduler,
    invoker,
    client: client as PeerConnectionClient & { requestCalls: string[] }
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function openEditor(controller: PeerConnectionController, scheduler: ControlledScheduler): void {
  controller.open();
  controller.activateEyes();
  assert.equal(controller.snapshot.connectPanel.state, "opening");
  scheduler.runDelay(CONNECT_PANEL_OPEN_MS);
  assert.equal(controller.snapshot.connectPanel.state, "editing");
}

function confirmedConnection(requestId: string): PassportConnectionSnapshot {
  return {
    requestId,
    connectionState: "Confirmed",
    direction: "outgoing",
    identity: {
      tetiId: identity.id,
      address: identity.address,
      displayName: identity.displayName
    },
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z",
    lastSeen: null,
    passport: { state: "unknown", resources: [], agents: [] }
  };
}

function withOutcome(
  connection: PassportConnectionSnapshot,
  kind: NonNullable<PeerConnectionCommandResult["requestOutcome"]>["kind"]
): TestCommandResult {
  return {
    connections: [connection],
    requestOutcome: {
      kind,
      requestId: connection.requestId,
      remoteTetiId: connection.identity.tetiId
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

class StaticDirectory implements TetiPublicDirectoryReader {
  private readonly identities: TetiPublicDirectoryIdentity[];

  constructor(identities: TetiPublicDirectoryIdentity[]) {
    this.identities = identities;
  }

  async discover(): Promise<TetiPublicDirectoryIdentity[]> {
    return this.identities;
  }

  async getIdentity(id: string): Promise<TetiPublicDirectoryIdentity | null> {
    return this.identities.find((item) => item.id === id) ?? null;
  }
}

interface TestCommandResult extends PeerConnectionCommandResult {
  connections: PassportConnectionSnapshot[];
}

interface TestPeerConnectionClient extends PeerConnectionClient {
  connections: PassportConnectionSnapshot[];
}

class StaticPeerConnectionClient implements TestPeerConnectionClient {
  readonly requestCalls: string[] = [];
  readonly connections: PassportConnectionSnapshot[];
  private readonly requestResult: TestCommandResult;

  constructor(requestResult: TestCommandResult) {
    this.requestResult = requestResult;
    this.connections = structuredClone(requestResult.connections);
  }

  async resolve(_query: string): Promise<PublicTetiIdentity> {
    return identity;
  }

  async request(query: string): Promise<PeerConnectionCommandResult> {
    this.requestCalls.push(query);
    return this.requestResult;
  }

  async accept(_requestId: string): Promise<void> { return undefined; }
  async reject(_requestId: string): Promise<void> { return undefined; }
}

class SequencedPeerConnectionClient extends StaticPeerConnectionClient {
  private readonly sequence: Array<TestCommandResult | Error>;

  constructor(sequence: Array<TestCommandResult | Error>) {
    super(emptyResult);
    this.sequence = [...sequence];
  }

  override async request(query: string): Promise<PeerConnectionCommandResult> {
    this.requestCalls.push(query);
    const next = this.sequence.shift() ?? emptyResult;
    if (next instanceof Error) throw next;
    return next;
  }
}

class DeferredPeerConnectionClient extends StaticPeerConnectionClient {
  private resolveRequest?: (result: PeerConnectionCommandResult) => void;

  constructor() {
    super(emptyResult);
  }

  override request(query: string): Promise<PeerConnectionCommandResult> {
    this.requestCalls.push(query);
    return new Promise((resolve) => {
      this.resolveRequest = resolve;
    });
  }

  finish(result: PeerConnectionCommandResult): void {
    assert.ok(this.resolveRequest, "expected a pending request");
    this.resolveRequest(result);
    this.resolveRequest = undefined;
  }
}
