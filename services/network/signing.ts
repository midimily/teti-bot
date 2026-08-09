import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";
import type {
  TetiNetworkEd25519PrivateSeed,
  TetiNetworkEd25519PublicKey,
  TetiNetworkEd25519Signature,
  TetiNetworkSigningKey
} from "./types.ts";

const PUBLIC_KEY_PATTERN = /^ed25519:[A-Za-z0-9_-]{43}$/;
const PRIVATE_SEED_PATTERN = /^ed25519-seed:[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9_-]{86}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,43}$/;

export interface TetiNetworkStoredSigningKey {
  publicKey: TetiNetworkEd25519PublicKey;
  privateSeed: TetiNetworkEd25519PrivateSeed;
}

export interface TetiNetworkCanonicalRequestFields {
  method: string;
  exactPathAndQuery: string;
  protocolVersion: number;
  clientRequestId: string;
  principalId: string;
  idempotencyKey: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}

export interface FirstClientAuthorizationFields {
  operation: "register" | "adopt";
  tetiId: string;
  identityPublicKey: TetiNetworkEd25519PublicKey;
  clientPublicKey: TetiNetworkEd25519PublicKey;
  platform: string;
  appVersion: string;
  deliveryAddress: string;
  transportPublicKey: string | null;
}

export interface ClientEnrollmentAuthorizationFields {
  tetiId: string;
  identityPublicKey: TetiNetworkEd25519PublicKey;
  clientPublicKey: TetiNetworkEd25519PublicKey;
  platform: string;
  appVersion: string;
}

export class Ed25519TetiNetworkSigningKey implements TetiNetworkSigningKey {
  readonly publicKey: TetiNetworkEd25519PublicKey;
  readonly privateSeed: TetiNetworkEd25519PrivateSeed;
  private readonly key: ReturnType<typeof createPrivateKey>;

  constructor(stored: TetiNetworkStoredSigningKey) {
    this.publicKey = requireEd25519PublicKey(stored.publicKey);
    this.privateSeed = requireEd25519PrivateSeed(stored.privateSeed);
    const x = this.publicKey.slice("ed25519:".length);
    const d = this.privateSeed.slice("ed25519-seed:".length);
    this.key = createPrivateKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x, d }
    });
    const probe = Buffer.from("teti-network-key-match-v1", "utf8");
    const verifier = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x }
    });
    if (!verifyBytes(null, probe, verifier, signBytes(null, probe, this.key))) {
      throw new Error("Teti Network signing key seed does not match its public key.");
    }
  }

  sign(message: string): TetiNetworkEd25519Signature {
    return requireEd25519Signature(
      `ed25519:${signBytes(null, Buffer.from(message, "utf8"), this.key).toString("base64url")}`
    );
  }
}

export function generateTetiNetworkSigningKey(): Ed25519TetiNetworkSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  if (typeof privateJwk.d !== "string") {
    throw new Error("Generated Teti Network private key does not expose an Ed25519 seed.");
  }
  return new Ed25519TetiNetworkSigningKey({
    publicKey: publicKeyString(publicKey.export({ format: "jwk" })),
    privateSeed: requireEd25519PrivateSeed(`ed25519-seed:${privateJwk.d}`)
  });
}

export function createTetiNetworkSigningKey(
  stored: TetiNetworkStoredSigningKey
): Ed25519TetiNetworkSigningKey {
  return new Ed25519TetiNetworkSigningKey(stored);
}

export function verifyTetiNetworkSignature(
  publicKey: string,
  message: string,
  signature: string
): boolean {
  try {
    const canonicalKey = requireEd25519PublicKey(publicKey);
    const canonicalSignature = requireEd25519Signature(signature);
    const key = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: canonicalKey.slice(8) }
    });
    return verifyBytes(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(canonicalSignature.slice(8), "base64url")
    );
  } catch {
    return false;
  }
}

export function createCanonicalTetiNetworkRequest(
  input: TetiNetworkCanonicalRequestFields
): string {
  return [
    "teti-network-request-v1",
    input.method.toUpperCase(),
    input.exactPathAndQuery,
    String(input.protocolVersion),
    input.clientRequestId,
    input.principalId,
    input.idempotencyKey,
    input.timestamp,
    input.nonce,
    input.bodySha256
  ].join("\n");
}

export function createFirstClientAuthorization(input: FirstClientAuthorizationFields): string {
  return [
    "teti-network-first-client-authorization-v1",
    input.operation,
    input.tetiId,
    input.identityPublicKey,
    input.clientPublicKey,
    input.platform,
    input.appVersion,
    input.deliveryAddress,
    input.transportPublicKey === null
      ? ""
      : sha256Base64Url(Buffer.from(input.transportPublicKey, "utf8"))
  ].join("\n");
}

export function createClientEnrollmentAuthorization(
  input: ClientEnrollmentAuthorizationFields
): string {
  return createEnrollmentMessage("teti-network-client-enrollment-authorization-v1", input);
}

export function createClientEnrollmentProof(
  input: ClientEnrollmentAuthorizationFields
): string {
  return createEnrollmentMessage("teti-network-client-enrollment-proof-v1", input);
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function pendingTetiNetworkKeyId(publicKey: TetiNetworkEd25519PublicKey): string {
  return `sha256:${sha256Base64Url(Buffer.from(requireEd25519PublicKey(publicKey), "utf8"))}`;
}

export function createTetiNetworkNonce(bytes = 16): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 32) {
    throw new Error("Teti Network nonce length must be 16-32 bytes.");
  }
  return requireTetiNetworkNonce(randomBytes(bytes).toString("base64url"));
}

export function requireEd25519PublicKey(value: string): TetiNetworkEd25519PublicKey {
  if (!PUBLIC_KEY_PATTERN.test(value)
    || Buffer.from(value.slice(8), "base64url").toString("base64url") !== value.slice(8)) {
    throw new Error("Teti Network Ed25519 public key is invalid.");
  }
  return value as TetiNetworkEd25519PublicKey;
}

export function requireEd25519PrivateSeed(value: string): TetiNetworkEd25519PrivateSeed {
  const encoded = value.slice("ed25519-seed:".length);
  if (!PRIVATE_SEED_PATTERN.test(value)
    || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) {
    throw new Error("Teti Network Ed25519 private seed is invalid.");
  }
  return value as TetiNetworkEd25519PrivateSeed;
}

export function requireEd25519Signature(value: string): TetiNetworkEd25519Signature {
  if (!SIGNATURE_PATTERN.test(value)
    || Buffer.from(value.slice(8), "base64url").toString("base64url") !== value.slice(8)) {
    throw new Error("Teti Network Ed25519 signature is invalid.");
  }
  return value as TetiNetworkEd25519Signature;
}

export function requireTetiNetworkNonce(value: string): string {
  if (!NONCE_PATTERN.test(value)
    || Buffer.from(value, "base64url").toString("base64url") !== value) {
    throw new Error("Teti Network nonce is invalid.");
  }
  return value;
}

function createEnrollmentMessage(
  domain: "teti-network-client-enrollment-authorization-v1" | "teti-network-client-enrollment-proof-v1",
  input: ClientEnrollmentAuthorizationFields
): string {
  return [
    domain,
    input.tetiId,
    input.identityPublicKey,
    input.clientPublicKey,
    input.platform,
    input.appVersion
  ].join("\n");
}

function publicKeyString(jwk: JsonWebKey): TetiNetworkEd25519PublicKey {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Teti Network key is not Ed25519.");
  }
  return requireEd25519PublicKey(`ed25519:${jwk.x}`);
}
