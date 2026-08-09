import assert from "node:assert/strict";
import test from "node:test";
import { assertTetiNetworkCompatible } from "./compatibility.ts";
import { TetiNetworkClientError } from "./errors.ts";
import type { TetiNetworkBootstrap } from "./types.ts";

test("Beta 0.3.5 requires Revision 6 Relationship, PublicProfile, Presence, Identity, and Public Read capabilities", () => {
  assert.doesNotThrow(() => assertTetiNetworkCompatible(bootstrap()));
});

test("compatibility rejects a different protocol or older contract revision", () => {
  assertIncompatible({ ...bootstrap(), protocolVersion: 2 });
  assertIncompatible({ ...bootstrap(), contractRevision: 5 });
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
    contractRevision: 6,
    service: { name: "teti-network", version: "0.1.5" },
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
      relayBindings: false,
      invites: false
    },
    presencePolicy: presencePolicy()
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
