import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://teti-registry.seep2026.workers.dev/release-policy";

export async function verifyReleasePolicy({
  endpoint = DEFAULT_ENDPOINT,
  expectedMinimumVersion,
  expectedPolicyVersion,
  fetchImpl = fetch
}) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("Production Release Policy verification requires HTTPS.");
  }

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true || !isRecord(body.data)) {
    throw new Error(`Release Policy verification failed with HTTP ${response.status}.`);
  }

  const policy = body.data;
  if (policy.schemaVersion !== 1 || policy.channel !== "beta") {
    throw new Error("Release Policy schema or channel is unexpected.");
  }
  if (policy.policyVersion !== expectedPolicyVersion) {
    throw new Error(`Expected policyVersion ${expectedPolicyVersion}, received ${policy.policyVersion}.`);
  }
  if (policy.minimumSupportedVersion !== expectedMinimumVersion) {
    throw new Error(
      `Expected minimumSupportedVersion ${expectedMinimumVersion}, received ${policy.minimumSupportedVersion}.`
    );
  }
  if (typeof policy.effectiveAt !== "string" || !Number.isFinite(Date.parse(policy.effectiveAt))) {
    throw new Error("Release Policy effectiveAt is invalid.");
  }
  if (!/\bmax-age=\d+\b/.test(response.headers.get("cache-control") ?? "")) {
    throw new Error("Release Policy cache-control header is missing max-age.");
  }
  if (response.headers.get("access-control-allow-origin") !== "*") {
    throw new Error("Release Policy CORS header is missing.");
  }

  return policy;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const endpoint = process.argv[2] ?? DEFAULT_ENDPOINT;
  const expectedMinimumVersion = process.argv[3];
  const expectedPolicyVersion = Number(process.argv[4]);
  if (!expectedMinimumVersion || !Number.isSafeInteger(expectedPolicyVersion)) {
    throw new Error(
      "Usage: node scripts/verify-release-policy.mjs <https-url> <minimum-version> <policy-version>"
    );
  }
  const policy = await verifyReleasePolicy({
    endpoint,
    expectedMinimumVersion,
    expectedPolicyVersion
  });
  console.log(JSON.stringify({ verified: true, endpoint, policy }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
