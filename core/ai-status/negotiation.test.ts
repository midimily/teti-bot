import assert from "node:assert/strict";
import test from "node:test";
import {
  selectAiStatusSchemaForPeer,
  TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS,
  validatePassportSchemaVersions
} from "./negotiation.ts";

test("the current Passport capability advertises only schema 4", () => {
  assert.deepEqual(TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS, [4]);
});

test("only explicitly compatible peers select the current Passport schema", () => {
  assert.equal(selectAiStatusSchemaForPeer(undefined), null);
  assert.equal(selectAiStatusSchemaForPeer([1, 4]), 4);
  assert.equal(selectAiStatusSchemaForPeer([3, 4]), 4);
});

test("an explicitly incompatible peer is not sent a speculative downgrade", () => {
  assert.equal(selectAiStatusSchemaForPeer([1, 2]), null);
  assert.equal(selectAiStatusSchemaForPeer([3]), null);
});

test("Passport capability lists are bounded, unique protocol versions", () => {
  assert.doesNotThrow(() => validatePassportSchemaVersions([4]));
  assert.doesNotThrow(() => validatePassportSchemaVersions([3, 4]));
  assert.throws(() => validatePassportSchemaVersions([]));
  assert.throws(() => validatePassportSchemaVersions([3, 3]));
  assert.throws(() => validatePassportSchemaVersions([0]));
  assert.throws(() => validatePassportSchemaVersions([256]));
});
