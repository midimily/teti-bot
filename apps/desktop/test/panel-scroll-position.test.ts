import assert from "node:assert/strict";
import test from "node:test";
import {
  capturePanelScrollPositions,
  restorePanelScrollPositions
} from "../src/panel-scroll-position.ts";

test("open header panel scroll survives a semantic global render", () => {
  const previous = panel("settings", 218, 0);
  const positions = capturePanelScrollPositions(rootWith(previous));
  const replacement = panel("settings", 0, 0);

  restorePanelScrollPositions(rootWith(replacement), positions, (callback) => callback());

  assert.equal(replacement.scrollTop, 218);
});

test("hidden and unkeyed panels do not create restoration state", () => {
  const hidden = panel("passport", 140, 0);
  hidden.hidden = true;
  const unkeyed = panel("", 90, 0);

  assert.deepEqual(capturePanelScrollPositions(rootWith(hidden, unkeyed)), []);
});

function panel(key: string, scrollTop: number, scrollLeft: number) {
  return {
    dataset: { scrollKey: key },
    hidden: false,
    isConnected: true,
    scrollTop,
    scrollLeft
  };
}

function rootWith(...panels: ReturnType<typeof panel>[]): ParentNode {
  return {
    querySelectorAll() {
      return panels;
    }
  } as unknown as ParentNode;
}
