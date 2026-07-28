import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FilePeerProtocolCapabilityStore,
  MemoryPeerProtocolCapabilityStore
} from "../lifecycle-sidecar/runtime/passport/peer-capabilities.ts";

const PEER_ID = "teti_beta00002";

test("Peer Passport protocol capabilities are stored independently and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "teti-peer-protocol-"));
  const path = join(root, "peer-protocol-capabilities.json");
  try {
    const first = new FilePeerProtocolCapabilityStore(path);
    assert.equal(await first.observe({
      tetiId: PEER_ID,
      collaborationProtocolEpoch: 2,
      passportSchemaVersions: [3],
      observedAt: "2026-07-27T01:00:00.000Z"
    }), true);

    const restarted = new FilePeerProtocolCapabilityStore(path);
    assert.deepEqual(await restarted.get(PEER_ID), {
      tetiId: PEER_ID,
      collaborationProtocolEpoch: 2,
      passportSchemaVersions: [3],
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
    passportSchemaVersions: [3],
    observedAt: "2026-07-27T02:00:00.000Z"
  }), true);
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    passportSchemaVersions: [3],
    observedAt: "2026-07-27T02:05:00.000Z"
  }), false);
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    passportSchemaVersions: [2],
    observedAt: "2026-07-27T01:59:00.000Z"
  }), false);
  assert.deepEqual((await store.get(PEER_ID))?.passportSchemaVersions, [3]);
});

test("a newer explicit capability change is normalized and persisted", async () => {
  const store = new MemoryPeerProtocolCapabilityStore();
  await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    passportSchemaVersions: [3],
    observedAt: "2026-07-27T02:00:00.000Z"
  });
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    passportSchemaVersions: [4, 3],
    observedAt: "2026-07-27T03:00:00.000Z"
  }), true);
  assert.deepEqual((await store.get(PEER_ID))?.passportSchemaVersions, [3, 4]);
});

test("a delayed legacy epoch can never downgrade a peer that proved Beta 0.2", async () => {
  const store = new MemoryPeerProtocolCapabilityStore();
  await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 2,
    passportSchemaVersions: [3],
    observedAt: "2026-07-27T02:00:00.000Z"
  });
  assert.equal(await store.observe({
    tetiId: PEER_ID,
    collaborationProtocolEpoch: 1,
    observedAt: "2026-07-27T03:00:00.000Z"
  }), false);
  assert.equal((await store.get(PEER_ID))?.collaborationProtocolEpoch, 2);
});
