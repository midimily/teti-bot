import assert from "node:assert/strict";
import test from "node:test";
import { TetiNetworkClientError } from "../../../services/network/errors.ts";
import type {
  TetiNetworkAuthenticatedSigner,
  TetiNetworkClient,
  TetiNetworkPresenceReportRequest,
  TetiNetworkPresenceReportResponse
} from "../../../services/network/types.ts";
import {
  RuntimePresencePolicyController,
  TETI_PRESENCE_INTERVALS_MS
} from "../lifecycle-sidecar/runtime/presence/controller.ts";

const AUTHENTICATION: TetiNetworkAuthenticatedSigner = {
  clientInstanceId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
  signingKey: {
    publicKey: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sign: () => "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  }
};

test("Runtime Presence policy owns all 5/5/15/30 second mode transitions", async () => {
  const clock = fakeClock();
  const network = new RecordingPresenceClient(clock.now);
  const controller = createController(network, clock);

  controller.start();
  await drain();
  assertReport(network.calls[0], "online", 1);
  assert.equal(clock.pendingDelays()[0], TETI_PRESENCE_INTERVALS_MS.online);

  controller.setForeground(false);
  await drain();
  assertReport(network.calls[1], "background", 2);
  assert.equal(clock.pendingDelays()[0], TETI_PRESENCE_INTERVALS_MS.background);

  controller.setPanelVisible(true);
  await drain();
  assertReport(network.calls[2], "viewing_connect", 3);
  assert.equal(clock.pendingDelays()[0], TETI_PRESENCE_INTERVALS_MS.viewing_connect);

  controller.setCollaborationActive(true);
  await drain();
  assertReport(network.calls[3], "collaborating", 4);
  assert.equal(network.calls[3]?.activityMarker, "collaboration_active");
  assert.equal(clock.pendingDelays()[0], TETI_PRESENCE_INTERVALS_MS.collaborating);

  for (const report of network.calls) {
    assert.deepEqual(Object.keys(report).sort(), [
      "activityMarker", "mode", "schemaVersion", "sequence", "sessionId"
    ]);
  }
  await controller.stop();
});

test("sleep stops Presence and wake reports immediately", async () => {
  const clock = fakeClock();
  const network = new RecordingPresenceClient(clock.now);
  const controller = createController(network, clock);
  controller.start();
  await drain();

  controller.setSleeping(true);
  assert.equal(controller.snapshot.state, "sleeping");
  assert.deepEqual(clock.pendingDelays(), []);
  await clock.advance(120_000);
  assert.equal(network.calls.length, 1);

  controller.setSleeping(false);
  assert.equal(controller.snapshot.state, "checking");
  await drain();
  assert.equal(network.calls.length, 2);
  assert.equal(controller.snapshot.state, "online");
  await controller.stop();
});

test("rapid signal changes coalesce behind one in-flight report", async () => {
  const clock = fakeClock();
  const network = new RecordingPresenceClient(clock.now);
  network.blockNext();
  const controller = createController(network, clock);
  controller.start();
  await drain();
  assert.equal(network.calls.length, 1);

  controller.setPanelVisible(true);
  controller.setCollaborationActive(true);
  controller.setForeground(false);
  assert.equal(network.calls.length, 1);
  network.releaseBlocked();
  await drain();

  assert.equal(network.calls.length, 2);
  assertReport(network.calls[1], "collaborating", 2);
  assert.equal(network.maximumInFlight, 1);
  await controller.stop();
});

test("retry backoff retains the exact Presence body and sequence", async () => {
  const clock = fakeClock();
  const network = new RecordingPresenceClient(clock.now);
  network.failures.push(new TetiNetworkClientError({
    code: "SERVER_UNAVAILABLE",
    operation: "presence_report",
    message: "temporarily unavailable",
    retryable: true
  }));
  const controller = createController(network, clock);
  controller.start();
  await drain();

  assert.equal(controller.snapshot.state, "unavailable");
  assert.deepEqual(clock.pendingDelays(), [5_000]);
  await clock.advance(5_000);
  assert.equal(network.calls.length, 2);
  assert.deepEqual(network.calls[1], network.calls[0]);
  assert.equal(controller.snapshot.state, "online");
  await controller.stop();
});

function createController(network: RecordingPresenceClient, clock: ReturnType<typeof fakeClock>) {
  return new RuntimePresencePolicyController({
    client: network as unknown as TetiNetworkClient,
    getAuthentication: async () => ({ tetiId: "teti_local0000", authentication: AUTHENTICATION }),
    now: clock.now,
    random: () => 0.5,
    sessionIdFactory: () => "ps_AAAAAAAAAAAAAAAAAAAAAA",
    schedule: clock.schedule,
    cancel: clock.cancel
  });
}

class RecordingPresenceClient {
  readonly calls: TetiNetworkPresenceReportRequest[] = [];
  readonly failures: unknown[] = [];
  maximumInFlight = 0;
  private inFlight = 0;
  private blocked?: { promise: Promise<void>; release: () => void };
  private blockedRelease?: () => void;
  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
  }

  blockNext(): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.blocked = { promise, release };
    this.blockedRelease = release;
  }

  releaseBlocked(): void {
    this.blockedRelease?.();
    this.blockedRelease = undefined;
  }

  async reportPresence(
    input: TetiNetworkPresenceReportRequest,
    _authentication: TetiNetworkAuthenticatedSigner,
    signal?: AbortSignal
  ): Promise<TetiNetworkPresenceReportResponse> {
    this.calls.push(structuredClone(input));
    this.inFlight += 1;
    this.maximumInFlight = Math.max(this.maximumInFlight, this.inFlight);
    try {
      const blocked = this.blocked;
      this.blocked = undefined;
      if (blocked) await blocked.promise;
      if (signal?.aborted) throw signal.reason;
      const failure = this.failures.shift();
      if (failure) throw failure;
      const reportedAt = this.now().toISOString();
      return {
        ...structuredClone(input),
        tetiId: "teti_local0000",
        reportedAt,
        expiresAt: new Date(this.now().getTime() + 45_000).toISOString(),
        expiresInSeconds: 45
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function assertReport(
  report: TetiNetworkPresenceReportRequest | undefined,
  mode: TetiNetworkPresenceReportRequest["mode"],
  sequence: number
): void {
  assert.equal(report?.mode, mode);
  assert.equal(report?.sequence, sequence);
}

function fakeClock() {
  let timestamp = Date.parse("2026-08-09T08:00:00.000Z");
  let nextHandle = 1;
  const entries = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => new Date(timestamp),
    schedule(callback: () => void, delayMs: number) {
      const handle = nextHandle++;
      entries.set(handle, { at: timestamp + delayMs, callback });
      return handle;
    },
    cancel(handle: unknown) {
      entries.delete(handle as number);
    },
    pendingDelays() {
      return [...entries.values()].map((entry) => entry.at - timestamp).sort((a, b) => a - b);
    },
    async advance(milliseconds: number) {
      const target = timestamp + milliseconds;
      while (true) {
        const next = [...entries.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        entries.delete(next[0]);
        timestamp = next[1].at;
        next[1].callback();
        await drain();
      }
      timestamp = target;
      await drain();
    }
  };
}

async function drain(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}
