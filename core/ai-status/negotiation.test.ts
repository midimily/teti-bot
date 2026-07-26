import assert from "node:assert/strict";
import test from "node:test";
import { selectAiStatusSchemasForPeer } from "./negotiation.ts";
import type { RemoteAiStatusSnapshot } from "./types.ts";

test("unknown peers receive one compatibility payload and one current payload", () => {
  assert.deepEqual(selectAiStatusSchemasForPeer(undefined), [1, 3]);
});

test("known peers receive exactly their best observed schema", () => {
  assert.deepEqual(selectAiStatusSchemasForPeer(remote(1)), [1]);
  assert.deepEqual(selectAiStatusSchemasForPeer(remote(2)), [2]);
  assert.deepEqual(selectAiStatusSchemasForPeer(remote(3)), [3]);
});

function remote(schemaVersion: 1 | 2 | 3): RemoteAiStatusSnapshot {
  const base = {
    schemaVersion,
    sharing: "disabled" as const,
    generatedAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:30:00.000Z",
    receivedAt: "2026-07-26T00:00:01.000Z",
    tools: []
  };
  if (schemaVersion === 1) return base;
  if (schemaVersion === 2) return { ...base, schemaVersion, agents: [] };
  return { ...base, schemaVersion, agents: [], capabilities: [], bindings: [] };
}
