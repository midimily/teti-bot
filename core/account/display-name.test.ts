import assert from "node:assert/strict";
import test from "node:test";
import {
  countUnicodeCharacters,
  TETI_DISPLAY_NAME_MAX_CHARACTERS,
  truncateTetiDisplayName,
  validateTetiDisplayName
} from "./display-name.ts";

test("Teti display names accept one to ten Unicode characters", () => {
  assert.deepEqual(validateTetiDisplayName("  薄荷Teti123  "), {
    ok: true,
    value: "薄荷Teti123",
    characterCount: 9
  });
  assert.equal(validateTetiDisplayName("一二三四五六七八九十甲").ok, false);
  assert.equal(validateTetiDisplayName("  ").ok, false);
  assert.equal(validateTetiDisplayName("Mint\nTeti").ok, false);
});

test("Teti display name truncation does not split Unicode code points", () => {
  const input = "一二三四五六七八九十😀";
  const truncated = truncateTetiDisplayName(input);

  assert.equal(countUnicodeCharacters(truncated), TETI_DISPLAY_NAME_MAX_CHARACTERS);
  assert.equal(truncated, "一二三四五六七八九十");
});
