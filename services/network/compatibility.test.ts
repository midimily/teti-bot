import assert from "node:assert/strict";
import test from "node:test";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import { TetiNetworkClientError } from "./errors.ts";
import {
  BETA_036_NETWORK_REQUIREMENTS,
  type TetiNetworkBootstrap
} from "./types.ts";

test("Beta 0.3.8 requires Revision 8 RelayBinding authority", () => {
  assert.doesNotThrow(() => assertTetiNetworkCompatible(bootstrap()));
});

test("compatibility is not pinned to the tested teti-network service version", () => {
  assert.doesNotThrow(() => assertTetiNetworkCompatible({
    ...bootstrap(),
    service: { name: "teti-network", version: "0.1.99" }
  }));
});

test("Beta 0.3.6 requirements remain available only for regression fixtures", () => {
  assert.doesNotThrow(() => assertTetiNetworkCompatible({
    ...bootstrap(),
    contractRevision: 7,
    capabilities: { ...bootstrap().capabilities, relayBindings: false }
  }, BETA_036_NETWORK_REQUIREMENTS));
});

test("compatibility rejects a different protocol or older contract revision", () => {
  assertIncompatible({ ...bootstrap(), protocolVersion: 2 });
  assertIncompatible({ ...bootstrap(), contractRevision: 7 });
});

test("compatibility requires only the capabilities selected by a subversion", () => {
  assert.throws(
    () => assertTetiNetworkCompatible({
      ...bootstrap(),
      capabilities: { ...bootstrap().capabilities, relationships: false }
    }, {
      requiredProtocolVersion: 1,
      minimumContractRevision: 2,
      requiredCapabilities: ["relationships"]
    }),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PROTOCOL_UNSUPPORTED"
      && error.retryable === false
  );
});

function assertIncompatible(value: TetiNetworkBootstrap): void {
  assert.throws(
    () => assertTetiNetworkCompatible(value),
    (error) => error instanceof TetiNetworkClientError
      && error.code === "PROTOCOL_UNSUPPORTED"
      && error.operation === "bootstrap"
  );
}

function bootstrap(): TetiNetworkBootstrap {
  return {
    protocolVersion: 1,
    contractRevision: 8,
    service: { name: "teti-network", version: "0.1.8" },
    serverTime: "2026-08-08T00:00:00.000Z",
    protocolSupport: { minimumSupportedVersion: 1, supportedVersions: [1] },
    releasePolicy: {
      schemaVersion: 1,
      policyVersion: 1,
      channel: "beta",
      minimumSupportedVersion: "0.3.0",
      effectiveAt: "2026-08-08T00:00:00.000Z"
    },
    capabilities: {
      publicDirectory: true,
      identity: true,
      clientAuthentication: true,
      presence: true,
      publicProfile: true,
      relationships: true,
      relayBindings: true,
      invites: false
    },
    presencePolicy: presencePolicy(),
    relayBootstrap: {
      schemaVersion: 1,
      preferredRelay: {
        id: "relay_mail_seep_im",
        domain: "mail.seep.im",
        region: "osaka",
        accountProvisioning: { type: "chatmail_qr", value: "dcaccount:mail.seep.im" }
      },
      catalogPath: "/v1/relays"
    }
  };
}

function presencePolicy() {
  return {
    collaborating: { reportEverySeconds: 5, ttlSeconds: 20 },
    viewing_connect: { reportEverySeconds: 5, ttlSeconds: 20 },
    online: { reportEverySeconds: 15, ttlSeconds: 45 },
    background: { reportEverySeconds: 30, ttlSeconds: 90 }
  };
}
