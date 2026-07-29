import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PeerConnectionDto } from "../src/lifecycle-bridge/protocol.ts";
import { mapPeerConnection } from "../lifecycle-sidecar/runtime/passport/mappers.ts";
import {
  FilePeerProtocolCapabilityStore,
  MemoryPeerProtocolCapabilityStore
} from "../lifecycle-sidecar/runtime/passport/peer-capabilities.ts";

const PEER_ID = "teti_beta00002";

function peerWithProtocols(
  taskProtocolVersions?: number[],
  passportSchemaVersions?: number[]
): PeerConnectionDto {
  return {
    requestId: "request-beta-compatibility",
    state: "Confirmed",
    direction: "outgoing",
    remoteTetiId: PEER_ID,
    remoteAddress: "peer@example.test",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    remoteProtocolCapabilities: {
      collaborationProtocolEpoch: 2,
      ...(taskProtocolVersions ? { taskProtocolVersions } : {}),
      ...(passportSchemaVersions ? { passportSchemaVersions } : {}),
      observedAt: "2026-07-27T00:00:00.000Z"
    }
  };
}

test("Peer Passport protocol capabilities are stored independently and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-peer-protocol-"));
  const path = join(root, "peer-protocol-capabilities.json");
  try {
    const first = new FilePeerProtocolCapabilityStore(path);
    assert.equal(await first.observe({
      tetiId: PEER_ID,
      collaborationProtocolEpoch: 2,
      taskProtocolVersions: [5],
      passportSchemaVersions: [4],
      observedAt: "2026-07-27T01:00:00.000Z"
    }), true);

    const restarted = new FilePeerProtocolCapabilityStore(path);
    assert.deepEqual(await restarted.get(PEER_ID), {
      tetiId: PEER_ID,
      collaborationProtocolEpoch: 2,
      taskProtocolVersions: [5],
      passportSchemaVersions: [4],
      observedAt: "2026-07-27T01:00:00.000Z"
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, "utf8"), /token|password|address/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged and stale capability observations do not rewrite negotiation state", async () => {
  const store = new MemoryPeerProtocolCapabilityStore();
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [5],
    passportSchemaVersions: [4],
    observedAt: "2026-07-27T02:00:00.000Z"
  }), true);
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [5],
    passportSchemaVersions: [4],
    observedAt: "2026-07-27T02:05:00.000Z"
  }), false);
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [4],
    passportSchemaVersions: [2],
    observedAt: "2026-07-27T01:59:00.000Z"
  }), false);
  assert.deepEqual((await store.get(PEER_ID))?.passportSchemaVersions, [4]);
  assert.deepEqual((await store.get(PEER_ID))?.taskProtocolVersions, [5]);
});

test("a newer explicit capability change is normalized and persisted", async () => {
  const store = new MemoryPeerProtocolCapabilityStore();
  await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [5],
    passportSchemaVersions: [4],
    observedAt: "2026-07-27T02:00:00.000Z"
  });
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [5, 4],
    passportSchemaVersions: [4, 3],
    observedAt: "2026-07-27T03:00:00.000Z"
  }), true);
  assert.deepEqual((await store.get(PEER_ID))?.passportSchemaVersions, [3, 4]);
  assert.deepEqual((await store.get(PEER_ID))?.taskProtocolVersions, [4, 5]);
});

test("a delayed legacy epoch can never downgrade a peer that proved Beta 0.2", async () => {
  const store = new MemoryPeerProtocolCapabilityStore();
  await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    taskProtocolVersions: [5],
    passportSchemaVersions: [4],
    observedAt: "2026-07-27T02:00:00.000Z"
  });
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 1,
    observedAt: "2026-07-27T03:00:00.000Z"
  }), false);
  assert.equal((await store.get(PEER_ID))?.collaborationProtocolEpoch, 2);
});

test("peer compatibility requires the exact current Task and Passport protocols", () => {
  const now = new Date("2026-07-27T00:05:00.000Z");

  assert.equal(mapPeerConnection(peerWithProtocols([5], [4]), now).compatibility, "compatible");
  assert.equal(mapPeerConnection(peerWithProtocols([4], [4]), now).compatibility, "upgrade_required");
  assert.equal(mapPeerConnection(peerWithProtocols([5], [2]), now).compatibility, "upgrade_required");
  assert.equal(mapPeerConnection(peerWithProtocols(undefined, [4]), now).compatibility, "unknown");
});
