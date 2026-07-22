import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimePassportSnapshot } from "../../../core/passport/snapshot.ts";
import type { PassportSharingPolicy } from "../../../core/passport/types.ts";
import {
  PassportController,
  emptyPassportSnapshot,
  type PassportClient
} from "../src/passport/controller.ts";

test("one Passport controller reads the Runtime snapshot every three seconds", async () => {
  const client = new FakePassportClient();
  let scheduled: (() => void) | undefined;
  let delay = 0;
  const controller = new PassportController({
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
  assert.equal(client.getCalls, 1);
  assert.equal(delay, 3_000);
  scheduled?.();
  await flushPromises();
  assert.equal(client.getCalls, 2);
  controller.stop();
});

test("Passport sharing updates optimistically and rolls back on persistence failure", async () => {
  const client = new FakePassportClient();
  const controller = new PassportController({ client, onChange: () => undefined });

  await controller.setResourceSharing(true);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, true);
  assert.equal(controller.snapshot.passport.sharing.resourceQuota, true);

  client.failSet = true;
  await controller.setResourceSharing(false);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, true);
  assert.equal(controller.snapshot.sharingError, "Passport 分享设置暂时无法保存。");
});

test("rapid Passport sharing changes remain interactive and persist the latest intent", async () => {
  let finishFirst!: (snapshot: RuntimePassportSnapshot) => void;
  const client = new FakePassportClient();
  const calls: boolean[] = [];
  client.setSharing = (policy) => {
    calls.push(policy.resourceSummary);
    if (calls.length === 1) {
      return new Promise((resolve) => { finishFirst = resolve; });
    }
    client.snapshot.sharing = { ...policy };
    return Promise.resolve(structuredClone(client.snapshot));
  };
  const controller = new PassportController({ client, onChange: () => undefined });

  const first = controller.setResourceSharing(true);
  const latest = controller.setResourceSharing(false);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, false);
  assert.equal(controller.snapshot.sharingBusy, true);

  const firstSnapshot = structuredClone(client.snapshot);
  firstSnapshot.sharing = policy(true);
  finishFirst(firstSnapshot);
  await Promise.all([first, latest]);

  assert.deepEqual(calls, [true, false]);
  assert.equal(controller.snapshot.passport.sharing.resourceSummary, false);
  assert.equal(controller.snapshot.sharingBusy, false);
});

test("Passport controller owns toolbar panel state independently of data refresh", () => {
  const controller = new PassportController({
    client: new FakePassportClient(),
    onChange: () => undefined
  });
  controller.togglePanel("passport");
  assert.equal(controller.snapshot.openPanel, "passport");
  controller.togglePanel("sharing");
  assert.equal(controller.snapshot.openPanel, "sharing");
  controller.closePanel();
  assert.equal(controller.snapshot.openPanel, null);
});

class FakePassportClient implements PassportClient {
  getCalls = 0;
  failSet = false;
  snapshot = emptyPassportSnapshot(new Date("2026-07-22T00:00:00.000Z"));

  async getSnapshot(): Promise<RuntimePassportSnapshot> {
    this.getCalls += 1;
    return structuredClone(this.snapshot);
  }

  async setSharing(policyValue: PassportSharingPolicy): Promise<RuntimePassportSnapshot> {
    if (this.failSet) throw new Error("disk unavailable");
    this.snapshot.sharing = { ...policyValue };
    this.snapshot.revision += 1;
    return structuredClone(this.snapshot);
  }
}

function policy(enabled: boolean): PassportSharingPolicy {
  return {
    version: 1,
    audience: "confirmed_peers",
    resourceSummary: enabled,
    resourceQuota: enabled,
    agents: false,
    capabilities: false
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
