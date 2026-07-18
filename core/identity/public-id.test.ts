import assert from "node:assert/strict";
import test from "node:test";
import {
  isCanonicalTetiChatmailAddress,
  isCanonicalTetiPublicId,
  normalizeTetiChatmailAddress,
  normalizeTetiPublicId,
  normalizeTetiPublicIdCode,
  tetiPublicIdFromAddress
} from "./public-id.ts";

test("public Teti IDs have one lowercase canonical form", () => {
  assert.equal(normalizeTetiPublicIdCode(" AbC123XyZ "), "abc123xyz");
  assert.equal(normalizeTetiPublicId(" TETI_AbC123XyZ "), "teti_abc123xyz");
  assert.equal(tetiPublicIdFromAddress("AbC123XyZ@mail.seep.im"), "teti_abc123xyz");
  assert.equal(normalizeTetiChatmailAddress(" AbC123XyZ@MAIL.SEEP.IM "), "abc123xyz@mail.seep.im");
  assert.equal(isCanonicalTetiPublicId("teti_abc123xyz"), true);
  assert.equal(
    isCanonicalTetiChatmailAddress("abc123xyz@mail.seep.im", "teti_abc123xyz"),
    true
  );
});

test("public Teti IDs reject non-ASCII, punctuation, and wrong lengths", () => {
  for (const value of ["abc12345", "abc1234567", "abc-12345", "abc_12345", "abc１２３xyz"]) {
    assert.throws(() => normalizeTetiPublicIdCode(value), /exactly 9 ASCII/);
  }
  assert.equal(isCanonicalTetiPublicId("teti_ABC123XYZ"), false);
  assert.equal(isCanonicalTetiPublicId("teti_abc-12345"), false);
  assert.throws(
    () => tetiPublicIdFromAddress("teti_abc123xyz@mail.seep.im"),
    /9-character ASCII/
  );
  assert.equal(
    isCanonicalTetiChatmailAddress("abc123xyz@mail.seep.im", "teti_different"),
    false
  );
});
