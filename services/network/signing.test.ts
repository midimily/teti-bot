import assert from "node:assert/strict";
import test from "node:test";
import {
  createCanonicalTetiNetworkRequest,
  createFirstClientAuthorization,
  createTetiNetworkSigningKey,
  pendingTetiNetworkKeyId,
  sha256Base64Url,
  verifyTetiNetworkSignature
} from "./signing.ts";

const root = createTetiNetworkSigningKey({
  privateSeed: "ed25519-seed:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  publicKey: "ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"
});
const client = createTetiNetworkSigningKey({
  privateSeed: "ed25519-seed:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  publicKey: "ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc"
});

const rawRegisterBody = "{\"schemaVersion\":1,\"identityPublicKey\":\"ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg\",\"clientInstance\":{\"publicKey\":\"ed25519:Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc\",\"platform\":\"macos\",\"appVersion\":\"0.3.2\"},\"identityAuthorization\":\"ed25519:48Ve6uwePA4rThP4oISc4_acw5M_zZOygqEVTktXdDj77OFlFGqMlSgzDbdRa84VOv5f8c8aH5yDrMIFmZctDg\",\"delivery\":{\"address\":\"vector@mail.seep.im\",\"publicKey\":null}}";

test("App reproduces Contract Revision 3 root and HTTP signing vectors byte-for-byte", () => {
  const rootAuthorization = createFirstClientAuthorization({
    operation: "register",
    tetiId: "",
    identityPublicKey: root.publicKey,
    clientPublicKey: client.publicKey,
    platform: "macos",
    appVersion: "0.3.2",
    deliveryAddress: "vector@mail.seep.im",
    transportPublicKey: null
  });
  assert.equal(rootAuthorization, [
    "teti-network-first-client-authorization-v1",
    "register",
    "",
    root.publicKey,
    client.publicKey,
    "macos",
    "0.3.2",
    "vector@mail.seep.im",
    ""
  ].join("\n"));
  assert.equal(
    root.sign(rootAuthorization),
    "ed25519:48Ve6uwePA4rThP4oISc4_acw5M_zZOygqEVTktXdDj77OFlFGqMlSgzDbdRa84VOv5f8c8aH5yDrMIFmZctDg"
  );
  assert.equal(
    pendingTetiNetworkKeyId(client.publicKey),
    "sha256:b8w41DubDjHZyh7OPVjANDcwae-4TmkDPdotNu4JdWI"
  );
  assert.equal(sha256Base64Url(rawRegisterBody), "raeKCbIIkbnKWvbvElTIYFfx3xrZ210hrHEfj0gt4bQ");

  const canonical = createCanonicalTetiNetworkRequest(registerFields());
  assert.equal(canonical, [
    "teti-network-request-v1",
    "POST",
    "/v1/identity/register",
    "1",
    "55555555-5555-4555-8555-555555555555",
    "sha256:b8w41DubDjHZyh7OPVjANDcwae-4TmkDPdotNu4JdWI",
    "vector-register-0001",
    "2026-08-08T12:00:00.000Z",
    "oKGio6SlpqeoqaqrrK2urw",
    "raeKCbIIkbnKWvbvElTIYFfx3xrZ210hrHEfj0gt4bQ"
  ].join("\n"));
  assert.equal(
    client.sign(canonical),
    "ed25519:eSRABA-xNYsXg9uSNDFtRvRt4E9AN9gk64FzwwMRf2TjyFGeqhhVbYYSiXoHveFPp60yu6LxSoYGlCPG5OgPAQ"
  );

  const exactQuery = createCanonicalTetiNetworkRequest({
    method: "GET",
    exactPathAndQuery: "/v1/identity/self?b=%2F&a=hello%20world&a=%E2%9C%93",
    protocolVersion: 1,
    clientRequestId: "66666666-6666-4666-8666-666666666666",
    principalId: "ci_AAAAAAAAAAAAAAAAAAAAAA",
    idempotencyKey: "",
    timestamp: "2026-08-08T12:00:01.000Z",
    nonce: "sLGys7S1tre4ubq7vL2-vw",
    bodySha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
  });
  assert.equal(
    client.sign(exactQuery),
    "ed25519:oRQeRdEF__K9BKpReCTH-bXltZqkt75bENyZlyP3vxl0ezB-LT5uPlBiGifjkcQhh_LtED1vMt4U97Bie2OTCQ"
  );
});

test("App rejects every published signing-vector negative mutation", () => {
  const signature = "ed25519:eSRABA-xNYsXg9uSNDFtRvRt4E9AN9gk64FzwwMRf2TjyFGeqhhVbYYSiXoHveFPp60yu6LxSoYGlCPG5OgPAQ";
  const original = registerFields();
  const mutations = [
    { ...original, bodySha256: sha256Base64Url(`${rawRegisterBody} `) },
    { ...original, exactPathAndQuery: "/v1/identity/adopt" },
    { ...original, exactPathAndQuery: "/v1/identity/register?a=1&b=2" },
    { ...original, timestamp: "2026-08-08T12:00:00.001Z" },
    { ...original, nonce: "sLGys7S1tre4ubq7vL2-vw" },
    { ...original, principalId: "ci_AAAAAAAAAAAAAAAAAAAAAA" }
  ];
  for (const mutation of mutations) {
    assert.equal(
      verifyTetiNetworkSignature(client.publicKey, createCanonicalTetiNetworkRequest(mutation), signature),
      false
    );
  }
});

function registerFields() {
  return {
    method: "POST",
    exactPathAndQuery: "/v1/identity/register",
    protocolVersion: 1,
    clientRequestId: "55555555-5555-4555-8555-555555555555",
    principalId: "sha256:b8w41DubDjHZyh7OPVjANDcwae-4TmkDPdotNu4JdWI",
    idempotencyKey: "vector-register-0001",
    timestamp: "2026-08-08T12:00:00.000Z",
    nonce: "oKGio6SlpqeoqaqrrK2urw",
    bodySha256: "raeKCbIIkbnKWvbvElTIYFfx3xrZ210hrHEfj0gt4bQ"
  };
}
