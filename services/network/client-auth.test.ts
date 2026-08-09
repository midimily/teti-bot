import assert from "node:assert/strict";
import test from "node:test";
import { HttpTetiNetworkClient } from "./client.ts";
import { createTetiNetworkSigningKey } from "./signing.ts";
import { TetiNetworkClientError } from "./errors.ts";

const SERVER_REQUEST_ID = "4a4f2fd6-62a8-49fd-9215-e79527bfc281";
const rawBody = "{\"schemaVersion\":1,\"identityPublicKey\":\"ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg\",\"clientInstance\":{\"publicKey\":\"ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc\",\"platform\":\"macos\",\"appVersion\":\"0.3.2\"},\"identityAuthorization\":\"ed25519:48Ve6uwePA4rThP4oISc4_acw5M_zZOygqEVTktXdDj77OFlFGqMlSgzDbdRa84VOv5f8c8aH5yDrMIFmZctDg\",\"delivery\":{\"address\":\"vector@mail.seep.im\",\"publicKey\":null}}";
const requestBody = JSON.parse(rawBody);
const clientKey = createTetiNetworkSigningKey({
  privateSeed: "ed25519-seed:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  publicKey: "ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc"
});

test("signed register sends exact retained body and Contract Revision 3 headers", async () => {
  let captured: Request | undefined;
  const client = new HttpTetiNetworkClient({
    baseUrl: "http://127.0.0.1:8788",
    clientVersion: "0.3.2",
    clientPlatform: "macos",
    requestIdFactory: () => "55555555-5555-4555-8555-555555555555",
    nonceFactory: () => "oKGio6SlpqeoqaqrrK2urw",
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    fetchImpl: async (input, init) => {
      captured = new Request(input, init);
      return Response.json(registerResponse(), { status: 201, headers: contractHeaders() });
    }
  });

  const response = await client.registerIdentity(requestBody, clientKey, {
    idempotencyKey: "vector-register-0001",
    rawBody
  });

  assert.equal(captured?.url, "http://127.0.0.1:8788/v1/identity/register");
  assert.equal(captured?.headers.get("Teti-Pending-Key-ID"), "sha256:b8w41DubDjHZyh7OPVjANDcwae-4TmkDPdotNu4JdWI");
  assert.equal(captured?.headers.get("Teti-Client-Instance-ID"), null);
  assert.equal(captured?.headers.get("Teti-Idempotency-Key"), "vector-register-0001");
  assert.equal(captured?.headers.get("Teti-Auth-Timestamp"), "2026-08-08T12:00:00.000Z");
  assert.equal(captured?.headers.get("Teti-Auth-Nonce"), "oKGio6SlpqeoqaqrrK2urw");
  assert.equal(captured?.headers.get("Teti-Content-SHA256"), "raeKCbIIkbnKWvbvElTIYFfx3xrZ210hrHEfj0gt4bQ");
  assert.equal(captured?.headers.get("Teti-Signature"), "ed25519:eSRABA-xNYsXg9uSNDFtRvRt4E9AN9gk64FzwwMRf2TjyFGeqhhVbYYSiXoHveFPp60yu6LxSoYGlCPG5OgPAQ");
  assert.equal(await captured?.text(), rawBody);
  assert.equal(response.identity.tetiId, "teti_new000001");
  assert.equal(response.delivery.address, "vector@mail.seep.im");
});

test("signed auth errors map replay, revoked client, and idempotency conflicts", async () => {
  for (const [serverCode, status, expected] of [
    ["REQUEST_REPLAYED", 409, "REQUEST_REPLAYED"],
    ["NETWORK_CLIENT_REVOKED", 403, "NETWORK_CLIENT_REVOKED"],
    ["IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"]
  ] as const) {
    const client = new HttpTetiNetworkClient({
      baseUrl: "http://127.0.0.1:8788",
      clientVersion: "0.3.2",
      clientPlatform: "macos",
      requestIdFactory: () => "55555555-5555-4555-8555-555555555555",
      nonceFactory: () => "oKGio6SlpqeoqaqrrK2urw",
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      fetchImpl: async () => Response.json({
        error: { code: serverCode, message: "Rejected.", retryable: false },
        requestId: SERVER_REQUEST_ID
      }, { status, headers: contractHeaders() })
    });
    await assert.rejects(
      () => client.registerIdentity(requestBody, clientKey, {
        idempotencyKey: "vector-register-0001",
        rawBody
      }),
      (error) => error instanceof TetiNetworkClientError && error.code === expected
    );
  }
});

function registerResponse() {
  return {
    identity: {
      tetiId: "teti_new000001",
      identityPublicKey: "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
      status: "active",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z"
    },
    clientInstance: {
      id: "ci_AAAAAAAAAAAAAAAAAAAAAA",
      publicKey: clientKey.publicKey,
      platform: "macos",
      appVersion: "0.3.2",
      status: "active",
      createdAt: "2026-08-08T12:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null
    },
    delivery: { address: "vector@mail.seep.im", publicKey: null }
  };
}

function contractHeaders() {
  return {
    "Teti-Protocol-Version": "1",
    "Teti-Contract-Revision": "3",
    "X-Request-ID": SERVER_REQUEST_ID
  };
}
