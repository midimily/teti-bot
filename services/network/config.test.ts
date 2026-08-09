import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TETI_NETWORK_BASE_URL,
  DEVELOPMENT_TETI_NETWORK_BASE_URL,
  resolveTetiNetworkBaseUrl
} from "./config.ts";

test("Network URL defaults to the production Teti Network origin", () => {
  assert.equal(resolveTetiNetworkBaseUrl({}), DEFAULT_TETI_NETWORK_BASE_URL);
});

test("Network URL accepts the loopback development environment", () => {
  const env = { TETI_NETWORK_BASE_URL: ` ${DEVELOPMENT_TETI_NETWORK_BASE_URL}/ ` };
  assert.equal(resolveTetiNetworkBaseUrl(env), DEVELOPMENT_TETI_NETWORK_BASE_URL);
});

test("Network URL rejects insecure or path-scoped public endpoints", () => {
  assert.throws(
    () => resolveTetiNetworkBaseUrl({ TETI_NETWORK_BASE_URL: "http://network.teti.bot" }),
    /must use HTTPS/
  );
  assert.throws(
    () => resolveTetiNetworkBaseUrl({ TETI_NETWORK_BASE_URL: "https://network.teti.bot/v1" }),
    /only the Network origin/
  );
  assert.throws(
    () => resolveTetiNetworkBaseUrl({ TETI_NETWORK_BASE_URL: "https://token@network.teti.bot" }),
    /only the Network origin/
  );
});
