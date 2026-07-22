import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TetiAccount } from "../../../core/account/model.ts";
import type { FirstLaunchSnapshot } from "../src/first-launch/state-machine.ts";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";
import { RecordingTauriInvoker } from "../src/platform/tauri-api.ts";
import { TauriNotchWindowController, visualModeForViewModel } from "../src/platform/tauri-notch-window.ts";
import { createDesktopAccountLifecycle } from "../src/provisioning/index.ts";
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
  assert.ok(selection.discoveryClient);
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
  const controller = new TauriNotchWindowController(invoker);

  const collapse = controller.setMode("idle", "auto-collapse");
  const reopen = controller.setMode("onboarding", "dock-activate");
  await Promise.all([collapse, reopen]);

  assert.deepEqual(invoker.calls, [
    { command: "set_island_mode", args: { mode: "onboarding", reason: "dock-activate" } }
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

function visualModeForSnapshot(snapshot: FirstLaunchSnapshot): string {
  return visualModeForViewModel(toFirstLaunchViewModel(snapshot));
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
