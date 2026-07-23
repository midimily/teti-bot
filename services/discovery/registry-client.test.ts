import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TETI_REGISTRY_URL,
  RegistryDiscoveryClient,
  RegistryClientError,
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
    displayName: "Milo",
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

test("registration rejects a success response that did not persist the display name", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    version: 1 as const,
    id: "teti_ukouq6gz8",
    address: "ukouq6gz8@mail.seep.im",
    displayName: "Milo",
    publicKey: "public-key",
    publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
  };

  globalThis.fetch = async () => Response.json({
    success: true,
    data: {
      ...payload,
      displayName: undefined
    }
  });

  try {
    await assert.rejects(
      () => new RegistryDiscoveryClient("https://registry.teti.example").registerIdentity(payload),
      (error) =>
        error instanceof Error &&
        error.name === "Error" &&
        "code" in error &&
        error.code === "REGISTRY_WRITE_NOT_CONFIRMED"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registry lookup treats only 404 as not registered", async () => {
  const client = new RegistryDiscoveryClient("https://registry.teti.example", {
    fetchImpl: async () => Response.json(
      { success: false, error: "NOT_FOUND" },
      { status: 404 }
    )
  });

  assert.equal(await client.getIdentity("teti_ukouq6gz8"), null);
});

test("registry classifies DNS failures as unreachable", async () => {
  const client = new RegistryDiscoveryClient("https://registry.teti.example", {
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND"
        })
      });
    }
  });

  await assert.rejects(
    () => client.getIdentity("teti_ukouq6gz8"),
    (error) => {
      assert.equal(error instanceof RegistryClientError, true);
      assert.equal((error as RegistryClientError).kind, "unreachable");
      assert.equal((error as RegistryClientError).code, "REG_DNS");
      assert.equal((error as RegistryClientError).retryable, true);
      return true;
    }
  );
});

test("registry enforces a bounded request timeout", async () => {
  const client = new RegistryDiscoveryClient("https://registry.teti.example", {
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return Response.json({});
    }
  });

  await assert.rejects(
    () => client.getIdentity("teti_ukouq6gz8"),
    (error) => {
      assert.equal(error instanceof RegistryClientError, true);
      assert.equal((error as RegistryClientError).kind, "unreachable");
      assert.equal((error as RegistryClientError).code, "REG_TIMEOUT");
      return true;
    }
  );
});

test("registry distinguishes a rejected request from an unreachable service", async () => {
  const client = new RegistryDiscoveryClient("https://registry.teti.example", {
    fetchImpl: async () => Response.json(
      { success: false, error: "INVALID_IDENTITY" },
      { status: 400 }
    )
  });

  await assert.rejects(
    () => client.registerIdentity({
      version: 1,
      id: "teti_ukouq6gz8",
      address: "ukouq6gz8@mail.seep.im",
      displayName: "Milo",
      publicProfile: { platform: "macOS", category: [], aiEnvironment: [] }
    }),
    (error) => {
      assert.equal(error instanceof RegistryClientError, true);
      assert.equal((error as RegistryClientError).kind, "rejected");
      assert.equal((error as RegistryClientError).retryable, false);
      return true;
    }
  );
});

test("registry treats rate limiting as retryable unreachability", async () => {
  const client = new RegistryDiscoveryClient("https://registry.teti.example", {
    fetchImpl: async () => Response.json(
      { success: false, error: "RATE_LIMITED" },
      { status: 429 }
    )
  });

  await assert.rejects(
    () => client.getIdentity("teti_ukouq6gz8"),
    (error) => {
      assert.equal(error instanceof RegistryClientError, true);
      assert.equal((error as RegistryClientError).kind, "unreachable");
      assert.equal((error as RegistryClientError).retryable, true);
      return true;
    }
  );
});
