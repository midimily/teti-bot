import assert from "node:assert/strict";
import test from "node:test";
import { formatResetAt } from "../src/ai-status/view.ts";

test("Codex reset time uses the compact month/day and 24-hour format", () => {
  assert.equal(formatResetAt("2026-07-25T14:26:00"), "7/25 14:26 重置");
  assert.equal(formatResetAt(null), "重置时间暂不可用");
  assert.equal(formatResetAt("not-a-date"), "重置时间暂不可用");
});
