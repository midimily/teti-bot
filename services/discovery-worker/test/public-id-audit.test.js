import assert from "node:assert/strict";
import test from "node:test";
import { auditRegistryKeyNames } from "../scripts/audit-kv-public-ids.mjs";

test("KV public ID audit separates canonical, uppercase, invalid, and colliding keys", () => {
  const report = auditRegistryKeyNames([
    "teti:teti_abc123xyz",
    "teti:teti_ABC123XYZ",
    "teti:teti_short",
    "other:key"
  ]);

  assert.equal(report.scanned, 4);
  assert.equal(report.canonical, 1);
  assert.deepEqual(report.uppercase, ["teti:teti_ABC123XYZ"]);
  assert.deepEqual(report.invalid, ["other:key", "teti:teti_short"]);
  assert.deepEqual(report.collisions, [{
    canonicalKey: "teti:teti_abc123xyz",
    variants: ["teti:teti_ABC123XYZ", "teti:teti_abc123xyz"]
  }]);
});
