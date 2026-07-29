import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTION_WINDOW_BASE_HEIGHT,
  resolveConnectionDetailLayout
} from "../src/connections/detail-layout.ts";

test("short Passport details keep the original connection window height", () => {
  assert.deepEqual(resolveConnectionDetailLayout(330, 92, 900), {
    windowHeight: CONNECTION_WINDOW_BASE_HEIGHT,
    detailViewportHeight: 92,
    detailConstrained: false,
    listConstrained: false
  });
});

test("connection details follow their measured content instead of a fixed 560px mode", () => {
  assert.equal(resolveConnectionDetailLayout(486, 238, 900).windowHeight, 486);
  assert.equal(resolveConnectionDetailLayout(704, 456, 900).windowHeight, 704);
});

test("waterfall expansion uses the screen before constraining only Passport details", () => {
  assert.deepEqual(resolveConnectionDetailLayout(1_098, 850, 900), {
    windowHeight: 876,
    detailViewportHeight: 628,
    detailConstrained: true,
    listConstrained: false
  });
});

test("extreme non-detail content reports the outer list as the last-resort constraint", () => {
  const layout = resolveConnectionDetailLayout(1_200, 200, 900);
  assert.equal(layout.windowHeight, 876);
  assert.equal(layout.detailViewportHeight, 0);
  assert.equal(layout.listConstrained, true);
});
