import assert from "node:assert/strict";
import test from "node:test";
import { resolveTetiBuildType } from "../scripts/build-flavor.ts";

test("Desktop build flavor defaults to development and requires an explicit release", () => {
  assert.equal(resolveTetiBuildType(undefined), "development");
  assert.equal(resolveTetiBuildType("dev"), "development");
  assert.equal(resolveTetiBuildType("release"), "release");
  assert.throws(() => resolveTetiBuildType("production"), /development or release/);
});
