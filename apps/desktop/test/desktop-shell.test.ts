import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import type { FirstLaunchSnapshot } from "../src/first-launch/state-machine.ts";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";
import { createDesktopI18n } from "../src/i18n/index.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "../src/platform/tauri-notch-window.ts";
import {
  createPanelDiagnosticSink,
  shouldPersistPanelDiagnostic
} from "../src/platform/panel-diagnostics.ts";
import { createDesktopAccountLifecycle } from "../src/provisioning/index.ts";
import { LifecycleBridgeClient } from "../src/provisioning/bridge-lifecycle.ts";
import { MockDesktopAccountLifecycle, MOCK_ACCOUNT_STORAGE_KEY } from "../src/provisioning/mock-lifecycle.ts";
import { readProvisioningMode } from "../src/provisioning/modes.ts";

test("desktop provisioning defaults to mock mode", () => {
  const config = readProvisioningMode({});

  assert.equal(config.mode, "mock");
  assert.equal(config.mockScenario, "success");
  assert.equal(config.delayMs, 450);
});

test("native desktop runtime defaults to real provisioning while tests stay mock", () => {
  assert.equal(readProvisioningMode({}, "real").mode, "real");
  assert.equal(readProvisioningMode({}).mode, "mock");
});

test("desktop provisioning only enters real mode when explicitly requested", () => {
  assert.equal(readProvisioningMode({ TETI_PROVISIONING_MODE: "real" }).mode, "real");
  assert.equal(readProvisioningMode({ TETI_PROVISIONING_MODE: "REAL" }).mode, "mock");
  assert.equal(readProvisioningMode({ TETI_PROVISIONING_MODE: "mock" }).mode, "mock");
});

test("desktop provisioning reads mock failure scenarios and delay", () => {
  const config = readProvisioningMode({
    VITE_TETI_MOCK_PROVISIONING_SCENARIO: "persistence_failure",
    VITE_TETI_MOCK_PROVISIONING_DELAY_MS: "25"
  });

  assert.equal(config.mode, "mock");
  assert.equal(config.mockScenario, "persistence_failure");
  assert.equal(config.delayMs, 25);
});

test("mock desktop lifecycle persists a created account in browser storage", async () => {
  const storage = new MemoryStorage();
  const previousLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = storage as Storage;

  try {
    const lifecycle = new MockDesktopAccountLifecycle({ scenario: "success", delayMs: 0 });
    const account = await lifecycle.createTetiAccount({ name: "Milo" });
    const reloaded = await new MockDesktopAccountLifecycle({ scenario: "success", delayMs: 0 }).loadTetiAccount();

    assert.equal(account.displayName, "Milo");
    assert.equal(reloaded?.id, account.id);
    assert.equal(JSON.parse(storage.getItem(MOCK_ACCOUNT_STORAGE_KEY) ?? "{}").displayName, "Milo");
  } finally {
    restoreGlobal("localStorage", previousLocalStorage);
  }
});

test("real desktop lifecycle requires the Tauri bridge and never falls back to mock", async () => {
  await assert.rejects(
    () => createDesktopAccountLifecycle({ TETI_PROVISIONING_MODE: "real" }),
    /requires the Tauri lifecycle bridge/
  );

  const invoker = new RecordingTauriInvoker();
  invoker.responses.set("lifecycle_request", {
    version: 1,
    id: "health",
    ok: true,
    result: { status: "ok", protocolVersion: 1, methods: ["lifecycle.health"] }
  });

  const selection = await createDesktopAccountLifecycle({ TETI_PROVISIONING_MODE: "real" }, invoker);

  assert.equal(selection.config.mode, "real");
  assert.equal(invoker.calls[0]?.command, "lifecycle_request");
  assert.ok(selection.lifecycle);
});

test("mock provisioning scenarios do not call real account creation", async () => {
  const invoker = new RecordingTauriInvoker();
  const selection = await createDesktopAccountLifecycle({
    TETI_PROVISIONING_MODE: "mock",
    TETI_MOCK_PROVISIONING_DELAY_MS: "0"
  }, invoker);

  const account = await selection.lifecycle.createTetiAccount({ name: "Milo" });

  assert.equal(selection.config.mode, "mock");
  assert.match(account.id, /^teti_mock_/);
  assert.equal(invoker.calls.length, 0);
});

test("real bridge lifecycle surfaces unavailable errors explicitly", async () => {
  const invoker = new RecordingTauriInvoker();
  invoker.responses.set("lifecycle_request", {
    version: 1,
    id: "health",
    ok: false,
    error: {
      code: "SIDECAR_UNAVAILABLE",
      message: "Teti's local lifecycle service is unavailable.",
      recoverable: true,
      retryTarget: "lifecycle.health"
    }
  });

  await assert.rejects(
    () => createDesktopAccountLifecycle({ TETI_PROVISIONING_MODE: "real" }, invoker),
    /local lifecycle service is unavailable/
  );
});

test("real bridge lifecycle loads existing account through Tauri and enters idle-ready data path", async () => {
  const account = createAccount("Milo");
  const invoker = new SequencedTauriInvoker([
    { version: 1, id: "health", ok: true, result: { status: "ok", protocolVersion: 1, methods: [] } },
    { version: 1, id: "load", ok: true, result: account }
  ]);
  const selection = await createDesktopAccountLifecycle({ TETI_PROVISIONING_MODE: "real" }, invoker);
  const loaded = await selection.lifecycle.loadTetiAccount();

  assert.equal(loaded?.id, account.id);
  assert.deepEqual(invoker.calls.map((call) => call.command), ["lifecycle_request", "lifecycle_request"]);
});

test("native local logout clears the profile before requesting an App restart", async () => {
  const invoker = new RecordingTauriInvoker();
  const bridge = new LifecycleBridgeClient(invoker);

  await bridge.logoutLocalProfile();

  assert.deepEqual(invoker.calls, [
    { command: "logout_local_profile", args: undefined },
    { command: "restart_application", args: undefined }
  ]);
});

test("tauri notch controller maps shell actions to bridge commands", async () => {
  const invoker = new RecordingTauriInvoker();
  const controller = new TauriNotchWindowController(invoker);

  await controller.expand("first-launch");
  await controller.setGeometry({ width: 430, height: 214, topInset: 10, displayId: "" });
  await controller.collapse("ready-to-idle");
  await controller.hide("test-hide");

  assert.deepEqual(invoker.calls, [
    { command: "set_island_mode", args: { mode: "onboarding", reason: "first-launch" } },
    {
      command: "position_island",
      args: { geometry: { width: 430, height: 214, topInset: 10, displayId: "", hasPhysicalNotch: undefined } }
    },
    { command: "set_island_mode", args: { mode: "idle", reason: "ready-to-idle" } },
    { command: "hide_island", args: { reason: "test-hide" } }
  ]);
});

test("notch mode updates coalesce before native dispatch and keep the latest mode", async () => {
  const invoker = new RecordingTauriInvoker();
  const diagnostics: Array<{ level: string; event: string; fields?: object }> = [];
  const controller = new TauriNotchWindowController(
    invoker,
    (entry) => diagnostics.push(entry)
  );

  const collapse = controller.setMode("idle", "auto-collapse");
  const reopen = controller.setMode("onboarding", "dock-activate");
  await Promise.all([collapse, reopen]);

  assert.deepEqual(invoker.calls, [
    { command: "set_island_mode", args: { mode: "onboarding", reason: "dock-activate" } }
  ]);
  assert.deepEqual(diagnostics.find(({ event }) => event === "panel.mode.collapse_superseded"), {
    level: "warn",
    event: "panel.mode.collapse_superseded",
    fields: {
      mode: "idle",
      reason: "auto-collapse",
      revision: 1,
      currentRevision: 2,
      replacementMode: "onboarding",
      replacementReason: "dock-activate"
    }
  });
});

test("panel diagnostics keep verbose events in development and only critical events in release", async () => {
  assert.equal(shouldPersistPanelDiagnostic("development", "debug"), true);
  assert.equal(shouldPersistPanelDiagnostic("development", "info"), true);
  assert.equal(shouldPersistPanelDiagnostic("release", "debug"), false);
  assert.equal(shouldPersistPanelDiagnostic("release", "info"), false);
  assert.equal(shouldPersistPanelDiagnostic("release", "warn"), true);
  assert.equal(shouldPersistPanelDiagnostic("release", "error"), true);

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const native = {
    runtime: "native" as const,
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return undefined as T;
    }
  };
  const diagnostic = createPanelDiagnosticSink(native, "release");
  diagnostic({ level: "debug", event: "panel.focus.changed" });
  diagnostic({
    level: "warn",
    event: "panel.dismiss.deferred",
    fields: { surface: "task", blocker: "busy" }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "write_panel_diagnostic");
  assert.deepEqual(
    (calls[0]?.args?.entry as { level: string; event: string; fields: object }),
    {
      occurredAt: (calls[0]?.args?.entry as { occurredAt: string }).occurredAt,
      level: "warn",
      event: "panel.dismiss.deferred",
      fields: { surface: "task", blocker: "busy" }
    }
  );
});

test("native panel mode failures emit a privacy-safe critical diagnostic", async () => {
  const diagnostics: Array<{ level: string; event: string; fields?: object }> = [];
  const controller = new TauriNotchWindowController({
    runtime: "test",
    async invoke(): Promise<never> {
      const error = new Error("private transport detail");
      error.name = "PANEL_INVOKE_FAILED";
      throw error;
    }
  }, (entry) => diagnostics.push(entry));

  await assert.rejects(() => controller.setMode("idle", "focus-lost"));

  assert.equal(diagnostics.at(-1)?.level, "error");
  assert.equal(diagnostics.at(-1)?.event, "panel.mode.failed");
  assert.deepEqual(diagnostics.at(-1)?.fields, {
    mode: "idle",
    reason: "focus-lost",
    revision: 1,
    errorKind: "PANEL_INVOKE_FAILED"
  });
  assert.equal(JSON.stringify(diagnostics).includes("private transport detail"), false);
});

test("measured connection detail height follows its active native mode", async () => {
  const invoker = new RecordingTauriInvoker();
  const controller = new TauriNotchWindowController(invoker);

  const open = controller.setMode("connection_detail", "peer-details-open");
  const resize = controller.setConnectionDetailHeight(704.4, "peer-details-measured");
  await Promise.all([open, resize]);

  assert.deepEqual(invoker.calls, [
    { command: "set_island_mode", args: { mode: "connection_detail", reason: "peer-details-open" } },
    {
      command: "set_connection_detail_height",
      args: { height: 704, reason: "peer-details-measured" }
    }
  ]);
});

test("recording Tauri bridge delivers Dock activation events", async () => {
  const invoker = new RecordingTauriInvoker();
  let activations = 0;
  const stop = await invoker.onDockActivate(() => { activations += 1; });

  invoker.emitDockActivate();
  stop();
  invoker.emitDockActivate();

  assert.equal(activations, 1);
});

test("recording Tauri bridge delivers system sleep and wake events", async () => {
  const invoker = new RecordingTauriInvoker();
  const events: string[] = [];
  const stopSleep = await invoker.onSystemSleep(() => events.push("sleep"));
  const stopWake = await invoker.onSystemWake(() => events.push("wake"));

  invoker.emitSystemSleep();
  invoker.emitSystemWake();
  stopSleep();
  stopWake();
  invoker.emitSystemSleep();
  invoker.emitSystemWake();

  assert.deepEqual(events, ["sleep", "wake"]);
});

test("view-model states map to desktop shell window modes", () => {
  assert.equal(visualModeForSnapshot({ state: "idle", nameInput: "", submitting: false }), "idle");
  assert.equal(visualModeForSnapshot({ state: "welcome", nameInput: "", submitting: false }), "onboarding");
  assert.equal(
    visualModeForSnapshot({
      state: "creating_identity",
      nameInput: "Milo",
      submitting: true,
      phase: "provisioning_chatmail"
    }),
    "processing"
  );
  assert.equal(
    visualModeForSnapshot({
      state: "recoverable_error",
      nameInput: "Milo",
      submitting: false,
      error: { kind: "chatmail_provisioning_failure", message: "Try again.", recoverable: true }
    }),
    "error"
  );
  assert.equal(
    visualModeForSnapshot({
      state: "ready",
      nameInput: "Milo",
      submitting: false,
      account: createAccount("Milo")
    }),
    "ready"
  );
});

test("Desktop consumes only the Runtime Passport read model and owns no network refresh schedule", async () => {
  const [appSource, bridgeSource, passportSource] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/provisioning/bridge-lifecycle.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/passport/controller.ts", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(appSource, /DiscoveryHeartbeat|discovery\.heartbeat/);
  assert.doesNotMatch(bridgeSource, /BridgeDiscoveryHeartbeatClient/);
  assert.doesNotMatch(passportSource, /usage\.(get|refresh)|connection\.poll|sharing\.get/);
  assert.match(passportSource, /passport\.get/);
});

test("Desktop global update lock is local-policy-owned rather than peer-owned", async () => {
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");

  assert.match(appSource, /releaseStatus\?\.state === "update_required"/);
  assert.doesNotMatch(appSource, /blockingPeerCompatibility|hasBlockingPeerCompatibility/);
  assert.match(appSource, /messages\.connections\.list\.compatibility\.upgradeHint/);
  assert.match(appSource, /messages\.connections\.list\.compatibility\.checking/);
});

function visualModeForSnapshot(snapshot: FirstLaunchSnapshot): string {
  return visualModeForViewModel(toFirstLaunchViewModel(snapshot, createDesktopI18n("zh-Hans")));
}

function createAccount(displayName: string): TetiAccount {
  const publicIdCode = "milo00000";
  return {
    version: 1,
    id: `teti_${publicIdCode}`,
    address: `${publicIdCode}@mail.seep.im`,
    displayName,
    chatmailAccountId: 1,
    publicKey: "public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Teti Desktop Shell Alpha"]
    },
    createdAt: new Date().toISOString()
  };
}

function restoreGlobal(name: "localStorage" | "window", previous: unknown): void {
  if (previous === undefined) {
    delete (globalThis as Record<string, unknown>)[name];
    return;
  }

  (globalThis as Record<string, unknown>)[name] = previous;
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class SequencedTauriInvoker {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return this.responses.shift() as T;
  }
}
