import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeNetworkStateChangeDeduplicator } from "../lifecycle-sidecar/runtime/network/state-change.ts";

test("Runtime state changes emit once per actual Agent, Resource, Capability, and policy value", () => {
  const events: string[] = [];
  const changes = new RuntimeNetworkStateChangeDeduplicator({
    now: () => new Date("2026-08-09T10:00:00.000Z"),
    onChange: (event) => events.push(event.kind)
  });

  assert.equal(changes.record("agent", { installed: true, running: false }), true);
  assert.equal(changes.record("agent", { installed: true, running: false }), false);
  assert.equal(changes.record("resource", { remainingPercent: 40 }), true);
  assert.equal(changes.record("resource", { remainingPercent: 40 }), false);
  assert.equal(changes.record("capability", ["code-analysis"]), true);
  assert.equal(changes.record("capability", ["code-analysis"]), false);
  assert.equal(changes.record("share_policy", { resources: false }), true);
  assert.equal(changes.record("share_policy", { resources: false }), false);
  assert.deepEqual(events, ["agent", "resource", "capability", "share_policy"]);
});
