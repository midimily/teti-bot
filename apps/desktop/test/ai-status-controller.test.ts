import assert from "node:assert/strict";
import test from "node:test";
import type { AiStatusSharingSettings } from "../../../core/ai-status/types.ts";
import {
  AiStatusController,
  type AiStatusClient
} from "../src/ai-status/controller.ts";
import type { CodexUsageState } from "../src/codex-usage/types.ts";

test("controller only consumes cached Runtime usage every ten minutes", async () => {
  const client = new FakeClient();
  let scheduled: (() => void) | undefined;
  let delay = 0;
  let changes = 0;
  const controller = new AiStatusController({
    client,
    onChange: () => { changes += 1; },
    schedule(callback, delayMs) {
      scheduled = callback;
      delay = delayMs;
      return 1;
    },
    cancel: () => undefined
  });

  controller.start();
  await flushPromises();
  assert.equal(client.getCalls, 1);
  assert.equal(controller.snapshot.statusSharing, false);
  assert.equal(delay, 10 * 60 * 1_000);
  assert.ok(changes > 0);

  scheduled?.();
  await flushPromises();
  assert.equal(client.getCalls, 2);
  controller.stop();
});

test("controller retries only the initial Runtime snapshot while Codex refresh is still starting", async () => {
  const client = new FakeClient();
  client.usage = initialUsage();
  let scheduled: (() => void) | undefined;
  let delay = 0;
  const controller = new AiStatusController({
    client,
    onChange: () => undefined,
    schedule(callback, delayMs) {
      scheduled = callback;
      delay = delayMs;
      return 1;
    },
    cancel: () => undefined
  });

  controller.start();
  await flushPromises();
  assert.equal(delay, 3_000);

  client.usage = readyUsage();
  scheduled?.();
  await flushPromises();
  assert.equal(controller.snapshot.usage.status, "ready");
  assert.equal(delay, 10 * 60 * 1_000);
  assert.equal(client.getCalls, 2);
  controller.stop();
});

test("controller persists explicit sharing consent and reports failures without enabling", async () => {
  const client = new FakeClient();
  const controller = new AiStatusController({ client, onChange: () => undefined });

  await controller.setStatusSharing(true);
  assert.equal(controller.snapshot.statusSharing, true);

  client.failSet = true;
  await controller.setStatusSharing(false);
  assert.equal(controller.snapshot.statusSharing, true);
  assert.equal(controller.snapshot.sharingError, "共享设置暂时无法保存。");
});

test("sharing consent updates optimistically while persistence is pending", async () => {
  let finish!: (settings: AiStatusSharingSettings) => void;
  const client = new FakeClient();
  client.setSharing = (enabled) => new Promise((resolve) => {
    finish = resolve;
    client.sharing = enabled;
  });
  const controller = new AiStatusController({ client, onChange: () => undefined });

  const pending = controller.setStatusSharing(true);
  assert.equal(controller.snapshot.statusSharing, true);
  assert.equal(controller.snapshot.sharingBusy, true);
  finish({ statusSharing: true });
  await pending;
  assert.equal(controller.snapshot.sharingBusy, false);
});

test("rapid sharing changes stay interactive and persist only the latest intent", async () => {
  let finishFirst!: (settings: AiStatusSharingSettings) => void;
  const calls: boolean[] = [];
  const client = new FakeClient();
  client.setSharing = (enabled) => {
    calls.push(enabled);
    if (calls.length === 1) {
      return new Promise((resolve) => { finishFirst = resolve; });
    }
    client.sharing = enabled;
    return Promise.resolve({ statusSharing: enabled });
  };
  const controller = new AiStatusController({ client, onChange: () => undefined });

  const first = controller.setStatusSharing(true);
  const latest = controller.setStatusSharing(false);
  assert.equal(controller.snapshot.statusSharing, false);
  assert.equal(controller.snapshot.sharingBusy, true);

  finishFirst({ statusSharing: true });
  await Promise.all([first, latest]);

  assert.deepEqual(calls, [true, false]);
  assert.equal(controller.snapshot.statusSharing, false);
  assert.equal(controller.snapshot.sharingBusy, false);
});

test("a late initial settings read cannot overwrite a newer user choice", async () => {
  let finishRead!: (settings: AiStatusSharingSettings) => void;
  const client = new FakeClient();
  client.getSharing = () => new Promise((resolve) => { finishRead = resolve; });
  const controller = new AiStatusController({
    client,
    onChange: () => undefined,
    schedule: () => 1,
    cancel: () => undefined
  });

  controller.start();
  await controller.setStatusSharing(true);
  finishRead({ statusSharing: false });
  await flushPromises();

  assert.equal(controller.snapshot.statusSharing, true);
  controller.stop();
});

test("controller preserves the selected toolbar panel across data refreshes", async () => {
  const client = new FakeClient();
  let changes = 0;
  const controller = new AiStatusController({ client, onChange: () => { changes += 1; } });

  controller.togglePanel("status");
  assert.equal(controller.snapshot.openPanel, "status");
  controller.togglePanel("sharing");
  assert.equal(controller.snapshot.openPanel, "sharing");
  controller.togglePanel("sharing");
  assert.equal(controller.snapshot.openPanel, null);
  controller.togglePanel("status");
  const changesBeforeSilentClose = changes;
  controller.closePanel(false);
  assert.equal(controller.snapshot.openPanel, null);
  assert.equal(changes, changesBeforeSilentClose);
});

test("a settings read failure stays fail-closed without hiding local usage", async () => {
  const client = new FakeClient();
  client.failGetSharing = true;
  const controller = new AiStatusController({
    client,
    onChange: () => undefined,
    schedule: () => 1,
    cancel: () => undefined
  });

  controller.start();
  await flushPromises();
  assert.equal(controller.snapshot.usage.status, "ready");
  assert.equal(controller.snapshot.statusSharing, false);
  assert.equal(controller.snapshot.sharingError, "共享设置暂时无法读取。");
  controller.stop();
});

class FakeClient implements AiStatusClient {
  getCalls = 0;
  usage: CodexUsageState = readyUsage();
  sharing = false;
  failSet = false;
  failGetSharing = false;

  async getUsage(): Promise<CodexUsageState> {
    this.getCalls += 1;
    return structuredClone(this.usage);
  }

  async getSharing(): Promise<AiStatusSharingSettings> {
    if (this.failGetSharing) throw new Error("settings unavailable");
    return { statusSharing: this.sharing };
  }

  async setSharing(enabled: boolean): Promise<AiStatusSharingSettings> {
    if (this.failSet) throw new Error("disk unavailable");
    this.sharing = enabled;
    return { statusSharing: enabled };
  }
}

function initialUsage(): CodexUsageState {
  return {
    status: "unavailable",
    error: {
      code: "NOT_STARTED",
      message: "Runtime refresh is starting.",
      recoverable: true
    }
  };
}

function readyUsage(): CodexUsageState {
  return {
    status: "ready",
    snapshot: {
      source: "live",
      planTypeRaw: "plus",
      planDisplayName: null,
      membershipVerified: false,
      weekly: null,
      observedAt: "2026-07-18T01:00:00.000Z",
      fetchedAt: "2026-07-18T01:00:00.000Z",
      stale: false
    }
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
