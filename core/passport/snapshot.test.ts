import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimePassportSnapshot } from "./snapshot.ts";

test("runtime Passport snapshot keeps expiry at resource and remote Passport scope", () => {
  const snapshot: RuntimePassportSnapshot = {
    schemaVersion: 1,
    revision: 1,
    generatedAt: "2026-07-22T00:00:00.000Z",
    identity: null,
    localPassport: {
      schemaVersion: 1,
      generatedAt: "2026-07-22T00:00:00.000Z",
      resources: [],
      agents: [],
      capabilities: [],
      bindings: []
    },
    connections: [],
    sharing: {
      version: 1,
      audience: "confirmed_peers",
      resourceSummary: false,
      resourceQuota: false,
      agents: false,
      capabilities: false
    }
  };

  assert.equal("expiresAt" in snapshot, false);
  assert.deepEqual(snapshot.localPassport.agents, []);
  assert.deepEqual(snapshot.localPassport.capabilities, []);
});
