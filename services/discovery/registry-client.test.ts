import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TETI_REGISTRY_URL,
  RegistryDiscoveryClient,
  resolveTetiRegistryUrl
} from "./registry-client.ts";

test("registry URL defaults to the production Worker", () => {
  assert.equal(resolveTetiRegistryUrl({}), DEFAULT_TETI_REGISTRY_URL);
});

test("registry URL can use an HTTPS custom domain", () => {
  assert.equal(
    resolveTetiRegistryUrl({ TETI_REGISTRY_URL: " https://registry.teti.example/ " }),
    "https://registry.teti.example"
  );
  assert.doesNotThrow(() => new RegistryDiscoveryClient("http://localhost:8787"));
});

test("registry URL rejects unsafe or path-scoped public endpoints", () => {
  assert.throws(
    () => resolveTetiRegistryUrl({ TETI_REGISTRY_URL: "http://registry.teti.example" }),
    /must use HTTPS/
  );
  assert.throws(
    () => resolveTetiRegistryUrl({ TETI_REGISTRY_URL: "https://registry.teti.example/v1" }),
    /only the registry origin/
  );
});

test("registration treats an identical existing KV identity as idempotent success", async () => {
  const originalFetch = globalThis.fetch;
  const identity = {
    version: 1 as const,
    id: "teti_ukouq6gz8",
    address: "ukouq6gz8@mail.seep.im",
    publicKey: "public-key",
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
  };

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/register")) {
      return Response.json(
        { success: false, error: "IDENTITY_EXISTS", message: "Identity already exists." },
        { status: 409 }
      );
    }
    return Response.json({ success: true, data: identity });
  };

  try {
    const result = await new RegistryDiscoveryClient("https://registry.teti.example").registerIdentity(identity);
    assert.deepEqual(result, identity);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
