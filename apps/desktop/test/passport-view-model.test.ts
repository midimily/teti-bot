import assert from "node:assert/strict";
import test from "node:test";
import { emptyPassportSnapshot } from "../src/passport/controller.ts";
import {
  formatLocalTetiIdentity,
  formatResetAt,
  toPassportViewModel
} from "../src/passport/view-model.ts";

test("Passport reset time uses the compact month/day and 24-hour format", () => {
  assert.equal(formatResetAt("2026-07-25T14:26:00"), "7/25 14:26 重置");
  assert.equal(formatResetAt(null), "重置时间暂不可用");
  assert.equal(formatResetAt("not-a-date"), "重置时间暂不可用");
});

test("Passport settings show the local Teti name and nine-character ID", () => {
  assert.equal(formatLocalTetiIdentity({
    tetiId: "teti_abc123xyz",
    address: "abc123xyz@mail.seep.im",
    displayName: "Max0717"
  }), "Max0717（abc123xyz）");
  assert.equal(formatLocalTetiIdentity(null), "暂不可用");

  const passport = emptyPassportSnapshot();
  passport.identity = {
    tetiId: "teti_abc123xyz",
    address: "abc123xyz@mail.seep.im",
    displayName: "Max0717"
  };
  const viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: "sharing" });
  assert.equal(viewModel.settings.identityLabel, "Max0717（abc123xyz）");
});

test("unknown, disabled, and stale remote Passport states use truthful product copy", () => {
  const passport = emptyPassportSnapshot();
  passport.connections = ["unknown", "disabled", "stale"].map((state, index) => ({
    requestId: String(index),
    connectionState: "Confirmed",
    direction: "incoming",
    identity: { tetiId: `teti_${index}`, address: `${index}@mail.seep.im` },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    lastSeen: null,
    passport: { state: state as "unknown" | "disabled" | "stale", resources: [] }
  }));
  const viewModel = toPassportViewModel({ passport, sharingBusy: false, openPanel: null });
  assert.deepEqual(viewModel.connections.map((item) => item.passport.note), [
    "暂无 AI Passport",
    "对方未分享 AI Passport",
    "AI Passport 已过期"
  ]);
});
