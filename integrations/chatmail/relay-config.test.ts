import assert from "node:assert/strict";
import test from "node:test";
import {
  accountQrFromRelayDomain,
  assertAddressMatchesRelay,
  REQUIRED_REAL_VALIDATION_ADDRESS_SUFFIX,
  REQUIRED_REAL_VALIDATION_RELAY_DOMAIN,
  resolveChatmailRelayConfig,
  TETI_CHATMAIL_ACCOUNT_QR,
  TETI_CHATMAIL_RELAY_DOMAIN,
  validateRealValidationRelayConfig
} from "./relay-config.ts";

test("relay config defaults to mail.seep.im for normal provisioning", () => {
  const config = resolveChatmailRelayConfig({}, {});

  assert.equal(config.relayDomain, REQUIRED_REAL_VALIDATION_RELAY_DOMAIN);
  assert.equal(config.accountQr, "dcaccount:mail.seep.im");
  assert.equal(config.expectedAddressSuffix, REQUIRED_REAL_VALIDATION_ADDRESS_SUFFIX);
  assert.equal(config.explicitRelayDomain, false);
});

test("real validation relay config requires an explicit mail.seep.im domain", () => {
  const missing = validateRealValidationRelayConfig({});
  const wrong = validateRealValidationRelayConfig({
    [TETI_CHATMAIL_RELAY_DOMAIN]: "nine.testrun.org"
  });
  const valid = validateRealValidationRelayConfig({
    [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im"
  });

  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /TETI_CHATMAIL_RELAY_DOMAIN/);
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join(" "), /mail\.seep\.im/);
  assert.equal(valid.ok, true);
});

test("real validation rejects an explicit QR for another relay", () => {
  const report = validateRealValidationRelayConfig({
    [TETI_CHATMAIL_RELAY_DOMAIN]: "mail.seep.im",
    [TETI_CHATMAIL_ACCOUNT_QR]: "dcaccount:nine.testrun.org"
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join(" "), /dcaccount:mail\.seep\.im/);
});

test("relay QR and address suffix helpers are strict", () => {
  assert.equal(accountQrFromRelayDomain("MAIL.SEEP.IM"), "dcaccount:mail.seep.im");
  assert.doesNotThrow(() => assertAddressMatchesRelay("abc@mail.seep.im", "@mail.seep.im"));
  assert.throws(() => assertAddressMatchesRelay("abc@example.org", "@mail.seep.im"), /must end/);
});
