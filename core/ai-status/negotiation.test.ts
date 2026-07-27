import assert from "node:assert/strict";
import test from "node:test";
import {
  selectAiStatusSchemaForPeer,
  TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS,
  validatePassportSchemaVersions
} from "./negotiation.ts";

test("the current Passport capability advertises only schema 3", () => {
  assert.deepEqual(TETI_SUPPORTED_PASSPORT_SCHEMA_VERSIONS, [3]);
});

test("unknown and compatible peers select one current Passport schema", () => {
  assert.equal(selectAiStatusSchemaForPeer(undefined), 3);
  assert.equal(selectAiStatusSchemaForPeer([1, 3]), 3);
  assert.equal(selectAiStatusSchemaForPeer([3, 4]), 3);
});

test("an explicitly incompatible peer is not sent a speculative downgrade", () => {
  assert.equal(selectAiStatusSchemaForPeer([1, 2]), null);
  assert.equal(selectAiStatusSchemaForPeer([4]), null);
});

test("Passport capability lists are bounded, unique protocol versions", () => {
  assert.doesNotThrow(() => validatePassportSchemaVersions([3]));
  assert.doesNotThrow(() => validatePassportSchemaVersions([3, 4]));
  assert.throws(() => validatePassportSchemaVersions([]));
  assert.throws(() => validatePassportSchemaVersions([3, 3]));
  assert.throws(() => validatePassportSchemaVersions([0]));
  assert.throws(() => validatePassportSchemaVersions([256]));
});
