import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryRegistrationPayload, TetiAccount, TetiStatus } from "../../../core/account/model.ts";
import {
  FirstLaunchCoordinator,
  MemoryNotchWindowController,
  sanitizeError,
  type FirstLaunchAccountLifecycle
} from "../src/first-launch/index.ts";
import { toFirstLaunchViewModel } from "../src/first-launch/view-model.ts";

test("no account enters first-launch onboarding and expands notch panel", async () => {
  const lifecycle = new RecordingLifecycle();
  const notch = new MemoryNotchWindowController();
  const coordinator = new FirstLaunchCoordinator({ accountLifecycle: lifecycle, notchWindow: notch });

  const snapshot = await coordinator.initialize();

  assert.equal(snapshot.state, "welcome");
  assert.equal(notch.mode, "expanded");
  assert.deepEqual(notch.events, [{ type: "expanded", reason: "first-launch" }]);
});

test("valid existing account skips onboarding and collapses into idle", async () => {
  const account = createAccount("Milo");
  const lifecycle = new RecordingLifecycle({ storedAccount: account });
  const notch = new MemoryNotchWindowController();
  const coordinator = new FirstLaunchCoordinator({ accountLifecycle: lifecycle, notchWindow: notch });

  const snapshot = await coordinator.initialize();

  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.account?.id, account.id);
  assert.equal(lifecycle.createCalls.length, 0);
  assert.equal(notch.mode, "collapsed");
});

test("existing local account enters idle while Registry recovery stays in Runtime", async () => {
  const account = createAccount("Milo");
  const lifecycle = new RecordingLifecycle({ storedAccount: account, registered: false });
  const notch = new MemoryNotchWindowController();
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: notch,
    discoveryClient: new RecordingDiscovery()
  });

  const snapshot = await coordinator.initialize();

  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.account?.id, account.id);
  assert.equal(notch.mode, "collapsed");
});

test("invalid name is rejected before account creation", async () => {
  const lifecycle = new RecordingLifecycle();
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  await coordinator.initialize();
  const snapshot = await coordinator.submitName("   ");

  assert.equal(snapshot.state, "recoverable_error");
  assert.equal(snapshot.error?.kind, "invalid_name");
  assert.equal(lifecycle.createCalls.length, 0);
});

test("name longer than ten Unicode characters is rejected before relay creation", async () => {
  const lifecycle = new RecordingLifecycle();
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  await coordinator.initialize();
  const snapshot = await coordinator.submitName("一二三四五六七八九十甲");

  assert.equal(snapshot.state, "recoverable_error");
  assert.equal(snapshot.error?.kind, "invalid_name");
  assert.equal(snapshot.error?.message, "名字最多 10 个字符。");
  assert.equal(lifecycle.createCalls.length, 0);
});

test("duplicate submit is blocked while creation is in flight", async () => {
  const lifecycle = new RecordingLifecycle();
  const deferred = createDeferred<TetiAccount>();
  lifecycle.createHandler = async (name) => {
    const account = createAccount(name);
    lifecycle.storedAccount = account;
    return deferred.promise;
  };
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  await coordinator.initialize();
  const firstSubmit = coordinator.submitName("Milo");
  const secondSnapshot = await coordinator.submitName("Milo");

  assert.equal(secondSnapshot.state, "creating_identity");
  assert.equal(lifecycle.createCalls.length, 1);

  deferred.resolve(lifecycle.storedAccount as TetiAccount);
  const finalSnapshot = await firstSubmit;
  assert.equal(finalSnapshot.state, "ready");
});

test("provisioning success persists, reloads account, reaches ready, then collapses to idle", async () => {
  const lifecycle = new RecordingLifecycle();
  const scheduled: Array<() => void> = [];
  const notch = new MemoryNotchWindowController();
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: notch,
    schedule: (callback) => scheduled.push(callback),
    readyCollapseDelayMs: 1
  });

  await coordinator.initialize();
  const ready = await coordinator.submitName("  Milo  ");

  assert.equal(ready.state, "ready");
  assert.equal(ready.account?.displayName, "Milo");
  assert.equal(lifecycle.createCalls.length, 1);
  assert.deepEqual(lifecycle.createCalls, ["Milo"]);
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  assert.equal(coordinator.snapshot.state, "idle");
  assert.equal(notch.mode, "collapsed");
});

test("provisioning failure retains name and can retry", async () => {
  const lifecycle = new RecordingLifecycle();
  lifecycle.createHandler = async (name) => {
    if (lifecycle.createCalls.length === 1) {
      throw new Error("chatmail unavailable");
    }
    const account = createAccount(name);
    lifecycle.storedAccount = account;
    return account;
  };
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController(),
    schedule: () => undefined
  });

  await coordinator.initialize();
  const failed = await coordinator.submitName("Milo");
  assert.equal(failed.state, "recoverable_error");
  assert.equal(failed.nameInput, "Milo");
  assert.equal(failed.error?.kind, "chatmail_provisioning_failure");

  const retried = await coordinator.submitName();
  assert.equal(retried.state, "ready");
  assert.equal(lifecycle.createCalls.length, 2);
});

test("Chatmail provisioning diagnostics are visible as a compact setup failure code", async () => {
  const lifecycle = new RecordingLifecycle();
  lifecycle.createHandler = async () => {
    throw Object.assign(
      new Error("Chatmail account storage is already owned by another process."),
      { diagnosticCode: "CM_RPC_LOCKED" }
    );
  };
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  await coordinator.initialize();
  const snapshot = await coordinator.submitName("Milo");
  const viewModel = toFirstLaunchViewModel(snapshot);

  assert.equal(snapshot.error?.kind, "chatmail_provisioning_failure");
  assert.equal(snapshot.error?.diagnosticCode, "CM_RPC_LOCKED");
  assert.equal(viewModel.title, "Teti 需要一点时间 [CM-RPC]");
});

test("persistence failure never reaches ready", async () => {
  const lifecycle = new RecordingLifecycle();
  lifecycle.createHandler = async () => {
    throw new Error("storage write EACCES");
  };
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  await coordinator.initialize();
  const snapshot = await coordinator.submitName("Milo");

  assert.equal(snapshot.state, "fatal_error");
  assert.equal(snapshot.error?.kind, "local_persistence_failure");
});

test("a post-save failure still completes local initialization and leaves Registry to Runtime", async () => {
  const persistedAccount = createAccount("Milo");
  const lifecycle = new RecordingLifecycle();
  lifecycle.createHandler = async () => {
    lifecycle.storedAccount = persistedAccount;
    throw new Error("registry fetch failed");
  };
  const discovery = new RecordingDiscovery();
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController(),
    discoveryClient: discovery,
    schedule: () => undefined
  });

  await coordinator.initialize();
  const ready = await coordinator.submitName("Milo");
  assert.equal(ready.state, "ready");
  assert.equal(ready.error, undefined);
  assert.equal(ready.account?.id, persistedAccount.id);
  assert.equal(lifecycle.createCalls.length, 1);
  assert.equal(discovery.registerCalls.length, 0);
});

test("repeated initialization with an existing account does not create duplicate identities", async () => {
  const lifecycle = new RecordingLifecycle({ storedAccount: createAccount("Milo") });
  const coordinator = new FirstLaunchCoordinator({
    accountLifecycle: lifecycle,
    notchWindow: new MemoryNotchWindowController()
  });

  const snapshot = await coordinator.initialize();

  assert.equal(snapshot.state, "idle");
  assert.equal(lifecycle.createCalls.length, 0);
});

test("frontend error sanitization redacts secret-like values", () => {
  const sanitized = sanitizeError(
    new Error("failed password=abc123 token=secret-token privateKey should-not-leak")
  );

  assert.equal(
    sanitized.message,
    "failed password=[redacted] token=[redacted] private-key[redacted] should-not-leak"
  );
});

class RecordingLifecycle implements FirstLaunchAccountLifecycle {
  readonly createCalls: string[] = [];
  storedAccount: TetiAccount | null;
  createHandler?: (name: string) => Promise<TetiAccount>;
  private readonly registered: boolean;

  constructor(options: { storedAccount?: TetiAccount | null; registered?: boolean } = {}) {
    this.storedAccount = options.storedAccount ?? null;
    this.registered = options.registered ?? true;
  }

  async loadTetiAccount(): Promise<TetiAccount | null> {
    return this.storedAccount ? cloneAccount(this.storedAccount) : null;
  }

  async createTetiAccount(input: { name: string }): Promise<TetiAccount> {
    this.createCalls.push(input.name);
    if (this.createHandler) {
      return this.createHandler(input.name);
    }

    const account = createAccount(input.name);
    this.storedAccount = account;
    return cloneAccount(account);
  }

  async getTetiStatus(): Promise<TetiStatus> {
    return {
      exists: this.storedAccount !== null,
      registry: {
        state: this.storedAccount === null
          ? "unknown"
          : this.registered
            ? "registered"
            : "unreachable"
      },
      onlineStatus: "unknown"
    };
  }
}

class RecordingDiscovery {
  readonly registerCalls: DiscoveryRegistrationPayload[] = [];

  async registerIdentity(payload: DiscoveryRegistrationPayload): Promise<{
    version: 1;
    id: string;
    address: string;
    publicProfile: Record<string, unknown>;
  }> {
    this.registerCalls.push(payload);
    return {
      version: 1,
      id: payload.id,
      address: payload.address,
      publicProfile: payload.publicProfile
    };
  }
}

function createAccount(displayName: string): TetiAccount {
  return {
    version: 1,
    id: `teti_${displayName.toLowerCase()}`,
    address: `${displayName.toLowerCase()}@mail.seep.im`,
    displayName,
    chatmailAccountId: 7,
    publicKey: "public-key",
    publicProfile: {
      platform: "macOS",
      category: ["developer"],
      aiEnvironment: ["Codex"]
    },
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}

function cloneAccount(account: TetiAccount): TetiAccount {
  return JSON.parse(JSON.stringify(account)) as TetiAccount;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
